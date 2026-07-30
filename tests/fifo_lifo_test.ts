// ============================================================================
// FIFO / LIFO / AVERAGE INVENTORY COSTING
// ============================================================================
// Classic worked example, run per costing method against a real Postgres:
//
//   Buy 10 @ $2 (Jan), then 10 @ $3 (Feb)  → 20 units, $50 inventory.
//   Sell 15 units (Mar). Expected COGS / remaining inventory:
//     FIFO    : 10×$2 + 5×$3 = $35 COGS,  5×$3 = $15 left
//     LIFO    : 10×$3 + 5×$2 = $40 COGS,  5×$2 = $10 left
//     AVERAGE : 15×$2.50     = $37.50 COGS, 5×$2.50 = $12.50 left
//
// For each method we assert: the COGS journal entry, the inventory-valuation
// report, AND that the report ties to the Inventory Asset GL balance (no
// warning). Also unit-tests the pure relieveLayers engine.
//
// Run: tsx tests/fifo_lifo_test.ts
// ============================================================================

import { relieveLayers, layerValuation } from "../shared/inventory";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  // ------------------------------------------------------------------------
  console.log("[0] Pure relieveLayers engine (integer cents, exact)");
  // ------------------------------------------------------------------------
  {
    // FIFO order: oldest first.
    const fifo = [{ qtyRemaining: 10, costRemainingCents: 2000 }, { qtyRemaining: 10, costRemainingCents: 3000 }];
    const cogsF = relieveLayers(fifo, 15, 0);
    check("FIFO sell 15 → COGS 3500¢", cogsF === 3500, String(cogsF));
    check("FIFO leaves 5 units / 1500¢", fifo[1].qtyRemaining === 5 && layerValuation(fifo) === 1500, JSON.stringify(fifo));
    // LIFO order: newest first.
    const lifo = [{ qtyRemaining: 10, costRemainingCents: 3000 }, { qtyRemaining: 10, costRemainingCents: 2000 }];
    const cogsL = relieveLayers(lifo, 15, 0);
    check("LIFO sell 15 → COGS 4000¢", cogsL === 4000, String(cogsL));
    check("LIFO leaves 5 units / 1000¢", layerValuation(lifo) === 1000, JSON.stringify(lifo));
    // Partial-layer rounding stays exact (7 units of a 3-unit-per... uneven lot).
    const uneven = [{ qtyRemaining: 3, costRemainingCents: 1000 }]; // $10 for 3 → 333.33/unit
    const c = relieveLayers(uneven, 2, 0);
    check("uneven partial take rounds (2 of 3 @ 1000¢ → 667¢, 333¢ left)", c === 667 && uneven[0].costRemainingCents === 333, `${c}/${uneven[0].costRemainingCents}`);
  }

  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("fifo_lifo");
  try {
    const methods: Array<{ orgId: number; method: string; slug: string; expectCogs: number; expectLeft: number }> = [
      { orgId: 1, method: "fifo", slug: "fifo-co", expectCogs: 3500, expectLeft: 1500 },
      { orgId: 2, method: "lifo", slug: "lifo-co", expectCogs: 4000, expectLeft: 1000 },
      { orgId: 3, method: "average", slug: "avg-co", expectCogs: 3750, expectLeft: 1250 },
    ];
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('c@c.test', 'x', 'Cost Tester')`);
    for (const m of methods) {
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1, $2)`, [m.method + " Co", m.slug]);
      await seedOrgDefaults(m.orgId);
      // Set the costing method BEFORE any inventory activity.
      await pool.query(`UPDATE organizations SET costing_method = $1 WHERE id = $2`, [m.method, m.orgId]);
    }

    for (const m of methods) {
      console.log(`\n[${m.method.toUpperCase()}] buy 10@$2 + 10@$3, sell 15`);
      const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: m.orgId, userId: 1 }, fn);
      const accts = await run(() => storage.listAccounts());
      const invAsset = accts.find((a) => a.code === "1200")!; // Inventory
      const cogsAcct = accts.find((a) => a.code === "5000")!;  // COGS
      const sales = accts.find((a) => a.code === "4000")!;
      const vendorId = (await pool.query(`INSERT INTO vendors (org_id,name) VALUES ($1,'Supplier') RETURNING id`, [m.orgId])).rows[0].id as number;
      const item = await run(() => storage.createItem({
        sku: "WIDGET", name: "Widget", type: "inventory",
        salesAccountId: sales.id, expenseAccountId: cogsAcct.id,
        inventoryAssetAccountId: invAsset.id, cogsAccountId: cogsAcct.id, isActive: true,
      } as any));

      // Purchases (two lots at different costs).
      await run(() => storage.createBill({ vendorId, date: "2026-01-01", dueDate: "2026-01-31", taxRate: 0,
        lines: [{ description: "Lot 1", quantity: 10, rate: 2, itemId: item.id }] } as any));
      await run(() => storage.createBill({ vendorId, date: "2026-02-01", dueDate: "2026-02-28", taxRate: 0,
        lines: [{ description: "Lot 2", quantity: 10, rate: 3, itemId: item.id }] } as any));

      const afterBuy = await run(() => storage.getItem(item.id));
      check(`${m.method}: 20 units on hand after purchases`, afterBuy!.quantityOnHand === 20, String(afterBuy!.quantityOnHand));
      const invGlAfterBuy = (await run(() => storage.accountBalances("2026-02-01"))).get(invAsset.id)!.balance;
      check(`${m.method}: inventory GL = $50 after purchases`, invGlAfterBuy === 5000, String(invGlAfterBuy));

      // Sale of 15 units.
      const cust = (await pool.query(`INSERT INTO customers (org_id,name) VALUES ($1,'Buyer') RETURNING id`, [m.orgId])).rows[0].id as number;
      const inv = await run(() => storage.createInvoice({ customerId: cust, date: "2026-03-01", dueDate: "2026-03-31", taxRate: 0,
        lines: [{ description: "Sale", quantity: 15, rate: 10, itemId: item.id }] } as any));

      // COGS journal entry (Dr COGS / Cr Inventory) — total debit = COGS.
      const cogs = (await pool.query(
        `SELECT COALESCE(SUM(jl.debit),0)::bigint AS c FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = $1 AND je.source = 'cogs' AND je.reference = $2 AND jl.account_id = $3`,
        [m.orgId, inv.number, cogsAcct.id]
      )).rows[0].c as number;
      check(`${m.method}: COGS = ${m.expectCogs}¢`, Number(cogs) === m.expectCogs, String(cogs));

      // Remaining inventory: valuation report + GL tie-out.
      const val = await run(() => storage.inventoryValuation("2026-03-01"));
      check(`${m.method}: valuation = ${m.expectLeft}¢`, val.totalValuationCents === m.expectLeft, String(val.totalValuationCents));
      check(`${m.method}: valuation ties to GL (no warning)`, !val.warning, val.warning);
      check(`${m.method}: valuation report exposes the costing method`, (val as any).costingMethod === m.method, String((val as any).costingMethod));
      // Cost layers surfaced for the item UI (empty for average).
      const cl = await run(() => storage.listItemCostLayers(item.id));
      check(`${m.method}: cost-layers endpoint reports the method`, cl.costingMethod === m.method);
      if (m.method === "average") {
        check(`${m.method}: no cost layers under average`, cl.layers.length === 0, String(cl.layers.length));
      } else {
        check(`${m.method}: one open layer, 5 units, ${m.expectLeft}¢ remaining`,
          cl.layers.length === 1 && cl.layers[0].qtyRemaining === 5 && cl.layers[0].costRemainingCents === m.expectLeft, JSON.stringify(cl.layers));
      }
      const invGlAfterSale = (await run(() => storage.accountBalances("2026-03-01"))).get(invAsset.id)!.balance;
      check(`${m.method}: inventory GL = ${m.expectLeft}¢ after sale`, invGlAfterSale === m.expectLeft, String(invGlAfterSale));
      const finalItem = await run(() => storage.getItem(item.id));
      check(`${m.method}: 5 units left on hand`, finalItem!.quantityOnHand === 5, String(finalItem!.quantityOnHand));
    }

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} FIFO/LIFO check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll FIFO/LIFO/average costing tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
