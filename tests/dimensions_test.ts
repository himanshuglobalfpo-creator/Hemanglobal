// ============================================================================
// CLASS / LOCATION (DIMENSIONAL) TRACKING
// ============================================================================
// Proves, against a real Postgres:
//
//   (1) Manual journal lines carry class/location, and P&L + Balance Sheet
//       filter by them (a fully-dimensioned JE keeps the filtered BS balanced).
//   (2) Invoice and bill line dimensions PROPAGATE onto the posted GL lines.
//   (3) A dimension-filtered P&L reflects only the matching lines.
//   (4) Referencing an unknown class/location id is rejected.
//
// Run: tsx tests/dimensions_test.ts
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
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("dimensions");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Dim Co', 'dim-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('d@d.test', 'x', 'Dim Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const revenue = accts.find((a) => a.code === "4000")!;
    const expense = accts.find((a) => a.code === "6000")!;

    // Dimensions
    const east = await run(() => storage.createClass({ name: "East" } as any));
    const west = await run(() => storage.createClass({ name: "West" } as any));
    const nyc = await run(() => storage.createLocation({ name: "NYC" } as any));
    const la = await run(() => storage.createLocation({ name: "LA" } as any));
    check("classes + locations created", !!east.id && !!west.id && !!nyc.id && !!la.id);

    // ------------------------------------------------------------------------
    console.log("\n[1] Fully-dimensioned manual JEs → filtered P&L + balanced filtered BS");
    // ------------------------------------------------------------------------
    // Dr Bank / Cr Revenue, both tagged East ($500) and West ($300), in January.
    await run(() => storage.postJournalEntry({
      date: "2026-01-10", memo: "East sale",
      lines: [
        { accountId: bank.id, debit: 50000, credit: 0, classId: east.id },
        { accountId: revenue.id, debit: 0, credit: 50000, classId: east.id },
      ],
    } as any));
    await run(() => storage.postJournalEntry({
      date: "2026-01-10", memo: "West sale",
      lines: [
        { accountId: bank.id, debit: 30000, credit: 0, classId: west.id },
        { accountId: revenue.id, debit: 0, credit: 30000, classId: west.id },
      ],
    } as any));

    const janAll = await run(() => storage.profitAndLoss("2026-01-01", "2026-01-31"));
    check("unfiltered Jan income = $800 (80000¢)", janAll.totalIncome === 80000, String(janAll.totalIncome));
    const janEast = await run(() => storage.profitAndLoss("2026-01-01", "2026-01-31", { classId: east.id }));
    check("class=East Jan income = $500", janEast.totalIncome === 50000, String(janEast.totalIncome));
    const janWest = await run(() => storage.profitAndLoss("2026-01-01", "2026-01-31", { classId: west.id }));
    check("class=West Jan income = $300", janWest.totalIncome === 30000, String(janWest.totalIncome));

    const bsEast = await run(() => storage.balanceSheet("2026-01-31", { classId: east.id }));
    check("class=East balance sheet: assets $500", bsEast.totalAssets === 50000, String(bsEast.totalAssets));
    check("class=East balance sheet balances (A = L + E)", bsEast.totalAssets === bsEast.totalLiabilities + bsEast.totalEquity, `${bsEast.totalAssets} vs ${bsEast.totalLiabilities}+${bsEast.totalEquity}`);

    // ------------------------------------------------------------------------
    console.log("\n[2] Invoice & bill line dimensions propagate to the GL");
    // ------------------------------------------------------------------------
    const cust = await run(() => storage.createCustomer({ name: "Dim Customer" } as any));
    const inv = await run(() => storage.createInvoice({
      customerId: cust.id, date: "2026-02-10", dueDate: "2026-03-10", taxRate: 0,
      lines: [
        { description: "East work", quantity: 1, rate: 100, incomeAccountId: revenue.id, classId: east.id, locationId: nyc.id },
        { description: "West work", quantity: 1, rate: 200, incomeAccountId: revenue.id, classId: west.id, locationId: la.id },
      ],
    } as any));
    const invLines = (await pool.query(
      `SELECT jl.class_id, jl.location_id, jl.credit FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.source = 'invoice' AND je.reference = $1 AND jl.credit > 0
       ORDER BY jl.credit`, [inv.number]
    )).rows as Array<{ class_id: number | null; location_id: number | null; credit: number }>;
    check("invoice posted two dimensioned income lines", invLines.length === 2, `${invLines.length}`);
    const eastLine = invLines.find((l) => l.credit === 10000);
    const westLine = invLines.find((l) => l.credit === 20000);
    check("East $100 income line tagged class=East, loc=NYC", eastLine?.class_id === east.id && eastLine?.location_id === nyc.id, JSON.stringify(eastLine));
    check("West $200 income line tagged class=West, loc=LA", westLine?.class_id === west.id && westLine?.location_id === la.id, JSON.stringify(westLine));

    const vendorId = (await pool.query(`INSERT INTO vendors (org_id,name) VALUES (1,'Dim Vendor') RETURNING id`)).rows[0].id as number;
    const bill = await run(() => storage.createBill({
      vendorId,
      date: "2026-02-15", dueDate: "2026-03-15", taxRate: 0,
      lines: [{ description: "East rent", quantity: 1, rate: 50, expenseAccountId: expense.id, classId: east.id }],
    } as any));
    const billLine = (await pool.query(
      `SELECT jl.class_id, jl.debit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.source = 'bill' AND je.reference = $1 AND jl.debit > 0 AND jl.account_id = $2`,
      [bill.number, expense.id]
    )).rows[0] as { class_id: number | null; debit: number };
    check("bill expense line tagged class=East", billLine.class_id === east.id && billLine.debit === 5000, JSON.stringify(billLine));

    // ------------------------------------------------------------------------
    console.log("\n[3] Dimension-filtered P&L over the invoice/bill period");
    // ------------------------------------------------------------------------
    const febEast = await run(() => storage.profitAndLoss("2026-02-01", "2026-02-28", { classId: east.id }));
    check("Feb class=East income = $100", febEast.totalIncome === 10000, String(febEast.totalIncome));
    check("Feb class=East expenses = $50", febEast.totalExpenses === 5000, String(febEast.totalExpenses));
    const febLA = await run(() => storage.profitAndLoss("2026-02-01", "2026-02-28", { locationId: la.id }));
    check("Feb location=LA income = $200, expenses $0", febLA.totalIncome === 20000 && febLA.totalExpenses === 0, `${febLA.totalIncome}/${febLA.totalExpenses}`);

    // ------------------------------------------------------------------------
    console.log("\n[4] Unknown dimension id is rejected");
    // ------------------------------------------------------------------------
    await expectReject(
      "posting with a non-existent class id fails",
      () => run(() => storage.postJournalEntry({
        date: "2026-03-01", memo: "bad",
        lines: [
          { accountId: bank.id, debit: 1000, credit: 0, classId: 99999 },
          { accountId: revenue.id, debit: 0, credit: 1000 },
        ],
      } as any)),
      /Unknown class/i
    );

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} dimension check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll class/location dimension tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
