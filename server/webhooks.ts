// ============================================================================
// OUTBOUND WEBHOOKS
// ============================================================================
// Events: invoice.created/paid/voided, bill.created/paid, credit_note.issued,
// period.closed. Emission happens AFTER the business transaction commits —
// storage methods call emitWebhookEvent() outside their db.transaction, so a
// rolled-back operation can never notify the outside world.
//
// Delivery: 30s worker (unref'd interval) picks due pending/failed rows with
// attempts < 6, POSTs the EXACT stored payload with
//   x-ledgerlite-event:     <event name>
//   x-ledgerlite-signature: hex HMAC-SHA256(secret, rawBody)
// 10s fetch timeout; backoff 1m/5m/30m/2h/12h; 2xx marks success.
//
// SSRF guard: the target hostname is resolved via dns.lookup and every
// address is checked against loopback/RFC1918/link-local/ULA ranges — at
// CREATE time and again at DELIVERY time (DNS can change between the two).

import crypto from "node:crypto";
import dns from "node:dns/promises";
import { pool } from "./storage";
import { currentOrgId } from "./org-scope";
import { logger } from "./logger";

export const WEBHOOK_EVENTS = [
  "invoice.created", "invoice.paid", "invoice.voided",
  "bill.created", "bill.paid",
  "credit_note.issued", "period.closed", "ping",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Backoff schedule per the spec (minutes): 1, 5, 30, 120, 720.
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = 6;
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
function ipIsPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    // IPv6: loopback, link-local fe80::/10, unique-local fc00::/7, v4-mapped
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return ipIsPrivate(low.slice(7));
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // unparseable → treat as unsafe
  const [a, b] = parts;
  if (a === 127 || a === 0) return true;               // loopback / this-net
  if (a === 10) return true;                            // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;     // RFC1918
  if (a === 192 && b === 168) return true;              // RFC1918
  if (a === 169 && b === 254) return true;              // link-local (cloud metadata!)
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  return false;
}

export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must be http(s)");
  }
  // Literal IPs get checked directly; hostnames resolve through DNS.
  const host = parsed.hostname;
  let addresses: string[];
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    addresses = [host.replace(/^\[|\]$/g, "")];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new Error(`Webhook host "${host}" does not resolve`);
    }
  }
  for (const addr of addresses) {
    if (ipIsPrivate(addr)) {
      throw new Error(`Webhook URL resolves to a private/loopback address (${addr}) — refused.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Emission (enqueue) — call AFTER the business transaction commits.
// ---------------------------------------------------------------------------
export async function emitWebhookEvent(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const orgId = currentOrgId();
    const hooks = (await pool.query(
      `SELECT id, events FROM webhooks WHERE org_id = $1 AND is_active = true`,
      [orgId]
    )).rows as Array<{ id: number; events: string }>;
    if (hooks.length === 0) return;
    const payload = JSON.stringify({ event, orgId, at: new Date().toISOString(), data });
    for (const h of hooks) {
      let subscribed: string[] = [];
      try { subscribed = JSON.parse(h.events); } catch { /* malformed → no match */ }
      if (!subscribed.includes(event)) continue;
      await pool.query(
        `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload) VALUES ($1, $2, $3, $4)`,
        [orgId, h.id, event, payload]
      );
    }
  } catch (e: any) {
    // Webhook plumbing must NEVER break the business operation.
    logger.warn("webhook emit failed", { event, error: e.message });
  }
}

export function signWebhookPayload(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Delivery worker
// ---------------------------------------------------------------------------
async function deliverOne(d: {
  id: number; org_id: number; webhook_id: number; event: string; payload: string; attempts: number;
  url: string; secret: string;
}): Promise<void> {
  const attemptNo = d.attempts + 1;
  let responseCode: number | null = null;
  let ok = false;
  try {
    await assertSafeWebhookUrl(d.url); // re-check at delivery time — DNS may have changed
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(d.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ledgerlite-event": d.event,
          "x-ledgerlite-signature": signWebhookPayload(d.secret, d.payload),
        },
        body: d.payload,
        signal: ac.signal,
      });
      responseCode = res.status;
      ok = res.status >= 200 && res.status < 300;
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    logger.warn("webhook delivery error", { deliveryId: d.id, attempt: attemptNo, error: e.message });
  }

  if (ok) {
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'success', attempts = $2, response_code = $3 WHERE id = $1`,
      [d.id, attemptNo, responseCode]
    );
    return;
  }
  if (attemptNo >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = $2, response_code = $3, next_attempt_at = now() + interval '100 years' WHERE id = $1`,
      [d.id, attemptNo, responseCode]
    );
    return;
  }
  const backoffMin = BACKOFF_MINUTES[Math.min(attemptNo - 1, BACKOFF_MINUTES.length - 1)];
  await pool.query(
    `UPDATE webhook_deliveries SET status = 'failed', attempts = $2, response_code = $3,
            next_attempt_at = now() + ($4 || ' minutes')::interval
      WHERE id = $1`,
    [d.id, attemptNo, responseCode, String(backoffMin)]
  );
}

let workerStarted = false;
export function startWebhookWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const tick = async () => {
    try {
      const due = (await pool.query(
        `SELECT d.id, d.org_id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret
           FROM webhook_deliveries d
           JOIN webhooks w ON w.id = d.webhook_id AND w.is_active = true
          WHERE d.status IN ('pending', 'failed')
            AND d.attempts < $1
            AND d.next_attempt_at <= now()
          ORDER BY d.id
          LIMIT 20`,
        [MAX_ATTEMPTS]
      )).rows as any[];
      for (const d of due) await deliverOne(d);
    } catch (e: any) {
      logger.warn("webhook worker tick failed", { error: e.message });
    }
  };
  const interval = setInterval(tick, 30_000);
  if (typeof interval.unref === "function") interval.unref();
}
