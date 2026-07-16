// ============================================================================
// SECURITY HARDENING (P5.4)
// ============================================================================
// Proves the session/cookie/secret hardening against a real Postgres:
//   A. __Host- cookie prefix + Secure in production; bare name in dev; the
//      session/CSRF cookies always carry HttpOnly(session)/Path=/.
//   B. Boot guard: a well-known weak APP_ENCRYPTION_KEY is refused in production
//      unless ALLOW_INSECURE_DEFAULTS=1; a real key and non-prod are fine.
//   C. Session rotation on privilege change: rotateSession issues a NEW id and
//      invalidates the OLD one.
//   D. Absolute session lifetime: a session older than the cap is expired on
//      read even if its rolling expiry is still in the future.
//   E. "Sign out all others": revokeOtherSessionsForUser drops every other
//      session but keeps the current one.
//
// Run: tsx tests/security_hardening_test.ts
// ============================================================================

import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};
function withEnv(key: string, val: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { fn(); } finally { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; }
}
// Minimal Set-Cookie capture.
function fakeRes() {
  const headers: Record<string, any> = {};
  return { setHeader: (k: string, v: any) => { headers[k] = v; }, headers };
}

async function main() {
  const { pool, cleanup } = await setupTestDb("security_hardening");
  // Import server modules AFTER the harness has pointed storage at the test DB.
  const auth = await import("../server/auth");
  const csrf = await import("../server/csrf");
  const vault = await import("../server/crypto-vault");
  try {
    console.log("Test: security hardening");

    // --- A. Cookie prefixing ---------------------------------------------
    withEnv("NODE_ENV", "production", () => {
      check("session cookie name is __Host- in prod", auth.sessionCookieName() === "__Host-ll_session");
      check("csrf cookie name is __Host- in prod", csrf.csrfCookieName() === "__Host-ll_csrf");
      const res = fakeRes();
      auth.setSessionCookie(res as any, "sid-123");
      const setCookie: string[] = res.headers["Set-Cookie"];
      const sessionCookie = setCookie[0];
      const csrfCookie = setCookie[1];
      check("prod session cookie has __Host- + Secure + HttpOnly + Path=/",
        /^__Host-ll_session=/.test(sessionCookie) && /Secure/.test(sessionCookie) &&
        /HttpOnly/.test(sessionCookie) && /Path=\//.test(sessionCookie), sessionCookie);
      check("prod csrf cookie has __Host- + Secure (not HttpOnly)",
        /^__Host-ll_csrf=/.test(csrfCookie) && /Secure/.test(csrfCookie) && !/HttpOnly/.test(csrfCookie), csrfCookie);
      const clr = fakeRes();
      auth.clearSessionCookie(clr as any);
      check("prod clear cookie keeps Secure (valid __Host- delete)", /Secure/.test(clr.headers["Set-Cookie"][0]));
    });
    withEnv("NODE_ENV", "development", () => {
      check("session cookie name is bare in dev", auth.sessionCookieName() === "ll_session");
      const res = fakeRes();
      auth.setSessionCookie(res as any, "sid-123");
      check("dev session cookie is bare, no Secure", /^ll_session=/.test(res.headers["Set-Cookie"][0]) && !/Secure/.test(res.headers["Set-Cookie"][0]));
    });

    // --- B. Weak-key boot guard ------------------------------------------
    const ZERO = "0".repeat(64);
    const STRONG = "a3f1".repeat(16); // 64 hex chars, not a placeholder
    withEnv("NODE_ENV", "production", () => withEnv("ALLOW_INSECURE_DEFAULTS", undefined, () => withEnv("APP_ENCRYPTION_KEY", ZERO, () => {
      let threw = false;
      try { vault.assertEncryptionKey(); } catch { threw = true; }
      check("weak key refused in production", threw);
    })));
    withEnv("NODE_ENV", "production", () => withEnv("ALLOW_INSECURE_DEFAULTS", "1", () => withEnv("APP_ENCRYPTION_KEY", ZERO, () => {
      let threw = false;
      try { vault.assertEncryptionKey(); } catch { threw = true; }
      check("weak key allowed with ALLOW_INSECURE_DEFAULTS=1", !threw);
    })));
    withEnv("NODE_ENV", "production", () => withEnv("APP_ENCRYPTION_KEY", STRONG, () => {
      let threw = false;
      try { vault.assertEncryptionKey(); } catch { threw = true; }
      check("real key boots in production", !threw);
    }));
    withEnv("NODE_ENV", "development", () => withEnv("APP_ENCRYPTION_KEY", ZERO, () => {
      let threw = false;
      try { vault.assertEncryptionKey(); } catch { threw = true; }
      check("weak key tolerated in non-production", !threw);
    }));

    // --- Seed a user for the DB-backed session tests ---------------------
    const userId = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ('sec@test.dev','x','Sec Tester') RETURNING id`
    )).rows[0].id as number;
    const req: any = { ip: "10.0.0.9", socket: {}, get: () => "sec-test-agent" };

    // --- C. Rotation invalidates the old id ------------------------------
    const s1 = await auth.createSession(userId, null, req);
    const rotated = await auth.rotateSession(s1.id, userId, 7, req);
    check("rotation returns a NEW id", rotated.id !== s1.id);
    check("old session is gone after rotation", (await auth.getSession(s1.id)) === undefined);
    check("new session resolves and carries new org", (await auth.getSession(rotated.id))?.activeOrgId === 7);

    // --- D. Absolute lifetime --------------------------------------------
    const staleId = "stale" + "0".repeat(59);
    await pool.query(
      `INSERT INTO sessions (id, user_id, active_org_id, expires_at, created_at, last_seen_at)
       VALUES ($1, $2, NULL, $3, $4, now())`,
      [staleId, userId,
       new Date(Date.now() + 86400_000).toISOString(),      // rolling expiry: tomorrow (NOT expired)
       new Date(Date.now() - 31 * 86400_000).toISOString()] // created 31 days ago (> 30d cap)
    );
    check("session past the absolute lifetime is expired on read", (await auth.getSession(staleId)) === undefined);
    check("stale session row is deleted on read", (await pool.query(`SELECT 1 FROM sessions WHERE id=$1`, [staleId])).rowCount === 0);

    // --- E. Sign out all others ------------------------------------------
    const a = await auth.createSession(userId, null, req);
    const b = await auth.createSession(userId, null, req);
    const cur = await auth.createSession(userId, null, req);
    const revoked = await auth.revokeOtherSessionsForUser(userId, cur.id);
    check("revoke-others removed the other live sessions", revoked >= 2);
    check("current session survives", (await auth.getSession(cur.id)) !== undefined);
    check("a sibling session is gone", (await auth.getSession(a.id)) === undefined && (await auth.getSession(b.id)) === undefined);
  } finally {
    await cleanup();
  }
  if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
  console.log("\nAll security-hardening checks passed ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
