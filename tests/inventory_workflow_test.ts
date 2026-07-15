// ============================================================================
// INVENTORY WORKFLOW (P3.9) — bundle sale relief + reorder vs open POs
// ============================================================================
// Graded invariants:
//   1. Selling a bundle explodes to its components: each component's stock is
//      relieved by (component qty × bundle qty) at its cost, and the COGS
//      journal entry balances (Dr COGS / Cr Inventory Asset).
//   2. A reorder suggestion respects open (undelivered) PO quantity: an item is
//      only suggested when on-hand PLUS on-order is at/below its reorder point.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("inventory_workflow");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Invco','invco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('i@i.test','x','Inv')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const acct = async (c: string) => (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code=$1`, [c])).rows[0].id as number;
      const income = await acct("4000"), cogs = await acct("5000"), invAsset = await acct("1200"), expense = await acct("6000");
      const custId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme') RETURNING id`)).rows[0].id as number;

      // Two inventory components with stock + average cost seeded directly.
      const mkInvItem = async (sku: string) => {
        const it = await storage.createItem({ sku, name: sku, type: "inventory", salesAccountId: income, expenseAccountId: expense, cogsAccountId: cogs, inventoryAssetAccountId: invAsset } as any);
        return it.id;
      };
      const compA = await mkInvItem("COMP-A");
      const compB = await mkInvItem("COMP-B");
      await pool.query(`UPDATE items SET quantity_on_hand=100, avg_cost_cents=400 WHERE id=$1`, [compA]); // $4.00
      await pool.query(`UPDATE items SET quantity_on_hand=100, avg_cost_cents=250 WHERE id=$1`, [compB]); // $2.50

      // A bundle (non-inventory GL) = 2×A + 3×B.
      const bundle = await storage.createItem({ sku: "BUNDLE", name: "Starter Kit", type: "noninventory", salesAccountId: income, expenseAccountId: expense, cogsAccountId: cogs } as any);
      await storage.addBundleComponent(bundle.id, compA, 2);
      await storage.addBundleComponent(bundle.id, compB, 3);

      console.log("Test: bundles cannot be nested");
      let nestBlocked = false;
      try { await storage.addBundleComponent(compA, bundle.id, 1); } catch { nestBlocked = true; }
      check("adding a bundle as a component is rejected", nestBlocked);

      console.log("Test: selling a bundle relieves each component and the COGS JE balances");
      const inv = await storage.createInvoice({
        customerId: custId, date: "2026-05-01", dueDate: "2026-06-01", taxRate: 0,
        lines: [{ description: "Starter Kit ×5", quantity: 5, rate: 100, itemId: bundle.id }],
      } as any);
      const qtyA = (await pool.query(`SELECT quantity_on_hand q FROM items WHERE id=$1`, [compA])).rows[0].q;
      const qtyB = (await pool.query(`SELECT quantity_on_hand q FROM items WHERE id=$1`, [compB])).rows[0].q;
      check("component A relieved by 2×5=10 → 90", qtyA === 90);
      check("component B relieved by 3×5=15 → 85", qtyB === 85);

      // The COGS journal entry for this invoice.
      const cogsEntry = (await pool.query(`SELECT id FROM journal_entries WHERE org_id=1 AND source='cogs' AND source_id=$1`, [inv.id])).rows[0];
      check("a COGS entry was posted for the sale", !!cogsEntry);
      const cl = (await pool.query(`SELECT COALESCE(SUM(debit),0)::bigint dr, COALESCE(SUM(credit),0)::bigint cr FROM journal_lines WHERE entry_id=$1`, [cogsEntry.id])).rows[0];
      const expectedCogs = 10 * 400 + 15 * 250; // 4000 + 3750 = 7750
      check("COGS JE balances (Dr = Cr)", Number(cl.dr) === Number(cl.cr));
      check("COGS totals the component costs ($77.50)", Number(cl.dr) === expectedCogs);
      const invAssetCredit = Number((await pool.query(`SELECT COALESCE(SUM(credit),0)::bigint c FROM journal_lines WHERE entry_id=$1 AND account_id=$2`, [cogsEntry.id, invAsset])).rows[0].c);
      check("inventory asset credited by the COGS total", invAssetCredit === expectedCogs);
      // Movements recorded per component.
      const mv = (await pool.query(`SELECT item_id, qty_delta FROM inventory_movements WHERE source='invoice' AND source_id=$1 ORDER BY item_id`, [inv.id])).rows as any[];
      check("stock movements recorded for both components", mv.length === 2 && mv.some((m) => m.item_id === compA && m.qty_delta === -10) && mv.some((m) => m.item_id === compB && m.qty_delta === -15));

      console.log("Test: reorder suggestion respects open (undelivered) PO quantity");
      const vendorId = (await pool.query(`INSERT INTO vendors (org_id, name) VALUES (1,'Supplier') RETURNING id`)).rows[0].id as number;
      const rItem = await mkInvItem("REORDER-ME");
      await pool.query(`UPDATE items SET quantity_on_hand=5, reorder_point=20, reorder_qty=50, preferred_vendor_id=$2 WHERE id=$1`, [rItem, vendorId]);

      const before = await storage.reorderSuggestions();
      check("low item is suggested when nothing is on order", before.some((s: any) => s.itemId === rItem && s.onOrder === 0));

      // Put 30 on order (open PO). Now on-hand 5 + on-order 30 = 35 > 20.
      await storage.createPurchaseOrder({ vendorId, date: "2026-05-02", lines: [{ itemId: rItem, description: "restock", quantity: 30, rate: 3 }] } as any);
      const after = await storage.reorderSuggestions();
      check("no longer suggested once an open PO covers the gap", !after.some((s: any) => s.itemId === rItem));

      // A different low item with no PO is still suggested (sanity).
      const rItem2 = await mkInvItem("ALSO-LOW");
      await pool.query(`UPDATE items SET quantity_on_hand=0, reorder_point=10, reorder_qty=25 WHERE id=$1`, [rItem2]);
      check("other low item without a PO is still suggested", (await storage.reorderSuggestions()).some((s: any) => s.itemId === rItem2));
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — bundle sale relieves components & balances; reorder respects open POs");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
