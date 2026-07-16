// ============================================================================
// OBSERVABILITY — error tracking (Sentry ingestion protocol, no SDK)
// ============================================================================
// Env-gated by SENTRY_DSN. When unset, everything here is a no-op — the app is
// unchanged. When set, uncaught errors and 5xx responses are shipped to Sentry
// (or any Sentry-compatible ingest, e.g. GlitchTip) as event envelopes over
// plain fetch — matching the codebase's SDK-free house style (see the S3 driver
// and lazy-Stripe). Swap in @sentry/node later if you want tracing/breadcrumbs;
// the capture call sites stay the same.
//
// Correlation: every event carries the request's `reqId` as a tag, the same id
// the client received in the x-request-id header and that every 5xx log line
// carries — so a user's error report joins straight to the Sentry event and the
// log line. Payloads are run through the logger's redaction first, so no PII or
// secret rides along in a message, stack, or tag.

import crypto from "node:crypto";
import { logger, redactValue, redactFields } from "./logger";

interface Dsn { host: string; projectId: string; publicKey: string; protocol: string }

let parsed: Dsn | null | undefined; // undefined = not yet parsed; null = disabled
function dsn(): Dsn | null {
  if (parsed !== undefined) return parsed;
  const raw = process.env.SENTRY_DSN;
  if (!raw) { parsed = null; return null; }
  try {
    // https://<publicKey>@<host>/<projectId>
    const u = new URL(raw);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) throw new Error("missing key or project id");
    parsed = { host: u.host, projectId, publicKey: u.username, protocol: u.protocol.replace(":", "") };
  } catch (e: any) {
    logger.warn("[observability] SENTRY_DSN is malformed — error tracking disabled", { error: e.message });
    parsed = null;
  }
  return parsed;
}

export function errorTrackingEnabled(): boolean {
  return dsn() !== null;
}

export interface CaptureContext {
  reqId?: string;
  level?: "error" | "warning" | "fatal";
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

// Fire-and-forget. NEVER throws into the caller — a telemetry failure must not
// break a request or crash the process.
export function captureException(err: unknown, ctx: CaptureContext = {}): void {
  const d = dsn();
  if (!d) return;
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = crypto.randomBytes(16).toString("hex");
    const nowSec = Date.now() / 1000;
    const event = {
      event_id: eventId,
      timestamp: nowSec,
      platform: "node",
      level: ctx.level ?? "error",
      logger: "ledgerlite",
      server_name: process.env.HOSTNAME || undefined,
      release: process.env.SENTRY_RELEASE || undefined,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      tags: redactFields({ ...(ctx.reqId ? { reqId: ctx.reqId } : {}), ...(ctx.tags ?? {}) }),
      extra: ctx.extra ? redactFields(ctx.extra) : undefined,
      exception: {
        values: [{
          type: e.name,
          value: String(redactValue(e.message)),
          stacktrace: e.stack ? { frames: parseStack(e.stack) } : undefined,
        }],
      },
    };

    const url = `${d.protocol}://${d.host}/api/${d.projectId}/envelope/?sentry_key=${d.publicKey}&sentry_version=7`;
    const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
    const item = JSON.stringify({ type: "event" });
    const body = `${header}\n${item}\n${JSON.stringify(event)}`;

    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    }).catch((sendErr) => logger.warn("[observability] failed to send event", { error: sendErr?.message }));
  } catch (buildErr: any) {
    logger.warn("[observability] failed to build event", { error: buildErr?.message });
  }
}

// Minimal, oldest-first frame list — enough for Sentry to group and display.
function parseStack(stack: string): { function?: string; filename?: string }[] {
  const frames = stack.split("\n").slice(1).map((line) => {
    const m = line.match(/at\s+(.*?)\s+\((.*)\)/) || line.match(/at\s+(.*)/);
    if (!m) return null;
    return m[2] ? { function: m[1], filename: String(redactValue(m[2])) } : { filename: String(redactValue(m[1])) };
  }).filter(Boolean) as { function?: string; filename?: string }[];
  return frames.reverse();
}

// Install process-level handlers. Call once at boot. Safe when disabled: still
// logs, just doesn't ship.
export function initErrorTracking(): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { error: reason instanceof Error ? reason.message : String(reason) });
    captureException(reason, { level: "fatal", tags: { kind: "unhandledRejection" } });
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message });
    captureException(err, { level: "fatal", tags: { kind: "uncaughtException" } });
  });
  if (errorTrackingEnabled()) logger.info("[observability] Sentry error tracking enabled");
}
