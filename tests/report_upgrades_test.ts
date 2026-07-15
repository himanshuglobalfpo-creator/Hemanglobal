// ============================================================================
// REPORT UPGRADES (P3.6) — comparison property + schedule fires once per period
// ============================================================================
// Graded invariants:
//   1. Comparison: the combined P&L-with-comparison returns a `current` and
//      `prior` that EXACTLY equal two independent profitAndLoss() computations
//      over the same ranges (prev_period and prev_year), with correct change /
//      %-change math.
//   2. Scheduling: a schedule fires ONCE per period — next_run advances by one
//      cadence period, so repeated ticks within the period do nothing, and the
//      next period fires again.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("report_upgrades");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Repco','repco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('r@r.test','x','Reporter')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const acct = async (code: string) => (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code=$1`, [code])).rows[0].id as number;
      const cash = await acct("1000"), income = await acct("4000"), expense = await acct("6000");
      const je = (date: string, lines: any[]) => storage.postJournalEntry({ date, memo: "test", reference: "T", source: "manual", lines } as any);

      // Current period (April 2026): income 1000, expense 300.
      await je("2026-04-15", [{ accountId: cash, debit: 100000, credit: 0 }, { accountId: income, debit: 0, credit: 100000 }]);
      await je("2026-04-20", [{ accountId: expense, debit: 30000, credit: 0 }, { accountId: cash, debit: 0, credit: 30000 }]);
      // Prior period (falls in the prev_period window, mid-March): income 500.
      await je("2026-03-15", [{ accountId: cash, debit: 50000, credit: 0 }, { accountId: income, debit: 0, credit: 50000 }]);

      console.log("Test: comparison current/prior match independent computations (prev_period)");
      const comp = await storage.profitAndLossComparison("2026-04-01", "2026-04-30", "prev_period");
      const indepCurrent = await storage.profitAndLoss("2026-04-01", "2026-04-30");
      const indepPrior = await storage.profitAndLoss(comp.priorFrom!, comp.priorTo!);
      check("combined current total income == independent", comp.current.totalIncome === indepCurrent.totalIncome && comp.current.totalIncome === 100000);
      check("combined current total expenses == independent", comp.current.totalExpenses === indepCurrent.totalExpenses && comp.current.totalExpenses === 30000);
      check("combined prior total income == independent", comp.prior!.totalIncome === indepPrior.totalIncome && comp.prior!.totalIncome === 50000);
      check("prior window is the 30 days before April", comp.priorFrom === "2026-03-02" && comp.priorTo === "2026-03-31");

      const incRow = (comp as any).income.find((r: any) => r.code === "4000");
      check("income line current 1000 / prior 500 / change 500", incRow.current === 100000 && incRow.prior === 50000 && incRow.change === 50000);
      check("% change = +100%", Math.abs(incRow.pctChange - 100) < 1e-9);
      check("% of income = 100% (only income account)", Math.abs(incRow.pctOfIncome - 100) < 1e-9);
      check("totals block change math", (comp as any).totals.income.change === 50000 && (comp as any).totals.net.change === 100000 - 30000 - 50000);

      console.log("Test: prev_year comparison uses the same window one year back");
      const compY = await storage.profitAndLoss("2026-04-01", "2026-04-30");
      const comp2 = await storage.profitAndLossComparison("2026-04-01", "2026-04-30", "prev_year");
      const indepPriorY = await storage.profitAndLoss("2025-04-01", "2025-04-30");
      check("prev_year prior window shifts back 12 months", comp2.priorFrom === "2025-04-01" && comp2.priorTo === "2025-04-30");
      check("prev_year current matches standalone", comp2.current.totalIncome === compY.totalIncome);
      check("prev_year prior matches independent (0, no data)", comp2.prior!.totalIncome === indepPriorY.totalIncome && comp2.prior!.totalIncome === 0);

      // A monthly schedule created for April.
      await storage.createReportSchedule({ reportKey: "profit-loss", params: {}, cadence: "monthly", recipients: "", nextRun: "2026-04-01", isActive: true });
    });

    console.log("Test: schedule fires exactly once per period");
    const fired1 = await storage.runDueReportSchedules("2026-04-01");
    check("fires on the due date", fired1.length === 1 && fired1[0].reportKey === "profit-loss");
    check("next_run advanced one month", fired1[0].nextRun === "2026-05-01");
    const fired2 = await storage.runDueReportSchedules("2026-04-15");
    check("does NOT fire again in the same period", fired2.length === 0);
    const fired3 = await storage.runDueReportSchedules("2026-05-02");
    check("fires again in the next period", fired3.length === 1 && fired3[0].nextRun === "2026-06-01");
    // last_run reflects the most recent fire.
    const lr = (await pool.query(`SELECT last_run FROM report_schedules LIMIT 1`)).rows[0].last_run;
    check("last_run records the latest fire", lr === "2026-05-02");

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — comparison equals independent passes; schedules fire once per period");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
