// ============================================================================
// METRICS — dependency-free Prometheus exposition (text format 0.0.4)
// ============================================================================
// Counters/gauges kept in-process (single-instance app; matches the in-memory
// rate limiter's assumption — move both to shared storage if we ever scale
// horizontally). Exposed at GET /api/metrics, guarded by x-metrics-token ==
// env METRICS_TOKEN; 404 when METRICS_TOKEN is unset so the endpoint is
// invisible unless deliberately enabled.
//
// Series here are exactly the ones the alert rules in monitoring/alerts.yml
// fire on: request rate/status (5xx rate), a real latency HISTOGRAM (p95 via
// histogram_quantile), pg pool saturation, scheduler-job failures, webhook
// delivery failures, Stripe signature failures, and failed-login spikes.

import type { Request, Response, NextFunction } from "express";
import { pool } from "./storage";

// ledgerlite_http_requests_total{method,status}
const requestCounts = new Map<string, number>(); // key: `${method}|${status}`

// Latency histogram (seconds) — cumulative buckets enable p95 in PromQL via
// histogram_quantile(0.95, rate(..._bucket[5m])). The summary sum/count is kept
// too (cheap, and gives a plain average without a quantile function).
const DURATION_BUCKETS_S = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const bucketCounts = new Array(DURATION_BUCKETS_S.length).fill(0);
let durationSumMs = 0;
let durationCount = 0;

// ---------------------------------------------------------------------------
// Domain counters — labeled series behind a single helper. Known label combos
// are initialized to 0 so an alert can fire from t=0 (a series that never
// appears can't cross a threshold).
// ---------------------------------------------------------------------------
const COUNTER_HELP: Record<string, string> = {
  ledgerlite_scheduler_runs_total: "Scheduled job runs, by job and result.",
  ledgerlite_webhook_deliveries_total: "Outbound webhook delivery attempts, by result.",
  ledgerlite_stripe_webhook_signature_failures_total: "Stripe webhook signature verification failures, by source (app vs platform).",
  ledgerlite_auth_logins_total: "Login credential checks, by result.",
};
const counters = new Map<string, number>(); // full series string → value
function bump(series: string): void {
  counters.set(series, (counters.get(series) ?? 0) + 1);
}
function initCounter(series: string): void {
  if (!counters.has(series)) counters.set(series, 0);
}
// Seed the combos alerts watch.
initCounter(`ledgerlite_webhook_deliveries_total{result="success"}`);
initCounter(`ledgerlite_webhook_deliveries_total{result="failed"}`);
initCounter(`ledgerlite_stripe_webhook_signature_failures_total{source="app"}`);
initCounter(`ledgerlite_stripe_webhook_signature_failures_total{source="platform"}`);
initCounter(`ledgerlite_auth_logins_total{result="success"}`);
initCounter(`ledgerlite_auth_logins_total{result="failed"}`);

export function recordHttpRequest(method: string, status: number, durationMs: number): void {
  const key = `${method}|${status}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  durationSumMs += durationMs;
  durationCount += 1;
  const s = durationMs / 1000;
  for (let i = 0; i < DURATION_BUCKETS_S.length; i++) {
    if (s <= DURATION_BUCKETS_S[i]) bucketCounts[i] += 1;
  }
}

export function recordSchedulerRun(job: string, result: "success" | "failed"): void {
  bump(`ledgerlite_scheduler_runs_total{job="${job}",result="${result}"}`);
}
export function recordWebhookDelivery(result: "success" | "failed"): void {
  bump(`ledgerlite_webhook_deliveries_total{result="${result}"}`);
}
export function recordStripeSignatureFailure(source: "app" | "platform"): void {
  bump(`ledgerlite_stripe_webhook_signature_failures_total{source="${source}"}`);
}
export function recordAuthLogin(result: "success" | "failed"): void {
  bump(`ledgerlite_auth_logins_total{result="${result}"}`);
}

// Express middleware — mount once, early, so every /api request is counted.
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      recordHttpRequest(req.method, res.statusCode, Date.now() - start);
    }
  });
  next();
}

// Renders the Prometheus exposition text.
export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP ledgerlite_http_requests_total Total HTTP requests handled, by method and status.");
  lines.push("# TYPE ledgerlite_http_requests_total counter");
  for (const [key, count] of requestCounts.entries()) {
    const [method, status] = key.split("|");
    lines.push(`ledgerlite_http_requests_total{method="${method}",status="${status}"} ${count}`);
  }

  // Real histogram — cumulative buckets + sum + count, enabling p95.
  lines.push("# HELP ledgerlite_http_request_duration_seconds HTTP request latency in seconds.");
  lines.push("# TYPE ledgerlite_http_request_duration_seconds histogram");
  // bucketCounts[i] already holds "# observations ≤ bucket[i]" (accumulated at
  // record time), i.e. the cumulative le-bucket value Prometheus expects.
  for (let i = 0; i < DURATION_BUCKETS_S.length; i++) {
    lines.push(`ledgerlite_http_request_duration_seconds_bucket{le="${DURATION_BUCKETS_S[i]}"} ${bucketCounts[i]}`);
  }
  lines.push(`ledgerlite_http_request_duration_seconds_bucket{le="+Inf"} ${durationCount}`);
  lines.push(`ledgerlite_http_request_duration_seconds_sum ${durationSumMs / 1000}`);
  lines.push(`ledgerlite_http_request_duration_seconds_count ${durationCount}`);

  // Back-compat summary (plain average without a quantile function).
  lines.push("# HELP ledgerlite_http_request_duration_ms HTTP request duration, sum and count (histogram-lite).");
  lines.push("# TYPE ledgerlite_http_request_duration_ms summary");
  lines.push(`ledgerlite_http_request_duration_ms_sum ${durationSumMs}`);
  lines.push(`ledgerlite_http_request_duration_ms_count ${durationCount}`);

  lines.push("# HELP ledgerlite_pg_pool_total Total clients in the PostgreSQL pool.");
  lines.push("# TYPE ledgerlite_pg_pool_total gauge");
  lines.push(`ledgerlite_pg_pool_total ${pool.totalCount}`);
  lines.push("# HELP ledgerlite_pg_pool_idle Idle clients in the PostgreSQL pool.");
  lines.push("# TYPE ledgerlite_pg_pool_idle gauge");
  lines.push(`ledgerlite_pg_pool_idle ${pool.idleCount}`);
  lines.push("# HELP ledgerlite_pg_pool_waiting Requests waiting for a pool client.");
  lines.push("# TYPE ledgerlite_pg_pool_waiting gauge");
  lines.push(`ledgerlite_pg_pool_waiting ${pool.waitingCount}`);

  // Domain counters — HELP/TYPE once per metric name, then every labeled series.
  for (const [name, help] of Object.entries(COUNTER_HELP)) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [series, value] of counters.entries()) {
      if (series === name || series.startsWith(name + "{")) lines.push(`${series} ${value}`);
    }
  }

  return lines.join("\n") + "\n";
}

// Route handler for GET /api/metrics with the token guard.
export function metricsHandler(req: Request, res: Response): void {
  const configured = process.env.METRICS_TOKEN;
  if (!configured) {
    // Endpoint effectively does not exist until deliberately enabled.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const supplied = req.headers["x-metrics-token"];
  if (supplied !== configured) {
    res.status(404).json({ error: "Not found" }); // don't advertise the guard
    return;
  }
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(renderMetrics());
}
