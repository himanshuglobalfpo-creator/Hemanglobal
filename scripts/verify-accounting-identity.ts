// ============================================================================
// verify-accounting-identity — assert double-entry invariants on a database
// ============================================================================
// Usage:  VERIFY_DATABASE_URL=postgres://… npx tsx scripts/verify-accounting-identity.ts
//         (falls back to DATABASE_URL if VERIFY_DATABASE_URL is unset)
//
// Exit 0 = every invariant holds; exit 1 = at least one failed. This is the
// gate scripts/restore-drill.sh runs against a freshly-restored scratch DB, so
// a backup is only accepted once its recovered ledger is proven consistent.
// ============================================================================

import pg from "pg";
import { checkAccountingIdentity } from "../server/db-integrity";

const url = process.env.VERIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("verify-accounting-identity: set VERIFY_DATABASE_URL (or DATABASE_URL)");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });
try {
  const r = await checkAccountingIdentity(pool);
  console.log(`Checked ${r.stats.orgs} org(s), ${r.stats.entries} entries, ${r.stats.lines} lines.`);
  if (r.ok) {
    console.log("✅ Accounting identity holds — books balance, no orphans, integer cents.");
    process.exit(0);
  }
  console.error("❌ Accounting identity FAILED:");
  for (const f of r.failures) console.error(`   • [${f.check}] ${f.detail}`);
  process.exit(1);
} finally {
  await pool.end();
}
