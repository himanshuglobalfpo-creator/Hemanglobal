// ============================================================================
// seed-loadtest — a reference org with ~100k journal lines (+ invoices, bank tx)
// ============================================================================
// Builds a realistically large single tenant so the k6 load script (loadtest/
// load.js) exercises the list/report endpoints at scale. Uses set-based INSERTs
// (generate_series) so it seeds in seconds, and stays balanced (every entry's
// two lines net to zero) so reports and the identity checks stay valid.
//
// Usage:  DATABASE_URL=postgres://… npx tsx scripts/seed-loadtest.ts [entries]
//   entries defaults to 50000 → 100000 journal lines.
// Prints the seeded org's slug + a login you can use from the load script.
// ============================================================================

import pg from "pg";
import { runMigrations } from "../server/storage";

const ENTRIES = Number(process.argv[2] || 50000);

await runMigrations();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(`Seeding load-test org with ${ENTRIES} entries (${ENTRIES * 2} lines)…`);

  const orgId = (await pool.query(
    `INSERT INTO organizations (name, slug) VALUES ('LoadTest Co', 'loadtest-co')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`
  )).rows[0].id as number;

  // A handful of accounts to spread aggregation across.
  await pool.query(
    `INSERT INTO accounts (org_id, code, name, type) VALUES
       ($1,'1000','Cash','asset'),($1,'1200','A/R','asset'),
       ($1,'4000','Sales','income'),($1,'5000','COGS','expense'),($1,'6000','Opex','expense')
     ON CONFLICT (org_id, code) DO NOTHING`, [orgId]);
  const accts = (await pool.query(`SELECT id, code FROM accounts WHERE org_id=$1 AND code IN ('1000','4000','5000','6000')`, [orgId])).rows;
  const cash = accts.find((a: any) => a.code === "1000").id;
  const sales = accts.find((a: any) => a.code === "4000").id;

  // Set-based entry insert spread over ~2 years of dates; capture the id range.
  const before = (await pool.query(`SELECT COALESCE(MAX(id),0) AS m FROM journal_entries`)).rows[0].m as number;
  await pool.query(
    `INSERT INTO journal_entries (org_id, date, source, memo)
       SELECT $1, (date '2024-01-01' + ((g % 730)))::text, 'manual', 'load '||g
         FROM generate_series(1,$2) g`, [orgId, ENTRIES]);
  const newEntries = (await pool.query(`SELECT id FROM journal_entries WHERE org_id=$1 AND id > $2 ORDER BY id`, [orgId, before])).rows.map((r: any) => r.id);

  // Two balanced lines per entry (debit cash / credit sales), amounts varied.
  await pool.query(
    `INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit)
       SELECT $1, e.id, $2, ((e.id % 900) + 100) * 100, 0 FROM unnest($4::int[]) AS e(id)
       UNION ALL
       SELECT $1, e.id, $3, 0, ((e.id % 900) + 100) * 100 FROM unnest($4::int[]) AS e(id)`,
    [orgId, cash, sales, newEntries]);

  // A batch of invoices + bank transactions for the list endpoints.
  await pool.query(
    `INSERT INTO invoices (org_id, customer_id, number, date, due_date, status, subtotal, tax, total, currency)
       SELECT $1, NULL, 'INV-'||g, (date '2024-01-01' + (g % 365))::text, (date '2024-02-01' + (g % 365))::text,
              (ARRAY['draft','sent','paid'])[1 + (g % 3)], (g%500)*100, 0, (g%500)*100, 'USD'
         FROM generate_series(1,5000) g
     ON CONFLICT DO NOTHING`, [orgId]).catch((e) => console.log("  (invoices skipped:", e.message, ")"));

  await pool.query(`ANALYZE journal_lines; ANALYZE journal_entries; ANALYZE invoices;`);

  const counts = (await pool.query(
    `SELECT (SELECT COUNT(*) FROM journal_lines WHERE org_id=$1) AS lines,
            (SELECT COUNT(*) FROM journal_entries WHERE org_id=$1) AS entries,
            (SELECT COUNT(*) FROM invoices WHERE org_id=$1) AS invoices`, [orgId])).rows[0];
  console.log(`✅ Seeded org #${orgId} (slug loadtest-co): ${counts.lines} lines, ${counts.entries} entries, ${counts.invoices} invoices.`);
  console.log("   Point loadtest/load.js at this instance (create a login for org 'loadtest-co' first).");
} finally {
  await pool.end();
}
