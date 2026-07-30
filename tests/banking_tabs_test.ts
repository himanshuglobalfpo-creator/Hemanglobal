// ============================================================================
// BANKING PAGE — tabs, category enrichment, account summaries, undo
// ============================================================================
// Drives the exact flow the rebuilt Banking page relies on, against a real
// Postgres:
//
//   (1) Import 3 transactions → all land in For Review (status 'unmatched'),
//       and the account summary reports ledger balance, a review count of 3,
//       and a real last-import date.
//   (2) Categorize one → it moves to 'matched' and the list surfaces the
//       category name derived from the matched JE's non-bank line.
//   (3) Exclude one → it moves to 'ignored'.
//   (4) Each status-filtered list returns exactly the right rows (the three
//       tabs). Trial balance stays balanced.
//   (5) Undo the categorized and the excluded rows → both return to
//       'unmatched' (For Review), the JE is gone, and TB is still balanced.
//
// Run: tsx tests/banking_tabs_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const balanced = (tb: { totalDebit: number; totalCredit: number }) => tb.totalDebit === tb.totalCredit;

async function main() {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("banking_tabs");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Tabs Co', 'tabs-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('t@t.test', 'x', 'Tabs Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const bank = accts.find((a) => a.code === "1000")!;
    const expense = accts.find((a) => a.code === "6000")!;

    // ------------------------------------------------------------------------
    console.log("\n[1] Import 3 transactions → all in For Review + summary");
    // ------------------------------------------------------------------------
    const imp = await run(() => storage.importBankTransactions({
      bankAccountId: bank.id, source: "csv",
      transactions: [
        { date: "2026-06-01", description: "OFFICE SUPPLIES", amount: -80 },
        { date: "2026-06-02", description: "SOFTWARE SUB", amount: -50 },
        { date: "2026-06-03", description: "BANK FEE", amount: -30 },
      ],
    } as any));
    check("3 transactions imported", imp.inserted === 3, JSON.stringify(imp));

    const review0 = await run(() => storage.listBankTransactions(bank.id, "unmatched", 50, 0));
    check("all 3 in For Review", review0.total === 3, String(review0.total));

    const sums0 = await run(() => storage.bankAccountSummaries("bank"));
    const s0 = sums0.find((x) => x.accountId === bank.id)!;
    check("summary review count = 3", s0.reviewCount === 3, String(s0.reviewCount));
    check("summary has a last-import date", !!s0.lastImportedAt, String(s0.lastImportedAt));
    check("summary ledger balance is 0 before any posting", s0.ledgerBalanceCents === 0, String(s0.ledgerBalanceCents));
    check("feed balance is null (no real feed)", s0.feedBalanceCents === null);

    const rows = review0.rows;
    const supplies = rows.find((r) => r.description === "OFFICE SUPPLIES")!;
    const software = rows.find((r) => r.description === "SOFTWARE SUB")!;

    // ------------------------------------------------------------------------
    console.log("\n[2] Categorize one → matched, with category name");
    // ------------------------------------------------------------------------
    await run(() => storage.matchBankTransaction({ bankTransactionId: supplies.id, matchType: "categorize", categoryAccountId: expense.id } as any));
    const catList = await run(() => storage.listBankTransactions(bank.id, "matched", 50, 0));
    check("1 categorized row", catList.total === 1, String(catList.total));
    check("category name derived from the matched JE's non-bank line", catList.rows[0].categoryName === expense.name, String(catList.rows[0].categoryName));

    // ------------------------------------------------------------------------
    console.log("\n[3] Exclude one → ignored");
    // ------------------------------------------------------------------------
    await run(() => storage.matchBankTransaction({ bankTransactionId: software.id, matchType: "ignore" } as any));
    const exList = await run(() => storage.listBankTransactions(bank.id, "ignored", 50, 0));
    check("1 excluded row", exList.total === 1 && exList.rows[0].id === software.id, JSON.stringify(exList.rows.map((r) => r.id)));

    // ------------------------------------------------------------------------
    console.log("\n[4] Tabs partition correctly; trial balance balanced");
    // ------------------------------------------------------------------------
    const rev = await run(() => storage.listBankTransactions(bank.id, "unmatched", 50, 0));
    check("For Review now has 1 (the untouched BANK FEE)", rev.total === 1 && rev.rows[0].description === "BANK FEE", JSON.stringify(rev.rows.map((r) => r.description)));
    const tb1 = await run(() => storage.trialBalance());
    check("trial balance balanced after categorize + exclude", balanced(tb1), JSON.stringify(tb1));
    // Categorizing a $80 withdrawal moved the ledger: expense +80, bank -80.
    const sums1 = await run(() => storage.bankAccountSummaries("bank"));
    const s1 = sums1.find((x) => x.accountId === bank.id)!;
    check("ledger balance reflects the $80 categorization", s1.ledgerBalanceCents === -8000, String(s1.ledgerBalanceCents));
    check("summary review count now 1", s1.reviewCount === 1, String(s1.reviewCount));

    // ------------------------------------------------------------------------
    console.log("\n[5] Undo both → back to For Review, TB still balanced");
    // ------------------------------------------------------------------------
    await run(() => storage.unmatchBankTransaction(supplies.id));
    await run(() => storage.unmatchBankTransaction(software.id));
    const revFinal = await run(() => storage.listBankTransactions(bank.id, "unmatched", 50, 0));
    check("all 3 back in For Review after undo", revFinal.total === 3, String(revFinal.total));
    const catFinal = await run(() => storage.listBankTransactions(bank.id, "matched", 50, 0));
    const exFinal = await run(() => storage.listBankTransactions(bank.id, "ignored", 50, 0));
    check("nothing categorized after undo", catFinal.total === 0, String(catFinal.total));
    check("nothing excluded after undo", exFinal.total === 0, String(exFinal.total));
    const tb2 = await run(() => storage.trialBalance());
    check("trial balance balanced after undo", balanced(tb2), JSON.stringify(tb2));
    const sums2 = await run(() => storage.bankAccountSummaries("bank"));
    check("ledger balance back to 0 after undo", sums2.find((x) => x.accountId === bank.id)!.ledgerBalanceCents === 0);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} banking-tabs check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll banking tabs / category / summary / undo tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
