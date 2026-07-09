// ============================================================================
// METRICS — dependency-free Prometheus exposition (text format 0.0.4)
// ============================================================================
// Counters/gauges kept in-process (single-instance app; matches the in-memory
// rate limiter's assumption — move both to shared storage if we ever scale
// horizontally). Exposed at GET /api/metrics, guarded by x-metrics-token ==
// env METRICS_TOKEN; 404 when METRICS_TOKEN is unset so the endpoint is
// invisible unless deliberately enabled.

import type { Request, Response, NextFunction } from "express";
import { pool } from "./storage";

// ledgerlite_http_requests_total{method,status}
const requestCounts = new Map<string, number>(); // key: `${method}|${status}`

// histogram-lite: total duration + count (enough for avg latency & rate in PromQL)
let durationSumMs = 0;
let durationCount = 0;

export function recordHttpRequest(method: string, status: number, durationMs: number): void {
  const key = `${method}|${status}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  durationSumMs += durationMs;
  durationCount += 1;
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
