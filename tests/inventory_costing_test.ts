// ============================================================================
// INVENTORY COSTING — weighted-average, COGS posting, GL tie-out
// ============================================================================
// Exercises the REAL storage wiring (createBill / createInvoice /
// inventoryValuation) against a real Postgres, so the accounting is proven
// end-to-end, not against a mirror:
//
//   (1) Buy 10 @ $2, then 10 @ $3  → weighted-average cost = $2.50, qty = 20.
//   (2) Sell 5                     → COGS = $12.50, qty = 15, and the COGS
//                                    entry (Dr COGS / Cr Inventory) balances
//                                    to the cent as its OWN journal entry.
//   (3) Valuation report ties to the Inventory Asset GL balance (no warning).
//   (4) Negative-stock policy: overselling is blocked by default, allowed once
//       allow_negative_stock is set.
//
// Same harness as credit_note_apply_concurrency_test / stripe_clearing_account_test:
// uses $DATABASE_URL if set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/inventory_costing_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error(
        "This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`."
      );
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-inv-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "password",
      port: 55443,
      persistent: false,
      createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_inventory_test");
    process.env.DATABASE_URL =
      "postgresql://postgres:password@localhost:55443/ledgerlite_inventory_test";
    shutdown = async () => {
      await epg.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    };
  }

  try {
    const { pool, runMigrations, storage } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();

    // ------------------------------------------------------------------------
    // Fixture: one org, one user, the chart of accounts inventory needs.
    // ------------------------------------------------------------------------
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Inv Co', 'inv-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('i@i.test', 'x', 'Inv Tester')`);
    async function seedAccount(code: string, name: string, type: string, subtype: string) {
      return (await pool.query(
        `INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (1,$1,$2,$3,$4) RETURNING id`,
        [code, name, type, subtype]
      )).rows[0].id as number;
    }
    const ar        = await seedAccount("1100", "Accounts Receivable", "asset", "current_asset");
    const inventory = await seedAccount("1200", "Inventory", "asset", "current_asset");
    const ap        = await seedAccount("2000", "Accounts Payable", "liability", "current_liability");
    const sales     = await seedAccount("4000", "Sales Revenue", "income", "operating_income");
    const cogs      = await seedAccount("5000", "Cost of Goods Sold", "expense", "cogs");
    void ar;
    const vendorId = (await pool.query(`INSERT INTO vendors (org_id, name) VALUES (1,'Widget Supplier') RETURNING id`)).rows[0].id as number;
    const customerId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Widget Buyer') RETURNING id`)).rows[0].id as number;

    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    // ------------------------------------------------------------------------
    console.log("\n[setup] Create an inventory item (weighted-average costing)");
    // ------------------------------------------------------------------------
    const item = await run(() => storage.createItem({
      sku: "WIDGET-1",
      name: "Blue Widget",
      type: "inventory",
      salesAccountId: sales,
      expenseAccountId: cogs, // unused for inventory; must be an expense account
      inventoryAssetAccountId: inventory,
      cogsAccountId: cogs,
      isActive: true,
    } as any));
    check("item starts at zero on-hand / zero cost", item.quantityOnHand === 0 && item.avgCostCents === 0);

    // ------------------------------------------------------------------------
    console.log("\n[1] Buy 10 @ $2, then 10 @ $3 → weighted-average cost = $2.50");
    // ------------------------------------------------------------------------
    await run(() => storage.createBill({
      vendorId, date: "2026-02-01", dueDate: "2026-02-28", taxRate: 0,
      lines: [{ description: "Widgets batch 1", quantity: 10, rate: 2, itemId: item.id }],
    } as any));
    let after1 = await run(() => storage.getItem(item.id));
    check("after first purchase: qty = 10", after1!.quantityOnHand === 10, `got ${after1!.quantityOnHand}`);
    check("after first purchase: avg cost = 200¢ ($2.00)", after1!.avgCostCents === 200, `got ${after1!.avgCostCents}`);

    await run(() => storage.createBill({
      vendorId, date: "2026-02-05", dueDate: "2026-03-05", taxRate: 0,
      lines: [{ description: "Widgets batch 2", quantity: 10, rate: 3, itemId: item.id }],
    } as any));
    let after2 = await run(() => storage.getItem(item.id));
    check("after second purchase: qty = 20", after2!.quantityOnHand === 20, `got ${after2!.quantityOnHand}`);
    check("WEIGHTED AVERAGE: avg cost = 250¢ ($2.50)", after2!.avgCostCents === 250, `got ${after2!.avgCostCents}`);

    // ------------------------------------------------------------------------
    console.log("\n[2] Sell 5 → COGS = $12.50, qty = 15, COGS entry balances exactly");
    // ------------------------------------------------------------------------
    const invoice = await run(() => storage.createInvoice({
      customerId, date: "2026-02-10", dueDate: "2026-03-10", taxRate: 0,
      lines: [{ description: "Sold widgets", quantity: 5, rate: 10, itemId: item.id }],
    } as any));
    const afterSale = await run(() => storage.getItem(item.id));
    check("after sale: qty = 15", afterSale!.quantityOnHand === 15, `got ${afterSale!.quantityOnHand}`);
    check("after sale: avg cost unchanged at 250¢", afterSale!.avgCostCents === 250, `got ${afterSale!.avgCostCents}`);

    // The COGS entry is its OWN journal entry (source='cogs') — inspect it.
    const cogsEntry = (await pool.query(
      `SELECT id FROM journal_entries WHERE org_id = 1 AND source = 'cogs' AND source_id = $1`,
      [invoice.id]
    )).rows[0];
    check("a dedicated COGS journal entry was posted", !!cogsEntry, "no source='cogs' entry found");
    const cogsLines = (await pool.query(
      `SELECT jl.account_id, jl.debit, jl.credit FROM journal_lines jl WHERE jl.entry_id = $1 ORDER BY jl.id`,
      [cogsEntry.id]
    )).rows as Array<{ account_id: number; debit: number; credit: number }>;
    const totalDr = cogsLines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCr = cogsLines.reduce((s, l) => s + Number(l.credit), 0);
    check("COGS entry Dr = 1250¢ ($12.50)", totalDr === 1250, `got ${totalDr}`);
    check("COGS entry Cr = 1250¢ ($12.50)", totalCr === 1250, `got ${totalCr}`);
    check("COGS entry balances exactly (Dr === Cr)", totalDr === totalCr);
    const drLine = cogsLines.find((l) => Number(l.debit) > 0);
    const crLine = cogsLines.find((l) => Number(l.credit) > 0);
    check("COGS is DEBITED to the COGS account", drLine?.account_id === cogs, `got acct ${drLine?.account_id}`);
    check("Inventory Asset is CREDITED (relieved)", crLine?.account_id === inventory, `got acct ${crLine?.account_id}`);

    // Movement ledger recorded the sale.
    const saleMove = (await pool.query(
      `SELECT qty_delta, unit_cost_cents, source FROM inventory_movements WHERE org_id = 1 AND item_id = $1 AND source = 'invoice'`,
      [item.id]
    )).rows[0] as { qty_delta: number; unit_cost_cents: number; source: string };
    check("sale movement: qty_delta = -5", Number(saleMove.qty_delta) === -5, `got ${saleMove.qty_delta}`);
    check("sale movement: unit_cost = 250¢ (avg at sale)", Number(saleMove.unit_cost_cents) === 250);

    // ------------------------------------------------------------------------
    console.log("\n[3] Valuation report ties to the Inventory Asset GL balance");
    // ------------------------------------------------------------------------
    const valuation = await run(() => storage.inventoryValuation());
    check("valuation total = 15 × 250¢ = 3750¢ ($37.50)", valuation.totalValuationCents === 3750, `got ${valuation.totalValuationCents}`);
    check("Inventory Asset GL total = 3750¢ (2000 + 3000 − 1250)", valuation.glTotal === 3750, `got ${valuation.glTotal}`);
    check("valuation TIES to GL — no divergence warning", valuation.warning === undefined, valuation.warning);

    // ------------------------------------------------------------------------
    console.log("\n[4] Negative-stock policy: blocked by default, allowed when opted in");
    // ------------------------------------------------------------------------
    await expectReject(
      "selling 20 of 15 on-hand is BLOCKED (allow_negative_stock=false)",
      () => run(() => storage.createInvoice({
        customerId, date: "2026-02-15", dueDate: "2026-03-15", taxRate: 0,
        lines: [{ description: "Oversell", quantity: 20, rate: 10, itemId: item.id }],
      } as any)),
      /allow_negative_stock/
    );
    let stillFifteen = await run(() => storage.getItem(item.id));
    check("blocked oversell did NOT change stock (rolled back)", stillFifteen!.quantityOnHand === 15, `got ${stillFifteen!.quantityOnHand}`);

    await pool.query(`UPDATE organizations SET allow_negative_stock = TRUE WHERE id = 1`);
    await run(() => storage.createInvoice({
      customerId, date: "2026-02-16", dueDate: "2026-03-16", taxRate: 0,
      lines: [{ description: "Oversell allowed", quantity: 20, rate: 10, itemId: item.id }],
    } as any));
    const negative = await run(() => storage.getItem(item.id));
    check("with allow_negative_stock=true the oversell posts → qty = -5", negative!.quantityOnHand === -5, `got ${negative!.quantityOnHand}`);

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n❌ ${failures} inventory check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll inventory costing tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
