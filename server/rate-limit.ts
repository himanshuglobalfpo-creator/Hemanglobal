// ============================================================================
// RATE LIMITING
// ============================================================================
// In-memory fixed-window limiter. Single-process by design — if the app is
// ever scaled to multiple instances, replace the Map with Redis (the
// interface below stays the same).
//
// Keying: by default per-IP. A limiter can supply keyFn(req) to key on
// something else — the write limiter keys on `${req.user?.id ?? req.ip}` so
// an authenticated user's budget follows them across IPs, and unauthenticated
// traffic still degrades gracefully to per-IP.

import type { Request, Response } from "express";

export type RateLimiter = (req: Request, res: Response, next: () => void) => void;

export function makeRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyFn?: (req: Request) => string;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  // Periodic cleanup so the map doesn't grow unbounded
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets.entries()) if (v.resetAt < now) buckets.delete(k);
  }, opts.windowMs);
  // unref so the timer doesn't keep the process alive during shutdown
  if (typeof interval.unref === "function") interval.unref();

  return (req, res, next) => {
    const rawKey = opts.keyFn
      ? opts.keyFn(req)
      : (req.ip || req.socket?.remoteAddress || "unknown").toString();
    const key = `${opts.keyPrefix}:${rawKey}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > opts.max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
      return;
    }
    next();
  };
}

// Keys the limiter on the authenticated user, falling back to IP for
// unauthenticated requests. Mount AFTER attachSession so req.user exists.
const perUserKey = (req: Request) => String(req.user?.id ?? req.ip ?? "unknown");

// Public invoice-share pages: generous enough for legit views, strict enough
// that valid tokens can't be trivially scanned for.
export const publicLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, keyPrefix: "public" });

// Credential endpoints (login / signup / password reset): tight window. The
// per-account lockout in auth.ts covers targeted attacks on one user; this
// covers spraying across many users from one IP.
export const authLimiter = makeRateLimiter({ windowMs: 15 * 60_000, max: 30, keyPrefix: "auth" });

// Authenticated write routes: 120 mutations/minute per user. Generous for any
// human workflow, tight enough to stop a runaway script or scraped-session
// abuse from hammering the ledger.
export const writeLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 120,
  keyPrefix: "write",
  keyFn: perUserKey,
});

// Bank-transaction import is the heaviest single endpoint (bulk insert + rule
// engine over every row): 10/min per user.
export const importLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 10,
  keyPrefix: "import",
  keyFn: perUserKey,
});
