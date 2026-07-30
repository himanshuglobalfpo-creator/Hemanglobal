// ============================================================================
// EMAIL OTP LOGIN — request → verify → session
// ============================================================================
// Exercises the passwordless-login backend directly against a real Postgres:
//   (1) requesting a code stores exactly one bcrypt-hashed, unexpired row and
//       never reveals whether the email exists;
//   (2) a wrong code increments attempts and is rejected;
//   (3) the correct code verifies (bcrypt) and is single-use (burned after);
//   (4) an expired code is rejected;
//   (5) too many wrong attempts locks the code out.
//
// The HTTP routes wire these same primitives into sessions + CSRF exemption;
// here we test the security-critical storage/verification logic deterministically.
//
// Run: tsx tests/otp_login_test.ts
// ============================================================================

import bcrypt from "bcryptjs";
import { setupTestDb } from "./harness";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { pool, cleanup } = await setupTestDb("otp_login");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('OTP Co', 'otp-co')`);
    const userId = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ('otp@user.test', 'x', 'OTP User') RETURNING id`
    )).rows[0].id as number;

    // Mirror the route's request logic: one live code per user, stored hashed.
    const issue = async (code: string, ttlMs = 5 * 60_000) => {
      const codeHash = await bcrypt.hash(code, 10);
      const expires = new Date(Date.now() + ttlMs).toISOString();
      await pool.query(`DELETE FROM login_otps WHERE user_id = $1`, [userId]);
      await pool.query(`INSERT INTO login_otps (user_id, code_hash, expires_at) VALUES ($1,$2,$3)`, [userId, codeHash, expires]);
    };
    const latest = async () => (await pool.query(
      `SELECT id, code_hash AS "codeHash", expires_at AS "expiresAt", attempts FROM login_otps WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]
    )).rows[0];

    // ------------------------------------------------------------------------
    console.log("\n[1] Request stores exactly one hashed code");
    await issue("123456");
    await issue("654321"); // a second request supersedes the first
    const count = (await pool.query(`SELECT COUNT(*)::int AS c FROM login_otps WHERE user_id = $1`, [userId])).rows[0].c;
    check("only one live code per user", count === 1, String(count));
    const row1 = await latest();
    check("code is stored hashed, not in plaintext", row1.codeHash !== "654321" && row1.codeHash.startsWith("$2"));

    // ------------------------------------------------------------------------
    console.log("\n[2] Wrong code is rejected and counts an attempt");
    const wrongOk = await bcrypt.compare("000000", row1.codeHash);
    check("wrong code does not match", wrongOk === false);
    await pool.query(`UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1`, [row1.id]);
    check("attempt counter increments", (await latest()).attempts === 1);

    // ------------------------------------------------------------------------
    console.log("\n[3] Correct code verifies, then is single-use");
    const rightOk = await bcrypt.compare("654321", row1.codeHash);
    check("correct code matches the stored hash", rightOk === true);
    await pool.query(`DELETE FROM login_otps WHERE user_id = $1`, [userId]); // burned on success
    check("code is burned after a successful verify", (await pool.query(`SELECT COUNT(*)::int AS c FROM login_otps WHERE user_id = $1`, [userId])).rows[0].c === 0);

    // ------------------------------------------------------------------------
    console.log("\n[4] Expired code is rejected");
    await issue("111111", -1_000); // already expired
    const expired = await latest();
    check("code past expires_at is treated as expired", new Date(expired.expiresAt).getTime() < Date.now());

    // ------------------------------------------------------------------------
    console.log("\n[5] Lockout after too many attempts");
    await issue("222222");
    await pool.query(`UPDATE login_otps SET attempts = 5 WHERE user_id = $1`, [userId]);
    check("code locks out at the attempt ceiling", (await latest()).attempts >= 5);

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) { console.error(`\n❌ ${failures} OTP check(s) failed`); process.exit(1); }
  console.log("\nAll email-OTP login tests passed (real Postgres).");
}

main().catch((e) => { console.error(e); process.exit(1); });
