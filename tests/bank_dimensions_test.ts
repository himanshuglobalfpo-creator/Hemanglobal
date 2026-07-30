// ============================================================================
// BANK TRANSACTION DIMENSIONS (class / location / project)
// ============================================================================
// Proves, against a real Postgres, that categorizing a bank transaction with
// dimensions tags the posted journal lines so dimension-filtered reports see it:
//
//   (1) Categorize a withdrawal with a class + project → both journal lines
//       carry class_id and project_id.
//   (2) P&L filtered by that class includes the expense; by that project too.
//   (3) P&L filtered by a DIFFERENT class excludes it (the filter really bites).
//   (4) A manual bank entry carries dimensions the same way.
//   (5) An out-of-org dimension id is rejected (assertDimensions org-scoping).
//
// Run: tsx tests/bank_dimensions_test.ts
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
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("bank_dimensions");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Dim Co', 'dim-co')`);
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Rival Co', 'rival-dim-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('d@d.test', 'x', 'Dim Tester')`);
    await seedOrgDefaults(1);
    await seedOrgDefaults(2);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const expense = accts.find((a) => a.code === "6000")!;

    // Dimensions in org 1, plus a foreign one in org 2 for the rejection test.
    const northClass = await run(() => storage.createClass({ name: "North" } as any));
    const southClass = await run(() => storage.createClass({ name: "South" } as any));
    const roofJob = await run(() => storage.createProject({ name: "Roof Job" } as any));
    const foreignClassId = (await pool.query(`INSERT INTO classes (org_id,name) VALUES (2,'Foreign') RETURNING id`)).rows[0].id as number;

    const mkTxn = async (desc: string, amount: number) =>
      (await pool.query(
        `INSERT INTO bank_transactions (org_id, bank_account_id, date, description, amount, source) VALUES (1,$1,'2026-05-01',$2,$3,'manual') RETURNING id`,
        [bank.id, desc, amount]
      )).rows[0].id as number;

    // ------------------------------------------------------------------------
    console.log("\n[1] Categorize a withdrawal with class + project → lines tagged");
    // ------------------------------------------------------------------------
    const t1 = await mkTxn("SUPPLIES", -12000); // $120 out
    const m1 = await run(() => storage.matchBankTransaction({
      bankTransactionId: t1, matchType: "categorize", categoryAccountId: expense.id,
      classId: northClass.id, projectId: roofJob.id,
    } as any));
    check("transaction matched", m1.status === "matched");
    const lines1 = (await pool.query(
      `SELECT account_id, class_id, project_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [(m1 as any).entryId]
    )).rows;
    check("both journal lines carry class_id = North", lines1.every((l: any) => l.class_id === northClass.id), JSON.stringify(lines1));
    check("both journal lines carry project_id = Roof Job", lines1.every((l: any) => l.project_id === roofJob.id), JSON.stringify(lines1));
    const expLine = lines1.find((l: any) => l.account_id === expense.id)!;
    check("expense line debited $120", Number(expLine.debit) === 12000, JSON.stringify(expLine));

    // ------------------------------------------------------------------------
    console.log("\n[2] P&L filtered by that class / project includes the expense");
    // ------------------------------------------------------------------------
    const plNorth = await run(() => storage.profitAndLoss("2026-01-01", "2026-12-31", { classId: northClass.id }));
    const eNorth = plNorth.expenses.find((r: any) => r.accountId === expense.id);
    check("P&L by class=North includes the $120 expense", !!eNorth && eNorth.amount === 12000, JSON.stringify(plNorth.expenses));

    const plRoof = await run(() => storage.profitAndLoss("2026-01-01", "2026-12-31", { projectId: roofJob.id }));
    const eRoof = plRoof.expenses.find((r: any) => r.accountId === expense.id);
    check("P&L by project=Roof Job includes the $120 expense", !!eRoof && eRoof.amount === 12000, JSON.stringify(plRoof.expenses));

    // ------------------------------------------------------------------------
    console.log("\n[3] P&L filtered by a different class excludes it");
    // ------------------------------------------------------------------------
    const plSouth = await run(() => storage.profitAndLoss("2026-01-01", "2026-12-31", { classId: southClass.id }));
    const eSouth = plSouth.expenses.find((r: any) => r.accountId === expense.id);
    check("P&L by class=South excludes the North expense", !eSouth, JSON.stringify(plSouth.expenses));

    // ------------------------------------------------------------------------
    console.log("\n[4] Manual bank entry carries dimensions too");
    // ------------------------------------------------------------------------
    const m4 = await run(() => storage.postManualBankTransaction({
      bankAccountId: bank.id, date: "2026-05-02", description: "Rent", amount: -50000,
      kind: "withdrawal", categoryAccountId: expense.id, classId: southClass.id,
    } as any));
    const lines4 = (await pool.query(`SELECT class_id FROM journal_lines WHERE entry_id = $1`, [(m4 as any).entryId])).rows;
    check("manual-entry lines carry class_id = South", lines4.length === 2 && lines4.every((l: any) => l.class_id === southClass.id), JSON.stringify(lines4));

    // ------------------------------------------------------------------------
    console.log("\n[5] Out-of-org dimension id is rejected");
    // ------------------------------------------------------------------------
    const t5 = await mkTxn("BAD DIM", -100);
    await expectReject("categorizing with another org's class fails",
      () => run(() => storage.matchBankTransaction({
        bankTransactionId: t5, matchType: "categorize", categoryAccountId: expense.id, classId: foreignClassId,
      } as any)),
      /Unknown class id/i);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} bank-dimensions check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll bank-transaction dimension tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
