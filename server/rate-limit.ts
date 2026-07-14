// ============================================================================
// RATE LIMITING
// ============================================================================
// Fixed-window limiter with a pluggable store:
//
//   • REDIS_URL set   → a shared Redis-backed store (INCR + PEXPIRE) so the
//     budget is enforced ACROSS every app instance behind a load balancer.
//   • REDIS_URL unset → the original in-memory Map (single-process). This is
//     also the automatic fallback if Redis is momentarily unreachable, so a
//     Redis blip degrades to per-instance limiting rather than failing open.
//
// The exported middlewares and their `(req, res, next)` signature are unchanged;
// the store swap is internal.
//
// Keying: by default per-IP. A limiter can supply keyFn(req) to key on
// something else — the write limiter keys on `${req.user?.id ?? req.ip}` so
// an authenticated user's budget follows them across IPs, and unauthenticated
// traffic still degrades gracefully to per-IP.

import { createRequire } from "node:module";
import type { Request, Response } from "express";
import { logger } from "./logger";

// ESM-safe require (production bundle is ESM; global `require` is absent there).
const require = createRequire(import.meta.url);

export type RateLimiter = (req: Request, res: Response, next: () => void) => void;

// A single hit against the window: the running count and when the window resets.
export interface HitResult {
  count: number;
  resetAt: number;
}

// ----------------------------------------------------------------------------
// Shared Redis client (one connection per process, reused by every limiter).
// Created lazily on first use so importing this module never opens a socket.
// `undefined` = not yet resolved; `null` = resolved to "no Redis".
// ----------------------------------------------------------------------------
let redisClient: any | null | undefined;

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "redis://***";
  }
}

function getRedis(): any | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }
  try {
    // Lazy require (kept external in the esbuild bundle), mirroring how plaid.ts
    // and stripe.ts load their optional SDKs. ioredis auto-reconnects.
     
    const Redis = require("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      // Don't buffer commands while offline — fail fast so we fall back to the
      // in-memory store instead of hanging the request.
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (e: any) => logger.warn("[rate-limit] Redis error", { error: e?.message }));
    logger.info("[rate-limit] using Redis-backed store", { url: redactUrl(url) });
    redisClient = client;
    return client;
  } catch (e: any) {
    logger.warn("[rate-limit] ioredis unavailable — using in-memory store", { error: e?.message });
    redisClient = null;
    return null;
  }
}

// Fixed-window increment in Redis. First hit of a window sets the expiry; the
// key evaporates on its own when the window closes. Pure w.r.t. the client, so
// it can be unit-tested against a fake ioredis.
export async function redisHit(client: any, key: string, windowMs: number): Promise<HitResult> {
  const count: number = await client.incr(key);
  if (count === 1) {
    await client.pexpire(key, windowMs);
    return { count, resetAt: Date.now() + windowMs };
  }
  const pttl: number = await client.pttl(key);
  const ttl = pttl > 0 ? pttl : windowMs;
  return { count, resetAt: Date.now() + ttl };
}

// In-memory fixed-window store (also the fallback when Redis errors).
function makeMemoryStore(windowMs: number) {
  const buckets = new Map<string, HitResult>();
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets.entries()) if (v.resetAt < now) buckets.delete(k);
  }, windowMs);
  if (typeof interval.unref === "function") interval.unref();

  return function hit(key: string): HitResult {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    return b;
  };
}

export function makeRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyFn?: (req: Request) => string;
}): RateLimiter {
  const memoryHit = makeMemoryStore(opts.windowMs);

  const deny = (res: Response, resetAt: number) => {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
  };

  return (req, res, next) => {
    const rawKey = opts.keyFn
      ? opts.keyFn(req)
      : (req.ip || req.socket?.remoteAddress || "unknown").toString();
    const key = `${opts.keyPrefix}:${rawKey}`;

    const apply = ({ count, resetAt }: HitResult) => {
      if (count > opts.max) deny(res, resetAt);
      else next();
    };

    const redis = getRedis();
    if (!redis) {
      apply(memoryHit(key));
      return;
    }
    redisHit(redis, key, opts.windowMs)
      .then(apply)
      .catch((err) => {
        // Redis unreachable → degrade to this instance's in-memory window
        // rather than failing open (unlimited) or 500-ing the request.
        logger.warn("[rate-limit] Redis hit failed — falling back to in-memory", { error: err?.message });
        apply(memoryHit(key));
      });
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
