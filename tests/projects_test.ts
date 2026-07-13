// ============================================================================
// PROJECT (JOB) TRACKING — third dimension, per-project P&L
// ============================================================================
// Mirrors dimensions_test.ts for the project dimension, and additionally proves
// the per-project Profit & Loss report:
//
//   (1) Manual journal lines carry a project; P&L + Balance Sheet filter by it
//       (a fully-dimensioned JE keeps the filtered BS balanced).
//   (2) Invoice/bill line projects PROPAGATE onto the posted GL lines.
//   (3) A project-filtered P&L reflects only the matching lines.
//   (4) projectProfitAndLoss() rolls income/expense/net up per project, plus an
//       "Unassigned" bucket.
//   (5) An unknown project id is rejected; a project may link a customer
//       (validated in-org).
//
// Run: tsx tests/projects_test.ts
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
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("projects");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Job Co', 'job-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('p@p.test', 'x', 'Job Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const revenue = accts.find((a) => a.code === "4000")!;
    const expense = accts.find((a) => a.code === "6000")!;
    const cust = await run(() => storage.createCustomer({ name: "Homeowner" } as any));

    // Projects (one tied to a customer = QBO customer:job).
    const kitchen = await run(() => storage.createProject({ name: "Kitchen Remodel", customerId: cust.id } as any));
    const roof = await run(() => storage.createProject({ name: "Roof Job" } as any));
    check("projects created; customer link accepted", !!kitchen.id && kitchen.customerId === cust.id && !!roof.id);

    // ------------------------------------------------------------------------
    console.log("\n[1] Fully-dimensioned manual JEs → project-filtered P&L + balanced BS");
    // ------------------------------------------------------------------------
    await run(() => storage.postJournalEntry({
      date: "2026-01-10", memo: "Kitchen deposit",
      lines: [
        { accountId: bank.id, debit: 50000, credit: 0, projectId: kitchen.id },
        { accountId: revenue.id, debit: 0, credit: 50000, projectId: kitchen.id },
      ],
    } as any));
    await run(() => storage.postJournalEntry({
      date: "2026-01-10", memo: "Roof deposit",
      lines: [
        { accountId: bank.id, debit: 30000, credit: 0, projectId: roof.id },
        { accountId: revenue.id, debit: 0, credit: 30000, projectId: roof.id },
      ],
    } as any));

    const janKitchen = await run(() => storage.profitAndLoss("2026-01-01", "2026-01-31", { projectId: kitchen.id }));
    check("project=Kitchen Jan income = $500", janKitchen.totalIncome === 50000, String(janKitchen.totalIncome));
    const janRoof = await run(() => storage.profitAndLoss("2026-01-01", "2026-01-31", { projectId: roof.id }));
    check("project=Roof Jan income = $300", janRoof.totalIncome === 30000, String(janRoof.totalIncome));
    const bsKitchen = await run(() => storage.balanceSheet("2026-01-31", { projectId: kitchen.id }));
    check("project=Kitchen balance sheet balances (A = L + E) at $500", bsKitchen.totalAssets === 50000 && bsKitchen.totalAssets === bsKitchen.totalLiabilities + bsKitchen.totalEquity, `${bsKitchen.totalAssets}/${bsKitchen.totalEquity}`);

    // ------------------------------------------------------------------------
    console.log("\n[2] Invoice & bill line projects propagate to the GL");
    // ------------------------------------------------------------------------
    const inv = await run(() => storage.createInvoice({
      customerId: cust.id, date: "2026-02-10", dueDate: "2026-03-10", taxRate: 0,
      lines: [
        { description: "Cabinets", quantity: 1, rate: 100, incomeAccountId: revenue.id, projectId: kitchen.id },
        { description: "Shingles labor", quantity: 1, rate: 200, incomeAccountId: revenue.id, projectId: roof.id },
      ],
    } as any));
    const invLines = (await pool.query(
      `SELECT jl.project_id, jl.credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.source = 'invoice' AND je.reference = $1 AND jl.credit > 0 ORDER BY jl.credit`, [inv.number]
    )).rows as Array<{ project_id: number | null; credit: number }>;
    check("invoice posted two project-tagged income lines", invLines.length === 2);
    check("$100 line → Kitchen, $200 line → Roof",
      invLines.find((l) => l.credit === 10000)?.project_id === kitchen.id && invLines.find((l) => l.credit === 20000)?.project_id === roof.id, JSON.stringify(invLines));

    const vendorId = (await pool.query(`INSERT INTO vendors (org_id,name) VALUES (1,'Lumber Yard') RETURNING id`)).rows[0].id as number;
    const bill = await run(() => storage.createBill({
      vendorId, date: "2026-02-15", dueDate: "2026-03-15", taxRate: 0,
      lines: [{ description: "Materials", quantity: 1, rate: 50, expenseAccountId: expense.id, projectId: kitchen.id }],
    } as any));
    const billLine = (await pool.query(
      `SELECT jl.project_id, jl.debit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.source = 'bill' AND je.reference = $1 AND jl.debit > 0 AND jl.account_id = $2`, [bill.number, expense.id]
    )).rows[0] as { project_id: number | null; debit: number };
    check("bill expense line tagged project=Kitchen", billLine.project_id === kitchen.id && billLine.debit === 5000, JSON.stringify(billLine));

    // ------------------------------------------------------------------------
    console.log("\n[3] Project-filtered P&L over the invoice/bill period");
    // ------------------------------------------------------------------------
    const febKitchen = await run(() => storage.profitAndLoss("2026-02-01", "2026-02-28", { projectId: kitchen.id }));
    check("Feb Kitchen income $100, expenses $50", febKitchen.totalIncome === 10000 && febKitchen.totalExpenses === 5000, `${febKitchen.totalIncome}/${febKitchen.totalExpenses}`);

    // ------------------------------------------------------------------------
    console.log("\n[4] Per-project Profit & Loss report");
    // ------------------------------------------------------------------------
    const ppl = await run(() => storage.projectProfitAndLoss("2026-01-01", "2026-12-31"));
    const kRow = ppl.rows.find((r) => r.projectId === kitchen.id)!;
    const rRow = ppl.rows.find((r) => r.projectId === roof.id)!;
    check("Kitchen: income $600, expenses $50, net $550", kRow.income === 60000 && kRow.expenses === 5000 && kRow.net === 55000, JSON.stringify(kRow));
    check("Roof: income $500, expenses $0, net $500", rRow.income === 50000 && rRow.expenses === 0 && rRow.net === 50000, JSON.stringify(rRow));
    check("report totals net = $1,050", ppl.netIncome === 105000, String(ppl.netIncome));

    // An untagged expense shows up under "Unassigned".
    await run(() => storage.postJournalEntry({
      date: "2026-03-01", memo: "Office supplies (no project)",
      lines: [{ accountId: expense.id, debit: 1000, credit: 0 }, { accountId: bank.id, debit: 0, credit: 1000 }],
    } as any));
    const ppl2 = await run(() => storage.projectProfitAndLoss("2026-01-01", "2026-12-31"));
    const unassigned = ppl2.rows.find((r) => r.projectId === null);
    check("Unassigned bucket captures the untagged $10 expense", unassigned?.expenses === 1000 && unassigned?.net === -1000, JSON.stringify(unassigned));

    // ------------------------------------------------------------------------
    console.log("\n[5] Validation");
    // ------------------------------------------------------------------------
    await expectReject("posting with an unknown project id fails",
      () => run(() => storage.postJournalEntry({
        date: "2026-03-02", memo: "bad",
        lines: [{ accountId: bank.id, debit: 1000, credit: 0, projectId: 99999 }, { accountId: revenue.id, debit: 0, credit: 1000 }],
      } as any)), /Unknown project/i);
    await expectReject("creating a project for a non-existent customer fails",
      () => run(() => storage.createProject({ name: "Bad Job", customerId: 99999 } as any)), /Customer #99999 not found/i);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} project check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll project (job) tracking tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
