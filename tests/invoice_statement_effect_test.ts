/**
 * STATEMENT-EFFECT TEST — the "$100 invoice + $10 tax" scenario, end to end,
 * against the REAL storage engine (server/storage.ts, Postgres/Drizzle).
 * This is NOT a mirror test: it exercises the exact code production runs, and
 * it is the regression guard for the createInvoice / payInvoice GL wiring
 * (including the item-aware line resolution added for inventory).
 *
 * What it proves:
 *   1. Posting an invoice creates ONE balanced journal entry:
 *        Dr Accounts Receivable 110 / Cr Sales Revenue 100 / Cr Sales Tax Payable 10
 *   2. P&L shows revenue 100 (tax is NOT income — it's money held for the state)
 *   3. Balance Sheet: A/R +110 (asset), Sales Tax Payable +10 (liability),
 *      Net Income +100 (equity) → A = L + E holds exactly (110 = 10 + 100)
 *   4. Trial Balance: total debits = total credits
 *   5. A/R Aging shows the invoice at 110 open, matching the GL
 *   6. Tax Liability report shows 10 collected
 *   7. Cash Flow: ZERO cash moved (accrual — nothing hits cash until payment)
 *   8. After payment: Dr Cash 110 / Cr A/R 110 → bank 110, A/R 0, tax still owed 10
 *
 * Postgres harness (same as the other integration tests): uses $DATABASE_URL
 * if set (must be throwaway), else embedded-postgres.
 *
 * Run with: npx tsx tests/invoice_statement_effect_test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.TAXJAR_API_KEY; // manual-tax path: this test is about ledger effects

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → got ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}
// Ledger values are INTEGER CENTS — equality is EXACT, no epsilon.
const eq2 = (a: number, b: number) => a === b;
const $ = (dollars: number) => Math.round(dollars * 100);

async function main() {
  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error("This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`.");
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-stmt-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port: 55444,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_stmt_test");
    process.env.DATABASE_URL = "postgresql://postgres:password@localhost:55444/ledgerlite_stmt_test";
    shutdown = async () => { await epg.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  }

  try {
    const { pool, runMigrations, storage, seedOrgDefaults } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Stmt Co', 'stmt-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('s@s.test', 'x', 'Stmt Tester')`);
    await seedOrgDefaults(1); // full default chart of accounts, exactly like production

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const accounts = await storage.listAccounts();
      const byCode = (c: string) => accounts.find((a) => a.code === c)!;
      const AR = byCode("1100");       // Accounts Receivable (asset)
      const BANK = byCode("1000");     // Checking (asset)
      const REVENUE = byCode("4000");  // Sales Revenue (income)
      const TAXPAY = byCode("2100");   // Sales Tax Payable (liability)

      const cust = await storage.createCustomer({ name: "Test Customer" } as any);
      const DATE = "2026-07-05";

      // ── THE SCENARIO: $100 sale, 10% tax ───────────────────────────────────
      const inv = await storage.createInvoice({
        number: "INV-TEST-1",
        customerId: cust.id,
        date: DATE,
        dueDate: "2026-08-04",
        taxRate: 10,
        lines: [{ description: "Consulting", quantity: 1, rate: 100, incomeAccountId: REVENUE.id }],
      } as any);

      console.log("1. Invoice math");
      check("subtotal = 100.00", eq2(inv.subtotal, $(100)), inv.subtotal);
      check("tax = 10.00", eq2(inv.tax, $(10)), inv.tax);
      check("total = 110.00", eq2(inv.total, $(110)), inv.total);

      console.log("2. The journal entry (the single source of truth for every report)");
      const je = (await storage.listJournalEntries(10)).rows.find((e) => e.reference === "INV-TEST-1")!;
      check("journal entry exists with source=invoice", !!je && je.source === "invoice", je?.source);
      const line = (acctId: number) => je.lines.find((l) => l.accountId === acctId);
      check("Dr Accounts Receivable 110", eq2(line(AR.id)?.debit ?? -1, $(110)), line(AR.id));
      check("Cr Sales Revenue 100", eq2(line(REVENUE.id)?.credit ?? -1, $(100)), line(REVENUE.id));
      check("Cr Sales Tax Payable 10", eq2(line(TAXPAY.id)?.credit ?? -1, $(10)), line(TAXPAY.id));
      const drSum = je.lines.reduce((s, l) => s + l.debit, 0);
      const crSum = je.lines.reduce((s, l) => s + l.credit, 0);
      check("entry balances: debits 110 = credits 110", eq2(drSum, $(110)) && eq2(crSum, $(110)), { drSum, crSum });

      console.log("3. Profit & Loss — tax is NOT revenue");
      const pl = await storage.profitAndLoss(DATE, DATE);
      check("total income = 100 (not 110!)", eq2(pl.totalIncome, $(100)), pl.totalIncome);
      check("net income = 100", eq2(pl.netIncome, $(100)), pl.netIncome);

      console.log("4. Balance Sheet — A = L + E");
      const bs = await storage.balanceSheet(DATE);
      const bsLine = (rows: any[], code: string) => rows.find((r) => r.code === code)?.balance ?? 0;
      check("A/R = 110 (asset)", eq2(bsLine(bs.assets, "1100"), $(110)), bs.assets);
      check("Sales Tax Payable = 10 (liability)", eq2(bsLine(bs.liabilities, "2100"), $(10)), bs.liabilities);
      check("total assets = 110", eq2(bs.totalAssets, $(110)), bs.totalAssets);
      check("total liabilities = 10", eq2(bs.totalLiabilities, $(10)), bs.totalLiabilities);
      check("total equity (incl. net income) = 100", eq2(bs.totalEquity, $(100)), bs.totalEquity);
      check(
        "ACCOUNTING EQUATION: 110 = 10 + 100",
        eq2(bs.totalAssets, bs.totalLiabilities + bs.totalEquity),
        { A: bs.totalAssets, L: bs.totalLiabilities, E: bs.totalEquity }
      );

      console.log("5. Trial Balance — debits = credits across the whole ledger");
      const tb = await storage.trialBalance(DATE);
      check("total debits = total credits", eq2(tb.totalDebit, tb.totalCredit), tb);
      check("trial balance total = 110", eq2(tb.totalDebit, $(110)), tb.totalDebit);

      console.log("6. A/R Aging — subledger ties to the GL");
      const aging = await storage.arAging(DATE);
      check("aging total = 110 open", eq2(aging.totals.total, $(110)), aging.totals);
      check("aging matches A/R GL balance (no warning)", !aging.warning, aging.warning);

      console.log("7. Tax Liability report");
      const taxRep = await storage.taxLiabilityReport(DATE);
      const collected = taxRep.rows.reduce((s, r) => s + r.collected, 0);
      check("tax collected (owed to the state) = 10", eq2(collected, $(10)), taxRep.rows);

      console.log("8. Cash Flow — NOTHING yet (accrual: no cash has moved)");
      const cf1 = await storage.cashFlowStatement(DATE, DATE) as any;
      const netCash1 = cf1.netChangeInCash ?? cf1.netCashChange ?? cf1.netChange ?? 0;
      check("net change in cash = 0 before payment", eq2(netCash1, $(0)), netCash1);

      // ── CUSTOMER PAYS: Dr Cash 110 / Cr A/R 110 ───────────────────────────
      await storage.payInvoice({ invoiceId: inv.id, date: DATE, amount: 110, bankAccountId: BANK.id } as any);

      console.log("9. After payment");
      const bs2 = await storage.balanceSheet(DATE);
      check("bank = 110", eq2(bsLine(bs2.assets, "1000"), $(110)), bs2.assets);
      check("A/R = 0 (dropped off the balance sheet)", eq2(bsLine(bs2.assets, "1100"), $(0)), bs2.assets);
      check("Sales Tax Payable STILL 10 (owed until remitted)", eq2(bsLine(bs2.liabilities, "2100"), $(10)), bs2.liabilities);
      const pl2 = await storage.profitAndLoss(DATE, DATE);
      check("P&L unchanged by payment (revenue still 100)", eq2(pl2.totalIncome, $(100)), pl2.totalIncome);
      const cf2 = await storage.cashFlowStatement(DATE, DATE) as any;
      const netCash2 = cf2.netChangeInCash ?? cf2.netCashChange ?? cf2.netChange ?? 0;
      check("cash flow now shows +110", eq2(netCash2, $(110)), cf2);
      const paidInv = (await storage.getInvoice(inv.id))!;
      check("invoice status = paid", paidInv.status === "paid", paidInv.status);
    });

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed — the ledger does NOT behave correctly`);
    process.exit(1);
  }
  console.log("\n✅ ALL CHECKS PASS — $100 + $10 tax flows correctly through JE → P&L → Balance Sheet → Trial Balance → Aging → Tax Liability → Cash Flow");
}

main().catch((e) => { console.error(e); process.exit(1); });
