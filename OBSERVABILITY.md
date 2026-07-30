# LedgerLite — Observability & Alerting

Three pillars, all env-gated so nothing changes until you turn it on: **error
tracking** (Sentry), **metrics + alerts** (Prometheus/Grafana), and **uptime**
(external probes). Plus a logging guarantee: **no PII/secrets in logs**.

## 1. Error tracking (Sentry)

`server/observability.ts` speaks the Sentry ingestion protocol directly over
`fetch` — no SDK dependency (same house style as the S3 driver and lazy Stripe).

- **Enable:** set `SENTRY_DSN` (standard `https://<key>@<host>/<projectId>`).
  Optional: `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`), `SENTRY_RELEASE`.
- **What's captured:** every 5xx from the Express error handler, plus
  `unhandledRejection` / `uncaughtException`. 4xx (validation, auth, 402 billing)
  are expected and NOT reported.
- **Correlation:** each event carries the request's `reqId` as a tag — the same
  id returned in the `x-request-id` response header and stamped on every 5xx log
  line. A support ticket → the log line → the Sentry event, one join key.
- **Safety:** payloads are run through the logger's redaction before sending, so
  no email/secret rides along; a telemetry failure never throws into a request.
- **Swap-in:** to adopt `@sentry/node` later (tracing, breadcrumbs), keep the
  `captureException(...)` call sites and replace the transport.

## 2. Metrics & alerts (Prometheus + Grafana)

`GET /api/metrics` exposes Prometheus text (0.0.4). It **404s unless
`METRICS_TOKEN` is set** and the request sends `x-metrics-token` with the same
value — invisible until deliberately enabled.

Series (see `server/metrics.ts`; `tests/metrics_format_test.ts` guards them):

| Series | Powers alert |
|---|---|
| `ledgerlite_http_requests_total{method,status}` | 5xx rate |
| `ledgerlite_http_request_duration_seconds_bucket` (histogram) | p95 latency via `histogram_quantile` |
| `ledgerlite_pg_pool_{total,idle,waiting}` | DB pool saturation |
| `ledgerlite_scheduler_runs_total{job,result}` | scheduler-job failures |
| `ledgerlite_webhook_deliveries_total{result}` | webhook delivery failure rate |
| `ledgerlite_stripe_webhook_signature_failures_total{source}` | Stripe signature failures |
| `ledgerlite_auth_logins_total{result}` | failed-login spikes |

- **Scrape:** `monitoring/prometheus.example.yml` (inject `x-metrics-token`).
- **Alerts:** `monitoring/alerts.yml` — 5xx > 5%, p95 > 1s, pool waiting > 0,
  any scheduler failure, webhook failure > 20%, any Stripe signature failure,
  failed-login spike. Load via `rule_files`.
- **Dashboard:** import `monitoring/grafana-dashboard.json` (request rate by
  status, p95, DB pool, and the security/jobs counters).

## 3. Uptime (external)

Probe from **outside** the cluster so a probe failure is independent of the
app's own pipeline:

- `GET /api/health/live` — process is up (liveness). No DB dependency.
- `GET /api/health/ready` — dependencies ready (readiness); the same gate the
  prod-smoke CI job and blue-green rollout wait on.

Wire both into your external monitor (blackbox_exporter, Pingdom, Better Uptime,
Grafana Synthetic). Neither needs `METRICS_TOKEN`. Example blackbox job in
`monitoring/prometheus.example.yml`.

## 4. Log hygiene (no PII/secrets)

`server/logger.ts` redacts on every line, two passes:

1. **By key** — values under sensitive keys (`password`, `token`, `secret`,
   `apiKey`, `authorization`, `cookie`, `session`, `dsn`, `otp`, `ssn`, `card`,
   …) are replaced wholesale.
2. **By value** — free text (including the message) is scrubbed for email
   addresses (`[email]`) and credential shapes — Bearer/JWT, `sk_/pk_` Stripe
   keys, `whsec_`, long hex/base64 tokens (`[redacted]`).

`tests/log_redaction_test.ts` captures real logger output and greps it for these
patterns — a regression that logs a secret fails CI.
