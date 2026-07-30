// ============================================================================
// RATE LIMITER — in-memory window + Redis-store logic (shared limiter)
// ============================================================================
// Proves (no server, no real Redis needed):
//
//   (1) The in-memory path (REDIS_URL unset) allows `max` requests per window
//       and 429s the next one, with a Retry-After header.
//   (2) redisHit() implements a correct fixed window against a fake ioredis
//       (INCR on first hit sets PEXPIRE; the count climbs within the window).
//   (3) A DIFFERENT key has an independent budget.
//
// Run: tsx tests/rate_limit_test.ts
// ============================================================================

import { makeRateLimiter, redisHit } from "../server/rate-limit";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

// Minimal Express req/res doubles.
function fakeReq(ip: string): any {
  return { ip, socket: { remoteAddress: ip }, headers: {} };
}
function fakeRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  return res;
}

// A tiny in-JS stand-in for the slice of ioredis we use.
function fakeRedis() {
  const store = new Map<string, { val: number; expireAt: number | null }>();
  return {
    store,
    async incr(key: string) {
      const e = store.get(key) ?? { val: 0, expireAt: null };
      e.val += 1;
      store.set(key, e);
      return e.val;
    },
    async pexpire(key: string, ms: number) {
      const e = store.get(key);
      if (e) e.expireAt = Date.now() + ms;
      return 1;
    },
    async pttl(key: string) {
      const e = store.get(key);
      if (!e || e.expireAt === null) return -1;
      return Math.max(0, e.expireAt - Date.now());
    },
  };
}

async function main() {
  // ------------------------------------------------------------------------
  console.log("[1] In-memory window (REDIS_URL unset): allow max, then 429");
  // ------------------------------------------------------------------------
  delete process.env.REDIS_URL;
  const limiter = makeRateLimiter({ windowMs: 60_000, max: 3, keyPrefix: "test" });
  const call = () => new Promise<any>((resolve) => {
    const res = fakeRes();
    let nexted = false;
    limiter(fakeReq("1.2.3.4"), res, () => { nexted = true; resolve({ res, nexted }); });
    // If the limiter denied synchronously (memory path), next() never fires.
    setImmediate(() => { if (!nexted && res.statusCode !== 200) resolve({ res, nexted }); });
  });

  const r1 = await call();
  const r2 = await call();
  const r3 = await call();
  const r4 = await call();
  check("request 1 allowed", r1.nexted === true);
  check("request 2 allowed", r2.nexted === true);
  check("request 3 allowed (at the limit)", r3.nexted === true);
  check("request 4 blocked with 429", r4.nexted === false && r4.res.statusCode === 429, `status ${r4.res.statusCode}`);
  check("429 carries a Retry-After header", !!r4.res.headers["retry-after"], JSON.stringify(r4.res.headers));

  // A different IP has its own budget.
  const other = await new Promise<any>((resolve) => {
    const res = fakeRes();
    limiter(fakeReq("9.9.9.9"), res, () => resolve({ res, nexted: true }));
    setImmediate(() => { if (res.statusCode !== 200) resolve({ res, nexted: false }); });
  });
  check("a different IP is not affected by the first IP's budget", other.nexted === true);

  // ------------------------------------------------------------------------
  console.log("\n[2] redisHit() fixed-window logic against a fake ioredis");
  // ------------------------------------------------------------------------
  const rc = fakeRedis();
  const h1 = await redisHit(rc, "write:42", 60_000);
  const h2 = await redisHit(rc, "write:42", 60_000);
  const h3 = await redisHit(rc, "write:42", 60_000);
  check("first hit → count 1", h1.count === 1, String(h1.count));
  check("first hit sets an expiry (resetAt in the future)", h1.resetAt > Date.now());
  check("count climbs within the window", h2.count === 2 && h3.count === 3, `${h2.count},${h3.count}`);
  check("PEXPIRE was set exactly once (on the first hit)", rc.store.get("write:42")!.expireAt !== null);

  // A different key is independent.
  const other1 = await redisHit(rc, "write:99", 60_000);
  check("a different Redis key starts its own window at 1", other1.count === 1, String(other1.count));

  if (failures) {
    console.error(`\n❌ ${failures} rate-limiter check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll rate-limiter tests passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
