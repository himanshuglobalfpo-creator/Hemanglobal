# LedgerLite — Deployment Guide

Three environments, one artifact. The same `dist/index.mjs` is promoted from
staging to production; only configuration (env/secrets) differs.

## Environments

| | dev | staging | production |
|---|---|---|---|
| Where | local (`npm run dev` / compose) | auto-deploy on push to `main` | deploy on `v*` tag |
| Data | throwaway | seeded **demo org** | real customer data |
| Stripe/Plaid | none/sandbox | **sandbox** keys | **live** keys |
| Platform billing | disabled | sandbox | live (`PLATFORM_STRIPE_*`) |
| Object storage | MinIO (compose) | S3/R2 bucket (staging) | S3/R2 bucket (prod) |
| Approval to deploy | — | none (continuous) | **manual** (GitHub `production` environment reviewers) |

The pipeline (`.github/workflows/deploy.yml`): merge to `main` → staging; cut a
`v1.2.3` tag → production, paused for manual approval.

## Configuration & secrets

All secrets come from the environment / a secret manager — never committed. See
`.env.example` for the full list. Critical ones:

- `DATABASE_URL`, `APP_ENCRYPTION_KEY` (real 32-byte key; the boot guard refuses
  a placeholder in production — see SECURITY.md).
- `FILE_STORAGE=s3` + `S3_*` for attachments (encrypted before upload).
- `STRIPE_*` / `PLATFORM_STRIPE_*`, `PLAID_*` — sandbox in staging, live in prod.
- `SENTRY_DSN`, `METRICS_TOKEN` — observability (see OBSERVABILITY.md).
- Backups: `BACKUP_S3_BUCKET` + backup-only AWS creds (see RUNBOOK.md).

## Migrations at deploy

Migrations run automatically at boot, each in its own transaction, tracked in
`schema_migrations` (exactly-once). A rolling/blue-green deploy needs **no
separate migration step**. This is safe ONLY because migrations follow the
additive-only rule — read **CONTRIBUTING.md → MIGRATION SAFETY** before shipping
any schema change.

## Release procedure (production)

1. Confirm staging is healthy on the commit you're releasing (green CI, smoke a
   few flows, check dashboards).
2. Tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. Approve the paused `deploy-production` job in the GitHub Actions UI.
4. **Blue-green:** the new color boots (runs migrations), then the pipeline waits
   for `/api/health/ready` = 200 on the new color BEFORE shifting traffic. The
   old color stays warm for fast rollback.
5. Watch `OBSERVABILITY.md` alerts (5xx rate, p95, DB pool) for ~15 min.

## Rollback

- **Bad release, schema still compatible (additive rule holds):** shift traffic
  back to the previous color / redeploy the previous tag. No DB change needed —
  the old code already works against the new (additive) schema.
- **Data issue:** see RUNBOOK.md (PITR / logical restore).

## Health endpoints

- `GET /api/health/live` — liveness (no DB).
- `GET /api/health/ready` — readiness; the gate for rollout traffic-shifting,
  the prod-smoke CI job, and external uptime checks.
