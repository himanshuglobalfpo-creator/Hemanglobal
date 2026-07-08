/**
 * server/webhooks.ts — TASK 6: outbound webhooks.
 * - emitEvent() is called by routes AFTER storage transactions commit
 *   (never inside them) and enqueues one delivery row per subscribed hook.
 * - A 30s unref'd interval worker picks due pending/failed deliveries
 *   (attempts < 6), POSTs signed JSON, and backs off 1m/5m/30m/2h/12h.
 * - SSRF guard rejects URLs resolving to loopback/private/link-local ranges
 *   at create time AND again at delivery time (DNS rebinding defense).
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { db } from "./db.js";
import type { WebhookEvent } from "../shared/schema.js";

/* --------------------------- SSRF guard --------------------------- */

function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata!)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return ipIsPrivate(lower.slice(7)); // v4-mapped
  return false;
}

/** Throws with a human-readable reason when the URL must not be fetched. */
export async function assertUrlIsPublic(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("URL resolves to a private address");
  }
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (ips.length === 0) throw new Error("hostname does not resolve");
  for (const ip of ips) {
    if (ipIsPrivate(ip)) throw new Error(`URL resolves to a private address (${ip})`);
  }
}

/* ---------------------------- signing ----------------------------- */

export function signPayload(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/* ---------------------------- emitting ---------------------------- */

interface WebhookRow {
  id: number;
  org_id: number;
  url: string;
  secret: string;
  events: string;
  is_active: number;
}

/**
 * Enqueue deliveries for every active hook in the org subscribed to `event`.
 * MUST be called after the business transaction has committed — the payload
 * describes state that is already durable.
 */
export function emitEvent(orgId: number, event: WebhookEvent, data: Record<string, unknown>): void {
  const hooks = db
    .prepare("SELECT * FROM webhooks WHERE org_id = ? AND is_active = 1")
    .all(orgId) as WebhookRow[];
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (org_id, webhook_id, event, payload, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'))`,
  );
  const payload = JSON.stringify({ event, orgId, occurredAt: new Date().toISOString(), data });
  for (const hook of hooks) {
    let events: string[] = [];
    try {
      events = JSON.parse(hook.events);
    } catch {
      /* malformed events column: treat as no subscriptions */
    }
    if (events.includes(event)) insert.run(orgId, hook.id, event, payload);
  }
}

/* ------------------------ delivery worker ------------------------- */

/** Backoff schedule per spec: 1m, 5m, 30m, 2h, 12h (then attempts hits 6 = give up). */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = 6;

interface DeliveryRow {
  id: number;
  org_id: number;
  webhook_id: number;
  event: string;
  payload: string;
  attempts: number;
}

export async function deliverOne(row: DeliveryRow): Promise<void> {
  const hook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(row.webhook_id) as WebhookRow | undefined;
  const markFailed = (code: number | null) => {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS || !hook || !hook.is_active) {
      db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, response_code=?, next_attempt_at=datetime('now','+100 years') WHERE id=?")
        .run(attempts, code, row.id);
    } else {
      const mins = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, response_code=?, next_attempt_at=datetime('now', ?) WHERE id=?")
        .run(attempts, code, `+${mins} minutes`, row.id);
    }
  };

  if (!hook || !hook.is_active) {
    markFailed(null);
    return;
  }
  try {
    await assertUrlIsPublic(hook.url); // re-check at delivery time (DNS rebinding)
  } catch {
    markFailed(null);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ledgerlite-event": row.event,
        "x-ledgerlite-signature": signPayload(hook.secret, row.payload),
      },
      body: row.payload,
      signal: controller.signal,
      redirect: "error", // a redirect could bounce us into a private range
    });
    if (res.ok) {
      db.prepare("UPDATE webhook_deliveries SET status='success', attempts=?, response_code=? WHERE id=?")
        .run(row.attempts + 1, res.status, row.id);
    } else {
      markFailed(res.status);
    }
  } catch {
    markFailed(null);
  } finally {
    clearTimeout(timer);
  }
}

let workerRunning = false;

export async function runDeliveryPass(): Promise<number> {
  // Intentionally NOT org-scoped: the delivery worker is a background
  // process that drains due deliveries across ALL orgs; each row carries
  // its own org_id and is only ever addressed by primary key below.
  const due = db
    .prepare(
      `SELECT id, org_id, webhook_id, event, payload, attempts
       FROM webhook_deliveries
       WHERE status IN ('pending','failed') AND attempts < ? AND next_attempt_at <= datetime('now')
       ORDER BY next_attempt_at LIMIT 25`,
    )
    .all(MAX_ATTEMPTS) as DeliveryRow[];
  for (const row of due) {
    await deliverOne(row);
  }
  return due.length;
}

export function startWebhookWorker(): NodeJS.Timeout {
  const interval = setInterval(async () => {
    if (workerRunning) return; // never overlap passes
    workerRunning = true;
    try {
      await runDeliveryPass();
    } catch (err) {
      console.error("webhook worker pass failed:", err);
    } finally {
      workerRunning = false;
    }
  }, 30_000);
  interval.unref(); // never keep the process alive just for the worker
  return interval;
}
