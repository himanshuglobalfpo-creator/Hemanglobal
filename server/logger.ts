// ============================================================================
// STRUCTURED LOGGER — dependency-free
// ============================================================================
// Production (NODE_ENV=production): one JSON object per line to stdout —
//   {"ts":"...","level":"info","msg":"...","reqId":"...",...fields}
// so any log shipper (CloudWatch, Loki, Datadog) ingests it without parsing
// heuristics. Every 5xx line carries the same reqId the client received in
// the x-request-id response header — that's the support-ticket join key.
//
// Development: keep the existing human-readable single-line format.

export type LogLevel = "debug" | "info" | "warn" | "error";

const isProd = () => process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Redaction — logs must never carry secrets or PII. Two passes:
//   1. By KEY — any field whose name looks sensitive (password, token, secret,
//      key, authorization, cookie, dsn, otp, ssn, card…) has its VALUE replaced,
//      whatever the value is.
//   2. By VALUE — free-text strings (including the message) are scrubbed for
//      email addresses and obvious credential shapes (Bearer/JWT, sk_/pk_
//      Stripe keys, long hex/base64 tokens), so a secret that slips into a
//      message or a non-sensitive field is still masked.
// The redaction test (tests/log_redaction_test.ts) captures real output and
// greps it for these patterns.
// ---------------------------------------------------------------------------
const SENSITIVE_KEY = /pass|secret|token|apikey|api_key|authoriz|cookie|session|\bdsn\b|otp|mfa|ssn|card|cvv|private|credential|bearer|webhook_secret/i;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDENTIAL_RE = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9._-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|[A-Fa-f0-9]{32,})\b/g;

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, "[email]").replace(CREDENTIAL_RE, "[redacted]");
}

export function redactValue(v: unknown, keyIsSensitive = false): unknown {
  if (keyIsSensitive) return "[redacted]";
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (v && typeof v === "object") return redactFields(v as Record<string, unknown>);
  return v;
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = redactValue(v, SENSITIVE_KEY.test(k));
  }
  return out;
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const safeMsg = scrubString(msg);
  const safeFields = fields ? redactFields(fields) : undefined;
  if (isProd()) {
    // JSON.stringify drops undefined values automatically — keeps lines tight.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: safeMsg,
      ...safeFields,
    });
    // stderr for error level so container runtimes can split streams.
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
    return;
  }
  // Dev: human-readable. Match the existing app log flavor (local time prefix).
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  const extra = safeFields && Object.keys(safeFields).length ? " " + JSON.stringify(safeFields) : "";
  const text = `${t} [${level}] ${safeMsg}${extra}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
