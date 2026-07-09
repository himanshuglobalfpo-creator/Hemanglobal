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

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (isProd()) {
    // JSON.stringify drops undefined values automatically — keeps lines tight.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    });
    // stderr for error level so container runtimes can split streams.
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
    return;
  }
  // Dev: human-readable. Match the existing app log flavor (local time prefix).
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  const text = `${t} [${level}] ${msg}${extra}`;
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
