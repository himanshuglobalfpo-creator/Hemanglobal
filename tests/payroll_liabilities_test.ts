// ============================================================================
// PAYROLL LIABILITIES & PAY STUBS — remittance closes the loop (QBO "Pay Taxes")
// ============================================================================
// Proves, against a real Postgres:
//
//   (1) After a posted pay run, GET liabilities shows what is owed on the
//       payroll-liability accounts (Payroll Taxes Payable + Deductions Payable).
//   (2) Remitting posts a balanced JE (Dr liability / Cr Bank) that reduces the
//       liability to zero and draws the bank down by the same amount.
//   (3) A pay stub returns the employee's paycheck breakdown and YTD figures.
//
// Postgres harness (same as the other integration tests): uses $DATABASE_URL if
// set (must be throwaway), else embedded-postgres.
//
// Run: tsx tests/payroll_liabilities_test.ts
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlite-payliab-pg-"));
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "postgres", password: "password", port: 55452,
      persistent: false, createPostgresUser: (process.getuid?.() ?? 1000) === 0,
    });
    await epg.initialise();
    await epg.start();
    await epg.createDatabase("ledgerlite_payliab_test");
    process.env.DATABASE_URL = "postgresql://postgres:password@localhost:55452/ledgerlite_payliab_test";
    shutdown = async () => { await epg.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  }

  try {
    const { pool, runMigrations, storage, seedOrgDefaults } = await import("../server/storage");
    const { withOrg } = await import("../server/org-scope");
    await runMigrations();
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Payroll Liab Co', 'payroll-liab-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('pl@pl.test', 'x', 'PL Tester')`);
    await seedOrgDefaults(1);
    const ctx = { orgId: 1, userId: 1 };
    const run = <T>(fn: () => Promise<T>) => withOrg(ctx, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const taxesPayable = accts.find((a) => a.code === "2300")!;

    // ------------------------------------------------------------------------
    console.log("\n[setup] Run + post payroll for one salaried employee");
    // ------------------------------------------------------------------------
    const emp = await run(() => storage.createEmployee({ name: "Dana Salary", payType: "salary", payRateCents: 52_000_00, payFrequency: "biweekly", federalWithholdingRate: 0.10, stateWithholdingRate: 0 } as any));
    const draft = await run(() => storage.createPayrollRun({
      payDate: "2026-01-15", periodStart: "2026-01-01", periodEnd: "2026-01-14", bankAccountId: bank.id,
      lines: [{ employeeId: emp.id, additionalPayCents: 0, preTaxDeductionCents: 0, postTaxDeductionCents: 0 }],
    } as any));
    const posted = await run(() => storage.postPayrollRun(draft.id));
    // Employee tax 35300 + employer tax 16500 = 51800 owed on Payroll Taxes Payable.
    const owed = posted.totalEmployeeTaxCents + posted.totalEmployerTaxCents;
    const bankAfterPayroll = (await run(() => storage.accountBalances("2026-01-15"))).get(bank.id)!.balance;

    // ------------------------------------------------------------------------
    console.log("\n[1] Liabilities report shows what's owed");
    // ------------------------------------------------------------------------
    const liabs = await run(() => storage.payrollLiabilityBalances("2026-01-31"));
    const taxRow = liabs.find((l) => l.code === "2300")!;
    check("Payroll Taxes Payable balance = employee + employer taxes", taxRow.balanceCents === owed, `${taxRow.balanceCents} vs ${owed}`);
    check("liabilities report lists Deductions Payable too", liabs.some((l) => l.code === "2310"));

    // ------------------------------------------------------------------------
    console.log("\n[2] Remit the taxes → liability cleared, bank drawn down, JE balances");
    // ------------------------------------------------------------------------
    const payment = await run(() => storage.payPayrollLiabilities({
      payDate: "2026-01-31", bankAccountId: bank.id, memo: "Federal 941 deposit",
      lines: [{ accountId: taxesPayable.id, amountCents: owed }],
    } as any));
    check("remittance total = amount owed", payment.totalCents === owed, String(payment.totalCents));

    const je = (await pool.query(
      `SELECT jl.account_id AS "accountId", jl.debit, jl.credit FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id WHERE je.id = $1`, [payment.entryId]
    )).rows as Array<{ accountId: number; debit: number; credit: number }>;
    const dr = je.reduce((s, r) => s + Number(r.debit), 0);
    const cr = je.reduce((s, r) => s + Number(r.credit), 0);
    check("remittance JE balances (Dr = Cr = owed)", dr === owed && cr === owed, `dr ${dr} cr ${cr}`);
    check("Dr Payroll Taxes Payable (clears the liability)", je.some((r) => r.accountId === taxesPayable.id && Number(r.debit) === owed));
    check("Cr Bank (cash out)", je.some((r) => r.accountId === bank.id && Number(r.credit) === owed));

    const liabsAfter = await run(() => storage.payrollLiabilityBalances("2026-01-31"));
    check("Payroll Taxes Payable is now zero", liabsAfter.find((l) => l.code === "2300")!.balanceCents === 0);
    const bankAfterRemit = (await run(() => storage.accountBalances("2026-01-31"))).get(bank.id)!.balance;
    check("bank reduced by the remitted amount", bankAfterRemit === bankAfterPayroll - owed, `${bankAfterRemit} vs ${bankAfterPayroll - owed}`);

    // ------------------------------------------------------------------------
    console.log("\n[3] Pay stub shows the paycheck breakdown + YTD");
    // ------------------------------------------------------------------------
    const stub = await run(() => storage.getPayStub(draft.id, emp.id));
    check("stub gross = $2,000 (200000¢)", stub.item.grossCents === 200_000, String(stub.item.grossCents));
    check("stub net = $1,647 (164700¢)", stub.item.netCents === 164_700, String(stub.item.netCents));
    check("stub shows employee name", stub.employee.name === "Dana Salary");
    check("stub YTD gross reflects the single posted run (200000¢)", stub.ytd.grossCents === 200_000, String(stub.ytd.grossCents));
    check("stub YTD net reflects the single posted run (164700¢)", stub.ytd.netCents === 164_700, String(stub.ytd.netCents));

    await pool.end();
  } finally {
    await shutdown();
  }

  if (failures) {
    console.error(`\n❌ ${failures} payroll-liability check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll payroll liability & pay-stub tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
