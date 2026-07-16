// ============================================================================
// DB INTEGRITY — accounting invariants over a whole database
// ============================================================================
// A restore is only "proven" if the RESTORED ledger still obeys double-entry.
// These checks run over an arbitrary Postgres (a scratch DB freshly restored
// from a backup) using nothing but SQL — no org context, no app state — so the
// restore-drill can assert them against the recovered copy, and the test suite
// can assert the same function catches a deliberately-corrupted ledger.
//
// The four invariants, strongest-signal first:
//   1. Every journal entry balances: Σ debit = Σ credit within each entry.
//   2. Books balance globally AND per org: Σ debit = Σ credit.
//   3. No structural orphans: every line's entry exists and shares its org_id
//      (a mis-scoped line is a tenant-isolation breach AND a balance risk).
//   4. Money stays integer cents: no fractional or negative debit/credit.
// ============================================================================

import type { Pool } from "pg";

export interface IntegrityFailure {
  check: string;
  detail: string;
  count?: number;
}

export interface IntegrityResult {
  ok: boolean;
  failures: IntegrityFailure[];
  stats: { orgs: number; entries: number; lines: number };
}

export async function checkAccountingIdentity(pool: Pool): Promise<IntegrityResult> {
  const failures: IntegrityFailure[] = [];

  // 1. Per-entry balance — the core double-entry rule.
  const unbalanced = await pool.query(
    `SELECT entry_id, SUM(debit) AS d, SUM(credit) AS c
       FROM journal_lines GROUP BY entry_id HAVING SUM(debit) <> SUM(credit)`
  );
  if (unbalanced.rowCount! > 0) {
    const e = unbalanced.rows[0];
    failures.push({
      check: "entry_balance",
      count: unbalanced.rowCount!,
      detail: `${unbalanced.rowCount} journal entr${unbalanced.rowCount === 1 ? "y does" : "ies do"} not balance (e.g. entry ${e.entry_id}: debit ${e.d} ≠ credit ${e.c})`,
    });
  }

  // 2a. Global balance.
  const global = await pool.query(`SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines`);
  if (String(global.rows[0].d) !== String(global.rows[0].c)) {
    failures.push({ check: "global_balance", detail: `global debits ${global.rows[0].d} ≠ credits ${global.rows[0].c}` });
  }

  // 2b. Per-org balance.
  const perOrg = await pool.query(
    `SELECT org_id, SUM(debit) AS d, SUM(credit) AS c FROM journal_lines GROUP BY org_id HAVING SUM(debit) <> SUM(credit)`
  );
  if (perOrg.rowCount! > 0) {
    const o = perOrg.rows[0];
    failures.push({
      check: "org_balance",
      count: perOrg.rowCount!,
      detail: `${perOrg.rowCount} org(s) have unbalanced books (e.g. org ${o.org_id}: debit ${o.d} ≠ credit ${o.c})`,
    });
  }

  // 3a. Orphan lines — a line whose entry no longer exists.
  const orphans = await pool.query(
    `SELECT COUNT(*)::int AS n FROM journal_lines l
       LEFT JOIN journal_entries e ON e.id = l.entry_id WHERE e.id IS NULL`
  );
  if (orphans.rows[0].n > 0) {
    failures.push({ check: "orphan_lines", count: orphans.rows[0].n, detail: `${orphans.rows[0].n} journal line(s) reference a missing entry` });
  }

  // 3b. Cross-org lines — a line whose org_id disagrees with its entry's.
  const crossOrg = await pool.query(
    `SELECT COUNT(*)::int AS n FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id WHERE l.org_id <> e.org_id`
  );
  if (crossOrg.rows[0].n > 0) {
    failures.push({ check: "cross_org_lines", count: crossOrg.rows[0].n, detail: `${crossOrg.rows[0].n} journal line(s) are scoped to a different org than their entry` });
  }

  // 4. Money sanity — integer cents, never negative.
  const badMoney = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_lines WHERE debit < 0 OR credit < 0`);
  if (badMoney.rows[0].n > 0) {
    failures.push({ check: "negative_money", count: badMoney.rows[0].n, detail: `${badMoney.rows[0].n} journal line(s) carry a negative debit/credit` });
  }

  const stats = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM organizations) AS orgs,
            (SELECT COUNT(*)::int FROM journal_entries) AS entries,
            (SELECT COUNT(*)::int FROM journal_lines) AS lines`
  )).rows[0];

  return { ok: failures.length === 0, failures, stats: { orgs: stats.orgs, entries: stats.entries, lines: stats.lines } };
}
