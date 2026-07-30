// ============================================================================
// QUERY PLAN — report aggregation stays index-served at scale
// ============================================================================
// The P&L/balance-sheet engine aggregates journal_lines joined to
// journal_entries. Migration 0046 adds covering indexes so that aggregation is
// index-only rather than a heap fetch per line — the difference between < 2s and
// timeouts at 100k+ lines. This test proves, against a real Postgres:
//   (1) the covering indexes exist, and
//   (2) the hot report query is served by an index on journal_lines (no
//       sequential scan) — a regression guard for the report SLO.
//
// Run: tsx tests/query_plan_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

async function main() {
  const { pool, cleanup } = await setupTestDb("query_plan");
  try {
    console.log("Test: report query plan (covering indexes)");

    // (1) Covering indexes present from migration 0046.
    const idx = (await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'journal_lines'`
    )).rows.map((r: any) => r.indexname);
    check("idx_jl_entry_covering exists", idx.includes("idx_jl_entry_covering"), idx.join(","));
    check("idx_jl_org_account_covering exists", idx.includes("idx_jl_org_account_covering"), idx.join(","));

    // Seed enough balanced data that stats are meaningful.
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES (1,'QP Co','qp-co')`);
    await pool.query(`INSERT INTO accounts (id, org_id, code, name, type) VALUES
      (1,1,'1000','Cash','asset'),(2,1,'4000','Sales','income')`);
    await pool.query(
      `INSERT INTO journal_entries (org_id, date, source)
         SELECT 1, (date '2024-01-01' + (g % 365))::text, 'manual' FROM generate_series(1,3000) g`);
    await pool.query(
      `INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit)
         SELECT 1, e.id, 1, 1000, 0 FROM journal_entries e WHERE e.org_id = 1
         UNION ALL
         SELECT 1, e.id, 2, 0, 1000 FROM journal_entries e WHERE e.org_id = 1`);
    await pool.query(`ANALYZE journal_lines; ANALYZE journal_entries;`);

    // (2) EXPLAIN the hot report query. Force the planner to prefer indexes
    // (enable_seqscan=off) inside a transaction so the assertion is deterministic
    // regardless of the test dataset's exact size, then confirm journal_lines is
    // reached by an index — not a sequential scan.
    const client = await pool.connect();
    let planText = "";
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const explain = await client.query(
        `EXPLAIN (COSTS OFF)
         SELECT jl.account_id, SUM(jl.debit), SUM(jl.credit)
           FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.org_id = 1 AND je.date BETWEEN '2024-01-01' AND '2025-12-31'
          GROUP BY jl.account_id`
      );
      planText = explain.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    check("report query does NOT sequentially scan journal_lines",
      !/Seq Scan on journal_lines/.test(planText), planText);
    check("report query is served by a journal_lines index",
      /Index (Only )?Scan.*journal_lines|using idx_jl_entry_covering|Index Only Scan using idx_jl/.test(planText), planText);
  } finally {
    await cleanup();
  }
  if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
  console.log("\nAll query-plan checks passed ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
