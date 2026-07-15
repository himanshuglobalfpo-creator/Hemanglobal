// ============================================================================
// PRICE RULES (P3.4) — specificity ordering, date boundaries, FX (doc currency)
// ============================================================================
// The resolver picks the best applicable rule (highest priority, then most
// specific) and adjusts the base rate IN THE DOCUMENT CURRENCY — it never
// converts FX and never writes back to items. These tests pin:
//   1. Specificity: item-list ≻ category ≻ all; customer-list adds specificity;
//      priority overrides specificity.
//   2. Date-range boundaries are inclusive; open-ended bounds always match.
//   3. FX: a rule adjusts the document-currency rate as-is (no conversion).
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("price_rules");
  try {
    // Three isolated orgs keep each rule-set independent.
    for (const [name, slug] of [["Spec Co", "spec"], ["Date Co", "date"], ["Fx Co", "fx"]] as const)
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2)`, [name, slug]);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('p@p.test','x','Pricer')`);
    for (const o of [1, 2, 3]) await seedOrgDefaults(o);

    // Insert an item (with category) into an org; returns its id.
    const addItem = async (orgId: number, sku: string, category: string | null) => {
      const acct = (await pool.query(`SELECT id FROM accounts WHERE org_id=$1 LIMIT 1`, [orgId])).rows[0].id;
      return (await pool.query(
        `INSERT INTO items (org_id, sku, name, type, category, sales_account_id, expense_account_id, cogs_account_id)
         VALUES ($1,$2,$2,'service',$3,$4,$4,$4) RETURNING id`,
        [orgId, sku, category, acct]
      )).rows[0].id as number;
    };
    const addCustomer = async (orgId: number, nm: string) => (await pool.query(`INSERT INTO customers (org_id, name) VALUES ($1,$2) RETURNING id`, [orgId, nm])).rows[0].id as number;

    // ------------------------------------------------------------------
    // Org 1 — specificity + priority
    // ------------------------------------------------------------------
    console.log("Test: specificity ordering + priority override");
    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const item1 = await addItem(1, "ITEM1", "widgets");
      const item2 = await addItem(1, "ITEM2", "gadgets");
      const cust1 = await addCustomer(1, "Acme");
      const cust2 = await addCustomer(1, "Globex");

      const mk = (o: any) => storage.createPriceRule({ adjustType: "percent", direction: "discount", customerScope: "all", itemScope: "all", priority: 0, isActive: true, itemIds: [], customerIds: [], ...o });
      await mk({ name: "All 10%", percent: 10 });
      await mk({ name: "Item 20%", itemScope: "list", itemIds: [item1], percent: 20 });
      await mk({ name: "Cust 15%", customerScope: "list", customerIds: [cust1], percent: 15 });
      await mk({ name: "Both 25%", itemScope: "list", itemIds: [item1], customerScope: "list", customerIds: [cust1], percent: 25 });

      const r11 = await storage.resolvePrice({ itemId: item1, customerId: cust1, baseRate: 100, date: "2026-06-01" });
      check("item1+cust1 → most specific (Both 25%) → 75", r11.ruleName === "Both 25%" && near(r11.resolvedRate, 75));
      const r12 = await storage.resolvePrice({ itemId: item1, customerId: cust2, baseRate: 100, date: "2026-06-01" });
      check("item1+cust2 → Item 20% → 80", r12.ruleName === "Item 20%" && near(r12.resolvedRate, 80));
      const r21 = await storage.resolvePrice({ itemId: item2, customerId: cust1, baseRate: 100, date: "2026-06-01" });
      check("item2+cust1 → Cust 15% → 85", r21.ruleName === "Cust 15%" && near(r21.resolvedRate, 85));
      const r22 = await storage.resolvePrice({ itemId: item2, customerId: cust2, baseRate: 100, date: "2026-06-01" });
      check("item2+cust2 → All 10% → 90", r22.ruleName === "All 10%" && near(r22.resolvedRate, 90));

      // Category scope beats 'all' but loses to item-list.
      await mk({ name: "Cat widgets 30%", itemScope: "category", category: "widgets", percent: 30 });
      const rcat = await storage.resolvePrice({ itemId: item2, customerId: cust2, baseRate: 100, date: "2026-06-01" });
      check("item2(gadgets) ignores widgets category rule → still All 10%", rcat.ruleName === "All 10%");

      // Priority overrides specificity.
      await mk({ name: "Priority 5%", priority: 100, percent: 5 });
      const rprio = await storage.resolvePrice({ itemId: item1, customerId: cust1, baseRate: 100, date: "2026-06-01" });
      check("highest priority wins over specificity → Priority 5% → 95", rprio.ruleName === "Priority 5%" && near(rprio.resolvedRate, 95));
    });

    // ------------------------------------------------------------------
    // Org 2 — date-range boundaries (inclusive)
    // ------------------------------------------------------------------
    console.log("Test: date-range boundaries are inclusive");
    await withOrg({ orgId: 2, userId: 1 }, async () => {
      const item = await addItem(2, "D1", null);
      await storage.createPriceRule({ name: "March 50%", adjustType: "percent", direction: "discount", percent: 50, itemScope: "all", customerScope: "all", startDate: "2026-03-01", endDate: "2026-03-31", priority: 0, isActive: true, itemIds: [], customerIds: [] });
      const at = (d: string) => storage.resolvePrice({ itemId: item, baseRate: 100, date: d });
      check("day before start → no rule", (await at("2026-02-28")).applied === false);
      check("start date (inclusive) → applied → 50", near((await at("2026-03-01")).resolvedRate, 50));
      check("mid-window → applied → 50", near((await at("2026-03-15")).resolvedRate, 50));
      check("end date (inclusive) → applied → 50", near((await at("2026-03-31")).resolvedRate, 50));
      check("day after end → no rule", (await at("2026-04-01")).applied === false);

      await storage.createPriceRule({ name: "Open 10%", adjustType: "percent", direction: "discount", percent: 10, itemScope: "all", customerScope: "all", startDate: null, endDate: null, priority: 5, isActive: true, itemIds: [], customerIds: [] });
      check("open-ended rule applies outside March", near((await at("2026-12-25")).resolvedRate, 90));
    });

    // ------------------------------------------------------------------
    // Org 3 — FX (document currency), fixed adjust, floor at zero
    // ------------------------------------------------------------------
    console.log("Test: rule applies in document currency (no FX conversion)");
    await withOrg({ orgId: 3, userId: 1 }, async () => {
      const item = await addItem(3, "F1", null);
      // Fixed €10 discount.
      await storage.createPriceRule({ name: "EUR -10", adjustType: "fixed", direction: "discount", amountCents: 1000, itemScope: "all", customerScope: "all", priority: 0, isActive: true, itemIds: [], customerIds: [] });
      const eur = await storage.resolvePrice({ itemId: item, baseRate: 100, currency: "EUR", date: "2026-06-01" });
      check("fixed €10 off a €100 rate → €90 (same currency, no conversion)", near(eur.resolvedRate, 90) && eur.currency === "EUR");
      const usd = await storage.resolvePrice({ itemId: item, baseRate: 100, currency: "USD", date: "2026-06-01" });
      check("same rule on a $100 rate → $90 (currency-agnostic amount)", near(usd.resolvedRate, 90) && usd.currency === "USD");
      check("fixed discount floors at zero (never negative)", near((await storage.resolvePrice({ itemId: item, baseRate: 5, currency: "EUR", date: "2026-06-01" })).resolvedRate, 0));

      // Surcharge direction (fixed + percent).
      await storage.createPriceRule({ name: "Rush +25%", adjustType: "percent", direction: "surcharge", percent: 25, itemScope: "all", customerScope: "all", priority: 100, isActive: true, itemIds: [], customerIds: [] });
      const rush = await storage.resolvePrice({ itemId: item, baseRate: 100, currency: "EUR", date: "2026-06-01" });
      check("surcharge +25% on €100 → €125", near(rush.resolvedRate, 125) && rush.currency === "EUR");
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — best-rule specificity/priority, inclusive dates, document-currency adjustment");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
