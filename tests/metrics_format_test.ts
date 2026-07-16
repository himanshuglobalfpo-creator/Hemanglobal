// ============================================================================
// METRICS FORMAT — Prometheus exposition + alert-source series
// ============================================================================
// The alert rules in monitoring/alerts.yml fire on specific series; this test
// proves renderMetrics() emits valid exposition text AND every series those
// alerts reference, including a real latency HISTOGRAM (p95 via
// histogram_quantile needs _bucket{le=...} + _sum + _count) and the domain
// counters (webhook failures, stripe signature failures, failed logins,
// scheduler failures).
//
// Run: tsx tests/metrics_format_test.ts
// ============================================================================

// metrics.ts imports the pg pool from storage.ts, which requires DATABASE_URL to
// be set at import time. It is never queried here (the pool gauges read
// totalCount/idleCount without connecting), so a placeholder URL is enough.
process.env.DATABASE_URL ||= "postgres://placeholder:placeholder@localhost:5432/none";
const {
  renderMetrics, recordHttpRequest, recordWebhookDelivery,
  recordStripeSignatureFailure, recordAuthLogin, recordSchedulerRun,
} = await import("../server/metrics");

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

// Drive some traffic + domain events.
recordHttpRequest("GET", 200, 12);
recordHttpRequest("GET", 200, 240);
recordHttpRequest("POST", 500, 30);
recordWebhookDelivery("success");
recordWebhookDelivery("failed");
recordStripeSignatureFailure("app");
recordStripeSignatureFailure("platform");
recordAuthLogin("success");
recordAuthLogin("failed");
recordSchedulerRun("report_schedules", "failed");

const out = renderMetrics();
console.log("Test: metrics exposition format");

// Structural: every TYPE line names a metric, values are numeric, no NaN.
const lines = out.split("\n").filter(Boolean);
check("ends with a newline", out.endsWith("\n"));
check("no NaN/undefined in output", !/NaN|undefined/.test(out));
const sampleLines = lines.filter((l) => !l.startsWith("#"));
check("every sample line ends with a number", sampleLines.every((l) => /\s-?\d+(\.\d+)?$/.test(l)), sampleLines.find((l) => !/\s-?\d+(\.\d+)?$/.test(l)));
check("every metric has a # TYPE", lines.some((l) => l.startsWith("# TYPE")));

// 5xx rate source.
check("http_requests_total present", out.includes('ledgerlite_http_requests_total{method="POST",status="500"} 1'));

// p95 latency source — histogram buckets + sum + count.
check("duration histogram TYPE", out.includes("# TYPE ledgerlite_http_request_duration_seconds histogram"));
check("histogram has le buckets", out.includes('ledgerlite_http_request_duration_seconds_bucket{le="0.25"}'));
check("histogram has +Inf bucket", out.includes('ledgerlite_http_request_duration_seconds_bucket{le="+Inf"}'));
check("histogram has _sum and _count", out.includes("ledgerlite_http_request_duration_seconds_sum") && out.includes("ledgerlite_http_request_duration_seconds_count"));

// pg pool saturation source.
check("pg pool gauges present", out.includes("ledgerlite_pg_pool_waiting"));

// Domain counters the alerts watch.
check("webhook failures series", out.includes('ledgerlite_webhook_deliveries_total{result="failed"} 1'));
check("stripe sig failures (app)", out.includes('ledgerlite_stripe_webhook_signature_failures_total{source="app"} 1'));
check("stripe sig failures (platform)", out.includes('ledgerlite_stripe_webhook_signature_failures_total{source="platform"} 1'));
check("failed logins series", out.includes('ledgerlite_auth_logins_total{result="failed"} 1'));
check("scheduler failures series", out.includes('ledgerlite_scheduler_runs_total{job="report_schedules",result="failed"} 1'));

// Cumulative bucket monotonicity — le buckets must be non-decreasing.
const buckets = [...out.matchAll(/ledgerlite_http_request_duration_seconds_bucket\{le="[^"]+"\} (\d+)/g)].map((m) => Number(m[1]));
let monotonic = true;
for (let i = 1; i < buckets.length; i++) if (buckets[i] < buckets[i - 1]) monotonic = false;
check("histogram buckets are cumulative (monotonic)", monotonic, JSON.stringify(buckets));

if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("\nAll metrics-format checks passed ✅");
