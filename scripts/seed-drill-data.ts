// ============================================================================
// seed-drill-data — apply migrations + a small balanced ledger
// ============================================================================
// Bootstraps a fresh database so the restore drill has something real to dump,
// restore, and verify. Applies every migration (same runner as boot), then
// inserts one balanced org/entry if the ledger is empty. Idempotent.
//
// Usage:  DATABASE_URL=postgres://… npx tsx scripts/seed-drill-data.ts
// ============================================================================

import pg from "pg";
import { runMigrations } from "../server/storage";

await runMigrations();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_lines`);
  if (rows[0].n === 0) {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Drill Co', 'drill-co')
                      ON CONFLICT (slug) DO NOTHING`);
    const orgId = (await pool.query(`SELECT id FROM organizations WHERE slug = 'drill-co'`)).rows[0].id;
    await pool.query(
      `INSERT INTO accounts (org_id, code, name, type) VALUES ($1,'1000','Cash','asset'),($1,'4000','Sales','income')
       ON CONFLICT (org_id, code) DO NOTHING`, [orgId]);
    const accs = (await pool.query(`SELECT id, code FROM accounts WHERE org_id = $1 AND code IN ('1000','4000')`, [orgId])).rows;
    const cash = accs.find((a: any) => a.code === "1000").id;
    const sales = accs.find((a: any) => a.code === "4000").id;
    const entryId = (await pool.query(
      `INSERT INTO journal_entries (org_id, date, source, memo) VALUES ($1,'2026-01-01','manual','drill seed') RETURNING id`, [orgId])).rows[0].id;
    await pool.query(
      `INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES ($1,$2,$3,10000,0),($1,$2,$4,0,10000)`,
      [orgId, entryId, cash, sales]);
    console.log("seed-drill-data: inserted one balanced org/entry.");
  } else {
    console.log(`seed-drill-data: ledger already has ${rows[0].n} lines — leaving as-is.`);
  }
} finally {
  await pool.end();
}
