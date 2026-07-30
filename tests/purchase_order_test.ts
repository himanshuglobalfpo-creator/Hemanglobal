// ============================================================================
// PURCHASE ORDERS → BILL — receipt flow, over-receipt guard, GL correctness
// ============================================================================
// Exercises the REAL storage wiring against a real Postgres:
//
//   (1) A PO posts NO journal entry (it is a commitment, not a GL event).
//   (2) Partial receive creates a bill for ONLY the received lines and moves the
//       PO to 'partial'; the generated bill's journal entry balances exactly.
//   (3) Over-receipt (received > ordered) is rejected and changes nothing.
//   (4) Full receive of the remainder closes the PO to 'received'.
//   (5) Receiving an inventory-item line feeds an inventory movement (MF-1).
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/purchase_order_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    failures++;
    console.error(`  ✗ ${label} — expected an error, none thrown`);
  } catch (e: any) {
    check(label, pattern.test(String(e?.message)), `got: ${e?.message}`);
  }
}

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("purchase_order");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('PO Co', 'po-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('p@p.test', 'x', 'PO Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const jeBalance = async (billId: number) => {
      const rows = (await pool.query(
        `SELECT jl.debit, jl.credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = 1 AND je.source = 'bill' AND je.source_id = $1`, [billId]
      )).rows as Array<{ debit: number; credit: number }>;
      const dr = rows.reduce((s, r) => s + Number(r.debit), 0);
      const cr = rows.reduce((s, r) => s + Number(r.credit), 0);
      return { dr, cr, lineCount: rows.length };
    };

    // ------------------------------------------------------------------------
    console.log("\n[setup] vendor, inventory item, expense account");
    // ------------------------------------------------------------------------
    const accts = await run(() => storage.listAccounts());
    const inventoryAcct = accts.find((a) => a.code === "1200")!; // Inventory (asset)
    const cogsAcct = accts.find((a) => a.code === "5000")!;      // COGS (expense)
    const salesAcct = accts.find((a) => a.code === "4000")!;     // Sales (income)
    const rentAcct = accts.find((a) => a.code === "6000")!;      // Rent (expense) — the service line
    const vendorId = (await pool.query(`INSERT INTO vendors (org_id, name) VALUES (1,'Parts Supplier') RETURNING id`)).rows[0].id as number;
    const item = await run(() => storage.createItem({
      sku: "PART-1", name: "Steel Bolt", type: "inventory",
      salesAccountId: salesAcct.id, expenseAccountId: cogsAcct.id,
      inventoryAssetAccountId: inventoryAcct.id, cogsAccountId: cogsAcct.id, isActive: true,
    } as any));

    // ------------------------------------------------------------------------
    console.log("\n[1] Create a PO — 10 bolts @ $2 (inventory) + 5 units service @ $3 — NO journal entry");
    // ------------------------------------------------------------------------
    const po = await run(() => storage.createPurchaseOrder({
      vendorId, date: "2026-03-01", expectedDate: "2026-03-10", notes: "Q1 restock",
      lines: [
        { description: "Steel bolts", quantity: 10, rate: 2, itemId: item.id },
        { description: "Freight service", quantity: 5, rate: 3, expenseAccountId: rentAcct.id },
      ],
    } as any));
    check("PO number is PO-0001", po.number === "PO-0001", po.number);
    check("PO status is 'open'", po.status === "open", po.status);
    const jeCountAfterPo = (await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id = 1`)).rows[0].c as number;
    check("PO posted ZERO journal entries", jeCountAfterPo === 0, `got ${jeCountAfterPo}`);
    const full = (await run(() => storage.getPurchaseOrder(po.id)))!;
    const boltLine = full.lines.find((l) => l.itemId === item.id)!;
    const freightLine = full.lines.find((l) => l.expenseAccountId === rentAcct.id)!;
    check("bolt line amount_cents = 2000 (10 × $2)", boltLine.amountCents === 2000, String(boltLine.amountCents));

    // ------------------------------------------------------------------------
    console.log("\n[2] Partial receive — 4 bolts only → bill for the received portion, PO 'partial'");
    // ------------------------------------------------------------------------
    const rec1 = await run(() => storage.receivePurchaseOrder(po.id, {
      date: "2026-03-05", lines: [{ poLineId: boltLine.id, quantity: 4 }],
    } as any));
    check("PO status is now 'partial'", rec1.purchaseOrder.status === "partial", rec1.purchaseOrder.status);
    check("generated bill is linked to the PO", rec1.bill.poId === po.id, String(rec1.bill.poId));
    const bal1 = await jeBalance(rec1.bill.id);
    check("bill has ONE line (only the received bolt line)", bal1.lineCount === 2, `${bal1.lineCount} JE lines (Dr inventory + Cr A/P)`);
    check("bill total = $8.00 (4 × $2)", rec1.bill.total === 800, String(rec1.bill.total));
    check("bill JE balances exactly (Dr = Cr = 800)", bal1.dr === 800 && bal1.cr === 800, `dr ${bal1.dr} cr ${bal1.cr}`);
    const afterRec1 = (await run(() => storage.getPurchaseOrder(po.id)))!;
    check("bolt line qty_received = 4", afterRec1.lines.find((l) => l.id === boltLine.id)!.qtyReceived === 4);
    const itemAfter1 = await run(() => storage.getItem(item.id));
    check("MF-1 inventory movement fed: item on-hand = 4", itemAfter1!.quantityOnHand === 4, String(itemAfter1!.quantityOnHand));
    check("item avg cost = 200¢ ($2.00)", itemAfter1!.avgCostCents === 200);

    // ------------------------------------------------------------------------
    console.log("\n[3] Over-receipt is rejected (6 bolts remain, ask for 100)");
    // ------------------------------------------------------------------------
    await expectReject(
      "receiving 100 bolts when only 6 remain is blocked",
      () => run(() => storage.receivePurchaseOrder(po.id, { date: "2026-03-06", lines: [{ poLineId: boltLine.id, quantity: 100 }] } as any)),
      /Over-receipt/
    );
    const afterReject = (await run(() => storage.getPurchaseOrder(po.id)))!;
    check("rejected over-receipt changed nothing (still 4 received, 'partial')",
      afterReject.status === "partial" && afterReject.lines.find((l) => l.id === boltLine.id)!.qtyReceived === 4);

    // ------------------------------------------------------------------------
    console.log("\n[4] Full receive of the remainder → PO 'received'; bill JE balances");
    // ------------------------------------------------------------------------
    const rec2 = await run(() => storage.receivePurchaseOrder(po.id, {
      date: "2026-03-08",
      lines: [
        { poLineId: boltLine.id, quantity: 6 },   // remaining bolts
        { poLineId: freightLine.id, quantity: 5 }, // the service line
      ],
    } as any));
    check("PO status is now 'received'", rec2.purchaseOrder.status === "received", rec2.purchaseOrder.status);
    check("second bill total = $27.00 (6 × $2 + 5 × $3)", rec2.bill.total === 2700, String(rec2.bill.total));
    const bal2 = await jeBalance(rec2.bill.id);
    check("second bill JE balances exactly (Dr = Cr = 2700)", bal2.dr === 2700 && bal2.cr === 2700, `dr ${bal2.dr} cr ${bal2.cr}`);
    const finalPo = (await run(() => storage.getPurchaseOrder(po.id)))!;
    check("bolt line fully received (10/10)", finalPo.lines.find((l) => l.id === boltLine.id)!.qtyReceived === 10);
    check("freight line fully received (5/5)", finalPo.lines.find((l) => l.id === freightLine.id)!.qtyReceived === 5);
    const itemFinal = await run(() => storage.getItem(item.id));
    check("item on-hand = 10 after both receipts", itemFinal!.quantityOnHand === 10, String(itemFinal!.quantityOnHand));

    // A fully-received PO cannot receive again.
    await expectReject(
      "cannot receive against a fully-received PO line",
      () => run(() => storage.receivePurchaseOrder(po.id, { date: "2026-03-09", lines: [{ poLineId: boltLine.id, quantity: 1 }] } as any)),
      /Over-receipt/
    );

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} purchase-order check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll purchase-order tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
