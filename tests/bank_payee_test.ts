// ============================================================================
// BANK TRANSACTION PAYEE / VENDOR TAG
// ============================================================================
// Proves, against a real Postgres:
//
//   (1) Categorizing a bank transaction with a vendorId tags the row with the
//       vendor and derives the payee name from the vendor.
//   (2) A free-text payee (no vendor) is stored as-is.
//   (3) A bank rule with payeeVendorId auto-tags the payee when it categorizes.
//   (4) The matched transaction still posts a balanced categorization JE.
//   (5) An out-of-org vendor is rejected (payee tag + rule).
//
// Run: tsx tests/bank_payee_test.ts
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
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("bank_payee");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bank Co', 'bank-co')`);
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Rival Co', 'rival-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('b@b.test', 'x', 'Bank Tester')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const expense = accts.find((a) => a.code === "6000")!;
    const acme = await run(() => storage.createVendor({ name: "Acme Utilities" } as any));
    const rivalVendorId = (await pool.query(`INSERT INTO vendors (org_id,name) VALUES (2,'Rival Vendor') RETURNING id`)).rows[0].id as number;

    const mkTxn = async (desc: string, amount: number) =>
      (await pool.query(
        `INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, source) VALUES (1,$1,'2026-03-01',$2,$3,'manual') RETURNING id`,
        [bank.id, desc, amount]
      )).rows[0].id as number;

    // ------------------------------------------------------------------------
    console.log("\n[1] Categorize with a vendorId → payee tagged from the vendor");
    // ------------------------------------------------------------------------
    const t1 = await mkTxn("ELECTRIC BILL", -8000);
    const m1 = await run(() => storage.matchBankTransaction({ bankTransactionId: t1, matchType: "categorize", categoryAccountId: expense.id, vendorId: acme.id } as any));
    check("transaction matched", m1.status === "matched");
    check("vendorId tagged", (m1 as any).vendorId === acme.id, String((m1 as any).vendorId));
    check("payee derived from vendor name", (m1 as any).payee === "Acme Utilities", String((m1 as any).payee));
    // Categorization JE balances.
    const je1 = (await pool.query(
      `SELECT COALESCE(SUM(debit),0)::bigint dr, COALESCE(SUM(credit),0)::bigint cr FROM journal_lines WHERE entry_id = $1`, [(m1 as any).entryId]
    )).rows[0];
    check("categorization JE balances (Dr = Cr = 8000)", Number(je1.dr) === 8000 && Number(je1.cr) === 8000, JSON.stringify(je1));

    // ------------------------------------------------------------------------
    console.log("\n[2] Free-text payee (no vendor)");
    // ------------------------------------------------------------------------
    const t2 = await mkTxn("COFFEE SHOP", -500);
    const m2 = await run(() => storage.matchBankTransaction({ bankTransactionId: t2, matchType: "categorize", categoryAccountId: expense.id, payee: "Corner Cafe" } as any));
    check("free-text payee stored", (m2 as any).payee === "Corner Cafe" && (m2 as any).vendorId === null, JSON.stringify({ p: (m2 as any).payee, v: (m2 as any).vendorId }));

    // ------------------------------------------------------------------------
    console.log("\n[3] A bank rule with payeeVendorId auto-tags on categorize");
    // ------------------------------------------------------------------------
    const rule = await run(() => storage.createBankRule({
      name: "Electric → Acme", actionType: "categorize", descriptionContains: "ELECTRIC",
      categoryAccountId: expense.id, payeeVendorId: acme.id, autoPost: true,
    } as any));
    check("rule stores payeeVendorId", (rule as any).payeeVendorId === acme.id);
    const t3 = await mkTxn("ELECTRIC COMPANY PMT", -9000);
    const bt3 = (await run(() => storage.getBankTransaction(t3)))!;
    await run(() => storage.applyRuleToTx(rule, bt3));
    const after3 = (await run(() => storage.getBankTransaction(t3)))!;
    check("rule matched the transaction", after3.status === "matched");
    check("rule auto-tagged the vendor payee", (after3 as any).vendorId === acme.id && (after3 as any).payee === "Acme Utilities", JSON.stringify({ v: (after3 as any).vendorId, p: (after3 as any).payee }));

    // ------------------------------------------------------------------------
    console.log("\n[4] Out-of-org vendor is rejected");
    // ------------------------------------------------------------------------
    const t4 = await mkTxn("SOMETHING", -100);
    await expectReject("categorizing with another org's vendor fails",
      () => run(() => storage.matchBankTransaction({ bankTransactionId: t4, matchType: "categorize", categoryAccountId: expense.id, vendorId: rivalVendorId } as any)),
      /Vendor #.*not found/i);
    await expectReject("a rule referencing another org's vendor is rejected",
      () => run(() => storage.createBankRule({ name: "bad", actionType: "categorize", categoryAccountId: expense.id, payeeVendorId: rivalVendorId } as any)),
      /Vendor #.*not found/i);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} bank-payee check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll bank-transaction payee/vendor tag tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
