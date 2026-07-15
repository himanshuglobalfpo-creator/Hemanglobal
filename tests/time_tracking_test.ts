// ============================================================================
// TIME TRACKING (P3.3) — billing, double-bill guard, void-unlink, project P&L
// ============================================================================
// Pins the three invariants the feature lives or dies by:
//   1. A billable time entry can be billed ONCE — a second attempt is rejected
//      and the offending invoice never persists (atomic rollback).
//   2. Voiding the invoice UNLINKS the entry (invoiced_line_id → NULL) — the
//      time is preserved and billable again, never deleted.
//   3. Project actuals include the invoiced time revenue (GL, project-scoped),
//      and unbilled totals move correctly as time is billed.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("time_tracking");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Timeco','timeco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('t@t.test','x','Timekeeper')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const custId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme Corp') RETURNING id`)).rows[0].id as number;
      const project = await storage.createProject({ name: "Website Rebuild", customerId: custId, budgetIncomeCents: 100000, budgetCostCents: 40000 } as any);
      const incomeAcct = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4100'`)).rows[0].id as number;

      // Two billable hours at $150/h and one non-billable hour.
      const te1 = await storage.createTimeEntry({ userId: 1, projectId: project.id, serviceDate: "2026-03-02", description: "Build", minutes: 120, billable: true, rateCents: 15000 } as any);
      const teNonBillable = await storage.createTimeEntry({ userId: 1, projectId: project.id, serviceDate: "2026-03-03", description: "Internal", minutes: 60, billable: false, rateCents: 15000 } as any);

      console.log("Test: unbilled totals before billing");
      let budget = await storage.projectBudgetActual(project.id);
      check("unbilled minutes = 120 (only the billable entry)", budget.unbilledMinutes === 120);
      check("unbilled amount = $300.00 (30000 cents)", budget.unbilledAmount === 30000);
      check("actual income is 0 before billing", budget.actualIncome === 0);
      check("budget income/cost surfaced", budget.budgetIncome === 100000 && budget.budgetCost === 40000);

      console.log("Test: billing a time entry links it to the invoice line");
      const inv = await storage.createInvoice({
        customerId: custId, date: "2026-03-31", dueDate: "2026-04-30", taxRate: 0,
        lines: [{ description: "Development (2.0h)", quantity: 2, rate: 150, incomeAccountId: incomeAcct, projectId: project.id, timeEntryId: te1.id }],
      } as any);
      const te1After = (await pool.query(`SELECT invoiced_line_id AS l FROM time_entries WHERE id=$1`, [te1.id])).rows[0];
      check("time entry now linked to an invoice line", te1After.l !== null);
      const line = (await pool.query(`SELECT id FROM invoice_lines WHERE invoice_id=$1`, [inv.id])).rows[0];
      check("linked to THIS invoice's line", te1After.l === line.id);

      console.log("Test: double-billing is blocked (and rolls the second invoice back)");
      const invCountBefore = Number((await pool.query(`SELECT COUNT(*)::int c FROM invoices WHERE org_id=1`)).rows[0].c);
      let threw = false;
      try {
        await storage.createInvoice({
          customerId: custId, date: "2026-04-01", dueDate: "2026-05-01", taxRate: 0,
          lines: [{ description: "Development again", quantity: 2, rate: 150, incomeAccountId: incomeAcct, projectId: project.id, timeEntryId: te1.id }],
        } as any);
      } catch { threw = true; }
      check("second bill of the same entry throws", threw);
      const invCountAfter = Number((await pool.query(`SELECT COUNT(*)::int c FROM invoices WHERE org_id=1`)).rows[0].c);
      check("the rejected invoice did NOT persist (atomic rollback)", invCountAfter === invCountBefore);
      const stillLinked = (await pool.query(`SELECT invoiced_line_id AS l FROM time_entries WHERE id=$1`, [te1.id])).rows[0];
      check("entry stays linked to the ORIGINAL line", stillLinked.l === line.id);

      console.log("Test: project P&L includes the invoiced time revenue");
      budget = await storage.projectBudgetActual(project.id);
      check("actual income now = $300.00 (invoiced time)", budget.actualIncome === 30000);
      check("unbilled amount back to 0 after billing", budget.unbilledAmount === 0);
      const ppl = await storage.projectProfitAndLoss("2026-01-01", "2026-12-31");
      const row = ppl.rows.find((r: any) => r.projectId === project.id);
      check("project P&L attributes $300 income to the project", !!row && row.income === 30000);

      console.log("Test: voiding the invoice UNLINKS (not deletes) the time entry");
      await storage.voidInvoice(inv.id);
      const afterVoid = (await pool.query(`SELECT invoiced_line_id AS l FROM time_entries WHERE id=$1`, [te1.id])).rows[0];
      check("entry unlinked after void (invoiced_line_id NULL)", afterVoid && afterVoid.l === null);
      const stillExists = Number((await pool.query(`SELECT COUNT(*)::int c FROM time_entries WHERE id=$1`, [te1.id])).rows[0].c);
      check("entry still EXISTS (preserved, not deleted)", stillExists === 1);
      budget = await storage.projectBudgetActual(project.id);
      check("time is billable again — unbilled back to $300", budget.unbilledAmount === 30000);

      console.log("Test: a billed entry cannot be edited/deleted, non-billable never bills");
      // Re-bill, then confirm edit/delete are blocked while linked.
      const inv2 = await storage.createInvoice({
        customerId: custId, date: "2026-05-31", dueDate: "2026-06-30", taxRate: 0,
        lines: [{ description: "Dev (2.0h)", quantity: 2, rate: 150, incomeAccountId: incomeAcct, projectId: project.id, timeEntryId: te1.id }],
      } as any);
      let editBlocked = false, delBlocked = false;
      try { await storage.updateTimeEntry(te1.id, { minutes: 30 } as any); } catch { editBlocked = true; }
      try { await storage.deleteTimeEntry(te1.id); } catch { delBlocked = true; }
      check("editing a billed entry is blocked", editBlocked);
      check("deleting a billed entry is blocked", delBlocked);
      check("non-billable time is excluded from the unbilled pool", (await storage.listUnbilledTimeForCustomer(custId)).every((t: any) => t.id !== teNonBillable.id));
      void inv2;
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — time bills once, void unlinks (not deletes), project P&L includes invoiced time");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
