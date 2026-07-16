// ============================================================================
// MIGRATION SAFETY — enforce the CONTRIBUTING rules mechanically
// ============================================================================
// Deploys are rolling/blue-green and migrations run at boot, so a schema change
// must be idempotent (safe to re-run / partial-then-retried) and additive in the
// same release. This static check backs the CONTRIBUTING.md rule so a
// non-idempotent or obviously-destructive migration fails CI, not production:
//   (1) filenames are unique, zero-padded, and numerically ordered,
//   (2) each migration carries an idempotency guard, and
//   (3) no bare destructive statement (DROP TABLE / DROP COLUMN / rename)
//       without an IF EXISTS guard — the shape that breaks a rolling deploy.
//
// Run: tsx tests/migration_safety_test.ts
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "pg");

// Idempotent by construction (documented in-file): a zero-match UPDATE backfill
// + a no-op `DROP DEFAULT`. No guard token, but safe to re-run.
const IDEMPOTENT_ALLOWLIST = new Set(["0003_recon_items_org_backfill.sql"]);

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
console.log(`Test: migration safety (${files.length} migrations)`);

// (1) Numbering — unique 4-digit prefixes, no gaps.
const prefixes = files.map((f) => f.slice(0, 4));
check("all filenames start with a 4-digit prefix", files.every((f) => /^\d{4}_/.test(f)), files.find((f) => !/^\d{4}_/.test(f)));
check("prefixes are unique", new Set(prefixes).size === prefixes.length);
const nums = prefixes.map(Number).sort((a, b) => a - b);
let contiguous = true;
for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) contiguous = false;
check("migration numbers are contiguous (no gaps)", contiguous, JSON.stringify(nums));

const GUARD = /IF NOT EXISTS|IF EXISTS|DO \$\$|CREATE OR REPLACE|ON CONFLICT/i;
// Destructive statements that must carry an IF EXISTS (or live inside a guarded
// DO block) — a bare one breaks the old code still running during a rolling swap.
const BARE_DESTRUCTIVE = /\b(DROP\s+TABLE|DROP\s+COLUMN|RENAME\s+(COLUMN|TO))\b(?![^;]*IF\s+EXISTS)/i;

for (const f of files) {
  const sql = fs.readFileSync(path.join(DIR, f), "utf8");
  // (2) Idempotency guard present (or allowlisted).
  check(`${f}: has an idempotency guard`, IDEMPOTENT_ALLOWLIST.has(f) || GUARD.test(sql));
  // (3) No bare destructive statement outside a guarded DO block.
  const hasDoBlock = /DO \$\$/i.test(sql);
  const bare = BARE_DESTRUCTIVE.test(sql) && !hasDoBlock;
  check(`${f}: no unguarded destructive statement`, !bare, bare ? sql.match(BARE_DESTRUCTIVE)?.[0] : undefined);
}

if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("\nAll migration-safety checks passed ✅");
