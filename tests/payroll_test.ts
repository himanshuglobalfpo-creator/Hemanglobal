// ============================================================================
// PAYROLL — tax engine, pay-run posting, YTD wage-base caps
// ============================================================================
// Proves, against the pure engine and a real Postgres:
//
//   (1) The tax engine computes FICA + flat withholding correctly in integer
//       cents, and Social Security stops at the annual wage base using YTD.
//   (2) Posting a pay run books ONE balanced journal entry:
//         Dr Wages + Dr Payroll Tax Expense
//         Cr Payroll Taxes Payable + Cr Deductions Payable + Cr Bank (net pay)
//       and the run totals reconcile.
//   (3) A pay run cannot be posted twice.
//   (4) Social Security caps across TWO posted runs (the second withholds less
//       once the annual wage base is reached).
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/payroll_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeEmployeePayroll, salaryGrossForPeriod } from "../shared/payroll";

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
  // ------------------------------------------------------------------------
  console.log("[1] Pure tax engine (integer cents)");
  // ------------------------------------------------------------------------
  // $52,000 salary, biweekly → $2,000 gross; 10% federal withholding, no state.
  const gross = salaryGrossForPeriod(52_000_00, "biweekly");
  check("biweekly gross of $52,000 salary = $2,000 (200000¢)", gross === 200_000, String(gross));
  const a = computeEmployeePayroll({ grossCents: gross, ytdGrossCents: 0, federalWithholdingRate: 0.10, stateWithholdingRate: 0 });
  check("federal withholding = $200 (20000¢)", a.fedWithholdingCents === 20_000, String(a.fedWithholdingCents));
  check("Social Security employee = 6.2% = $124 (12400¢)", a.ssEmployeeCents === 12_400, String(a.ssEmployeeCents));
  check("Medicare employee = 1.45% = $29 (2900¢)", a.medicareEmployeeCents === 2_900, String(a.medicareEmployeeCents));
  check("total employee tax = $353 (35300¢)", a.employeeTaxCents === 35_300, String(a.employeeTaxCents));
  check("employer tax = SS 124 + Med 29 + FUTA 12 = $165 (16500¢)", a.employerTaxCents === 16_500, String(a.employerTaxCents));
  check("net pay = $1,647 (164700¢)", a.netCents === 164_700, String(a.netCents));
  // Employer Social Security matches the employee; FUTA is 0.6% of $2,000 = $12.
  check("employer SS matches employee, FUTA = $12 (1200¢)", a.ssEmployerCents === 12_400 && a.futaCents === 1_200);

  // Social Security wage-base cap: with $160,000 YTD, only $860 of the next
  // $10,000 is still SS-eligible → 6.2% × $860 = $53.32.
  const capped = computeEmployeePayroll({ grossCents: 1_000_000, ytdGrossCents: 16_000_000, federalWithholdingRate: 0, stateWithholdingRate: 0 });
  check("SS caps at the annual wage base via YTD (5332¢)", capped.ssEmployeeCents === 53_320, String(capped.ssEmployeeCents));

  let shutdown: () => Promise<void> = async () => {};
  if (!process.env.DATABASE_URL) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = (await import("embedded-postgres")).default;
    } catch {
      console.error("This test needs Postgres. Set DATABASE_URL to a THROWAWAY database, or `npm i -D embedded-postgres`.");
      process.exit(1);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-pay-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port: 55451,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_payroll_test");
    process.env.DATABASE_URL = "postgresql://postgres:password@localhost:55451/ledgerlite_payroll_test";
    shutdown = async () => { await epg.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  }

  try {
    const { pool, runMigrations, storage, seedOrgDefaults } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Payroll Co', 'payroll-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('p@p.test', 'x', 'Payroll Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const wages = accts.find((a) => a.code === "6300")!;
    const taxExp = accts.find((a) => a.code === "6350")!;
    const taxesPayable = accts.find((a) => a.code === "2300")!;
    const deductionsPayable = accts.find((a) => a.code === "2310")!;

    const jeFor = async (runId: number) => {
      const rows = (await pool.query(
        `SELECT jl.account_id AS "accountId", jl.debit, jl.credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.org_id = 1 AND je.source = 'payroll' AND je.source_id = $1`, [runId]
      )).rows as Array<{ accountId: number; debit: number; credit: number }>;
      return { rows, dr: rows.reduce((s, r) => s + Number(r.debit), 0), cr: rows.reduce((s, r) => s + Number(r.credit), 0) };
    };

    // ------------------------------------------------------------------------
    console.log("\n[2] Pay run with a salaried + an hourly employee (with deductions) posts a balanced JE");
    // ------------------------------------------------------------------------
    const empA = await run(() => storage.createEmployee({ name: "Alice Salary", payType: "salary", payRateCents: 52_000_00, payFrequency: "biweekly", federalWithholdingRate: 0.10, stateWithholdingRate: 0 } as any));
    const empB = await run(() => storage.createEmployee({ name: "Bob Hourly", payType: "hourly", payRateCents: 3_000, payFrequency: "biweekly", federalWithholdingRate: 0.12, stateWithholdingRate: 0 } as any));

    const draft = await run(() => storage.createPayrollRun({
      payDate: "2026-01-15", periodStart: "2026-01-01", periodEnd: "2026-01-14", bankAccountId: bank.id,
      lines: [
        { employeeId: empA.id, additionalPayCents: 0, preTaxDeductionCents: 0, postTaxDeductionCents: 0 },
        { employeeId: empB.id, hours: 80, additionalPayCents: 0, preTaxDeductionCents: 20_000, postTaxDeductionCents: 5_000 },
      ],
    } as any));
    check("draft run created (status 'draft')", draft.status === "draft", draft.status);
    // Alice gross $2,000 + Bob 80h × $30 = $2,400 → $4,400.
    check("run total gross = $4,400 (440000¢)", draft.totalGrossCents === 440_000, String(draft.totalGrossCents));

    const posted = await run(() => storage.postPayrollRun(draft.id));
    check("run is now 'posted' with a journal entry", posted.status === "posted" && !!posted.entryId);
    check("posted total deductions = $250 (25000¢)", posted.totalDeductionsCents === 25_000, String(posted.totalDeductionsCents));

    const je = await jeFor(draft.id);
    check("payroll JE balances exactly (Dr = Cr)", je.dr === je.cr && je.dr > 0, `dr ${je.dr} cr ${je.cr}`);
    check("Dr Wages Expense = total gross", je.rows.some((r) => r.accountId === wages.id && Number(r.debit) === posted.totalGrossCents));
    check("Dr Payroll Tax Expense = employer taxes", je.rows.some((r) => r.accountId === taxExp.id && Number(r.debit) === posted.totalEmployerTaxCents));
    check("Cr Payroll Taxes Payable = employee + employer taxes", je.rows.some((r) => r.accountId === taxesPayable.id && Number(r.credit) === posted.totalEmployeeTaxCents + posted.totalEmployerTaxCents));
    check("Cr Payroll Deductions Payable = $250", je.rows.some((r) => r.accountId === deductionsPayable.id && Number(r.credit) === 25_000));
    check("Cr Bank = net pay", je.rows.some((r) => r.accountId === bank.id && Number(r.credit) === posted.totalNetCents));
    // Cross-foot: gross + employerTax === employeeTax + employerTax + deductions + net.
    check("run reconciles: gross + employer tax = taxes + deductions + net",
      posted.totalGrossCents + posted.totalEmployerTaxCents === (posted.totalEmployeeTaxCents + posted.totalEmployerTaxCents) + posted.totalDeductionsCents + posted.totalNetCents);

    // ------------------------------------------------------------------------
    console.log("\n[3] A posted pay run cannot be posted again");
    // ------------------------------------------------------------------------
    await expectReject("re-posting a posted run is rejected", () => run(() => storage.postPayrollRun(draft.id)), /already posted/i);

    // ------------------------------------------------------------------------
    console.log("\n[4] Social Security caps across two posted runs (YTD wage base)");
    // ------------------------------------------------------------------------
    // Monthly $1.2M salary → $100,000/period. Run 1 (YTD 0) taxes the full
    // $100k for SS; run 2 (YTD $100k) only taxes the remaining $68,600 of base.
    const exec = await run(() => storage.createEmployee({ name: "Carol Exec", payType: "salary", payRateCents: 1_200_000_00, payFrequency: "monthly", federalWithholdingRate: 0, stateWithholdingRate: 0 } as any));
    const r1 = await run(() => storage.createPayrollRun({ payDate: "2026-01-31", periodStart: "2026-01-01", periodEnd: "2026-01-31", bankAccountId: bank.id, lines: [{ employeeId: exec.id, additionalPayCents: 0, preTaxDeductionCents: 0, postTaxDeductionCents: 0 }] } as any));
    await run(() => storage.postPayrollRun(r1.id));
    const r2 = await run(() => storage.createPayrollRun({ payDate: "2026-02-28", periodStart: "2026-02-01", periodEnd: "2026-02-28", bankAccountId: bank.id, lines: [{ employeeId: exec.id, additionalPayCents: 0, preTaxDeductionCents: 0, postTaxDeductionCents: 0 }] } as any));
    await run(() => storage.postPayrollRun(r2.id));
    const d1 = (await run(() => storage.getPayrollRun(r1.id)))!;
    const d2 = (await run(() => storage.getPayrollRun(r2.id)))!;
    const ss1 = d1.items[0].ssEmployeeCents;
    const ss2 = d2.items[0].ssEmployeeCents;
    check("run 1 SS = 6.2% × $100,000 = $6,200 (620000¢)", ss1 === 620_000, String(ss1));
    check("run 2 SS is capped: 6.2% × remaining $68,600 = $4,253.20 (425320¢)", ss2 === 425_320, String(ss2));
    check("run 2 withholds LESS SS than run 1 (wage base reached)", ss2 < ss1);

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n❌ ${failures} payroll check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll payroll tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
