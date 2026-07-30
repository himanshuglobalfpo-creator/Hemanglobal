// ============================================================================
// ATTACHMENTS — broadened to bills, payments, journal entries, bank transactions
// ============================================================================
// Proves, against a real Postgres, that receipts/documents can be attached to
// every supported entity type with the SAME org-scoped access control:
//
//   (1) attach + list + get + delete works for bill, payment, journal_entry,
//       and bank_transaction.
//   (2) "payment" only matches an actual payment journal entry (not a manual JE).
//   (3) Unsupported entity types are rejected.
//   (4) Access control is org-scoped: another org can neither attach to nor
//       read/delete this org's attachments.
//
// (The upload/download blob path — server/files.ts driver — is the same code
// for every entity type, so it is exercised identically; this test covers the
// metadata + access-control layer that gates it.)
//
// Run: tsx tests/attachments_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try { await fn(); failures++; console.error(`  ✗ ${label} — expected an error`); }
  catch (e: any) { check(label, pattern.test(String(e?.message)), `got: ${e?.message}`); }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("attachments");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Attach Co', 'attach-co')`);
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Other Co', 'other-attach-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('a@a.test', 'x', 'Attach Tester')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);
    const runOrg2 = <T>(fn: () => Promise<T>) => withOrg({ orgId: 2, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const expense = accts.find((a) => a.code === "6000")!;
    const revenue = accts.find((a) => a.code === "4000")!;

    // ---- Build one of each attachable entity in org 1 ----
    const vendorId = (await pool.query(`INSERT INTO vendors (org_id,name) VALUES (1,'V') RETURNING id`)).rows[0].id as number;
    const bill = await run(() => storage.createBill({ vendorId, date: "2026-03-01", dueDate: "2026-03-31", taxRate: 0,
      lines: [{ description: "Supplies", quantity: 1, rate: 100, expenseAccountId: expense.id }] } as any));
    await run(() => storage.payBill({ billId: bill.id, date: "2026-03-05", amount: 100, bankAccountId: bank.id } as any));
    const paymentJeId = (await pool.query(`SELECT id FROM journal_entries WHERE org_id=1 AND source='payment' AND reference=$1`, [bill.number])).rows[0].id as number;
    const je = await run(() => storage.postJournalEntry({ date: "2026-03-06", memo: "Manual",
      lines: [{ accountId: bank.id, debit: 1000, credit: 0 }, { accountId: revenue.id, debit: 0, credit: 1000 }] } as any));
    const manualJeId = je.entry.id;
    const bankTxnId = (await pool.query(
      `INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, source) VALUES (1,$1,'2026-03-07','ACH deposit',5000,'manual') RETURNING id`,
      [bank.id]
    )).rows[0].id as number;

    const entities: Array<{ type: string; id: number }> = [
      { type: "bill", id: bill.id },
      { type: "payment", id: paymentJeId },
      { type: "journal_entry", id: manualJeId },
      { type: "bank_transaction", id: bankTxnId },
    ];

    // ------------------------------------------------------------------------
    console.log("\n[1] Attach → list → get → delete for each entity type");
    // ------------------------------------------------------------------------
    for (const e of entities) {
      await run(() => storage.assertAttachmentEntity(e.type, e.id)); // must not throw
      const { id: attId } = await run(() => storage.createAttachment({
        entityType: e.type, entityId: e.id, filename: `receipt-${e.type}.pdf`,
        mimeType: "application/pdf", sizeBytes: 1234, storageKey: `1/key-${e.type}`,
      }));
      const list = await run(() => storage.listAttachments(e.type, e.id));
      check(`${e.type}: attachment listed`, list.length === 1 && list[0].id === attId, JSON.stringify(list));
      const got = await run(() => storage.getAttachment(attId));
      check(`${e.type}: attachment fetched with metadata`, got?.entityType === e.type && got?.entityId === e.id && got?.filename === `receipt-${e.type}.pdf`, JSON.stringify(got));
      const del = await run(() => storage.deleteAttachment(attId));
      check(`${e.type}: attachment deleted (storageKey returned for blob cleanup)`, del.storageKey === `1/key-${e.type}`);
      const gone = await run(() => storage.getAttachment(attId));
      check(`${e.type}: attachment gone after delete`, gone === undefined);
    }

    // ------------------------------------------------------------------------
    console.log("\n[2] 'payment' only matches a real payment JE; unknown types rejected");
    // ------------------------------------------------------------------------
    await expectReject("attaching a 'payment' to a MANUAL journal entry is rejected",
      () => run(() => storage.assertAttachmentEntity("payment", manualJeId)), /payment not found/i);
    await expectReject("unsupported entity type is rejected",
      () => run(() => storage.assertAttachmentEntity("customer", 1)), /Unsupported entity type/i);

    // ------------------------------------------------------------------------
    console.log("\n[3] Access control is org-scoped");
    // ------------------------------------------------------------------------
    // Make a real attachment in org 1, then try to reach it from org 2.
    const { id: org1AttId } = await run(() => storage.createAttachment({
      entityType: "bill", entityId: bill.id, filename: "private.pdf", mimeType: "application/pdf", sizeBytes: 10, storageKey: "1/private",
    }));
    await expectReject("org 2 cannot attach to org 1's bill",
      () => runOrg2(() => storage.assertAttachmentEntity("bill", bill.id)), /bill not found/i);
    const crossGet = await runOrg2(() => storage.getAttachment(org1AttId));
    check("org 2 cannot fetch org 1's attachment (org-scoped)", crossGet === undefined);
    await expectReject("org 2 cannot delete org 1's attachment",
      () => runOrg2(() => storage.deleteAttachment(org1AttId)), /not found/i);
    // Owner can still read it.
    check("org 1 still sees its own attachment", (await run(() => storage.getAttachment(org1AttId)))?.filename === "private.pdf");

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} attachment check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll broadened-attachment tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
