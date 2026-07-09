// ============================================================================
// CSRF PROTECTION — double-submit cookie pattern
// ============================================================================
// How it works:
//   1. Whenever a session cookie is issued (login/signup/switch-org), we ALSO
//      set a NON-HttpOnly cookie `ll_csrf` containing 32 random bytes (hex).
//   2. The SPA reads that cookie with JS and echoes it back in an
//      `x-csrf-token` header on every state-changing request.
//   3. This middleware verifies header === cookie with a timing-safe compare.
// Why it's safe: a cross-site attacker can make the browser SEND our cookies,
// but the same-origin policy prevents them from READING ll_csrf, so they can
// never construct the matching header. HttpOnly is deliberately OFF for this
// cookie — the whole scheme depends on our own JS being able to read it.
//
// Requests authenticated via `Authorization: Bearer` are exempt: the browser
// never attaches Authorization headers automatically, so those clients are
// not CSRF-able by construction.

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const CSRF_COOKIE = "ll_csrf";
const CSRF_HEADER = "x-csrf-token";
const TOKEN_BYTES = 32; // 32 random bytes → 64 hex chars

// Methods that can change state and therefore need the token.
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Paths exempt from CSRF checks:
//  - pre-session auth endpoints (no session cookie exists yet, nothing to forge)
//  - webhooks (authenticated by provider signature over the raw body, not cookies)
const EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  // Clicked from an email link, possibly with no session at all; authenticated
  // by its own single-use secret token (same trust model as reset-password).
  "/api/auth/verify-email",
  // Pre-session: the 5-minute single-use challenge token is the credential;
  // no session cookie exists yet to forge.
  "/api/auth/mfa/verify",
  "/api/stripe/webhook",
  "/api/plaid/webhook",
]);

export function generateCsrfToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

// Builds the Set-Cookie string for the CSRF cookie. NOT HttpOnly (the client
// JS must read it); SameSite=Lax; Secure in production; Path=/ so it rides on
// every request. Lifetime matches the session cookie's order of magnitude —
// it is rotated on every login anyway.
export function buildCsrfCookie(token: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${30 * 86400}`,
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCsrfCookie(): string {
  return `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.headers.cookie || "";
  const m = cookies.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

// Constant-time equality. timingSafeEqual throws on length mismatch, so we
// guard length first — the length of a random token is not a secret.
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Express middleware. Mount AFTER attachSession (so Bearer detection and any
// future per-session token binding have what they need) and BEFORE the auth
// gate (a CSRF failure should 403 before auth logic runs).
export function csrfProtect(req: Request, res: Response, next: NextFunction): void {
  // Only /api/* state-changing requests are in scope.
  if (!req.path.startsWith("/api")) return next();
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();

  // API clients authenticate with an Authorization: Bearer header the browser
  // would never attach cross-site — exempt.
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return next();

  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.headers[CSRF_HEADER];

  if (
    !cookieToken ||
    typeof headerToken !== "string" ||
    headerToken.length === 0 ||
    !tokensEqual(cookieToken, headerToken)
  ) {
    res.status(403).json({ error: "CSRF token missing or invalid" });
    return;
  }
  next();
}
