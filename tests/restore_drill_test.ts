// ============================================================================
// RESTORE DRILL — accounting-identity verifier
// ============================================================================
// The restore drill (scripts/restore-drill.sh) restores a backup into a scratch
// DB and asserts the RECOVERED ledger still obeys double-entry via
// checkAccountingIdentity(). This test proves that verifier both ways against a
// real Postgres:
//   (1) a balanced, well-formed ledger PASSES, and
//   (2) each corruption a broken restore could produce is CAUGHT —
//       an unbalanced entry, an org whose books don't net, an orphan line, a
//       cross-org line, and negative money.
//
// Run: tsx tests/restore_drill_test.ts
// ============================================================================

import { setupTestDb } from "./harness";
import { checkAccountingIdentity } from "../server/db-integrity";

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

async function main() {
  const { pool, cleanup } = await setupTestDb("restore_drill");
  try {
    // A minimal but real balanced ledger: one org, two accounts, one entry whose
    // two lines net to zero (100.00 debit / 100.00 credit, integer cents).
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES (1, 'Drill Co', 'drill-co')`);
    await pool.query(`INSERT INTO accounts (id, org_id, code, name, type) VALUES
      (1, 1, '1000', 'Cash', 'asset'), (2, 1, '4000', 'Sales', 'income')`);
    await pool.query(`INSERT INTO journal_entries (id, org_id, date, source) VALUES (1, 1, '2026-01-01', 'manual')`);
    await pool.query(`INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES
      (1, 1, 1, 10000, 0), (1, 1, 2, 0, 10000)`);

    console.log("Test: accounting-identity verifier");
    let r = await checkAccountingIdentity(pool);
    check("balanced ledger passes", r.ok, JSON.stringify(r.failures));
    check("stats report the seeded data", r.stats.orgs === 1 && r.stats.entries === 1 && r.stats.lines === 2);

    // (1) Unbalanced entry — debit ≠ credit within an entry.
    await pool.query(`INSERT INTO journal_entries (id, org_id, date, source) VALUES (2, 1, '2026-01-02', 'manual')`);
    await pool.query(`INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES
      (1, 2, 1, 5000, 0), (1, 2, 2, 0, 4000)`); // 50.00 ≠ 40.00
    r = await checkAccountingIdentity(pool);
    check("unbalanced entry is caught", !r.ok && r.failures.some(f => f.check === "entry_balance"));
    check("global imbalance is caught", r.failures.some(f => f.check === "global_balance"));
    check("per-org imbalance is caught", r.failures.some(f => f.check === "org_balance"));
    // Repair for the next isolated case.
    await pool.query(`DELETE FROM journal_lines WHERE entry_id = 2`);
    await pool.query(`DELETE FROM journal_entries WHERE id = 2`);
    r = await checkAccountingIdentity(pool);
    check("ledger passes again after repair", r.ok, JSON.stringify(r.failures));

    // (2) Orphan line — entry_id points at a missing entry. FK constraints
    // block this in a live DB, so bypass triggers to reproduce the corrupt-restore
    // state the verifier exists to catch (session_replication_role=replica needs
    // the superuser the harness/CI connects as).
    const c = await pool.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES (1, 9999, 1, 100, 100)`);
    } finally { c.release(); }
    r = await checkAccountingIdentity(pool);
    check("orphan line is caught", r.failures.some(f => f.check === "orphan_lines"));
    await pool.query(`DELETE FROM journal_lines WHERE entry_id = 9999`);

    // (3) Cross-org line — line.org_id disagrees with its entry's org.
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES (2, 'Other', 'other-drill')`);
    await pool.query(`INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES (2, 1, 1, 0, 0)`);
    r = await checkAccountingIdentity(pool);
    check("cross-org line is caught", r.failures.some(f => f.check === "cross_org_lines"));
    await pool.query(`DELETE FROM journal_lines WHERE org_id = 2 AND entry_id = 1`);

    // (4) Negative money.
    await pool.query(`INSERT INTO journal_entries (id, org_id, date, source) VALUES (3, 1, '2026-01-03', 'manual')`);
    await pool.query(`INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES
      (1, 3, 1, -100, 0), (1, 3, 2, 0, -100)`);
    r = await checkAccountingIdentity(pool);
    check("negative money is caught", r.failures.some(f => f.check === "negative_money"));
  } finally {
    await cleanup();
  }
  if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
  console.log("\nAll restore-drill verifier checks passed ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
