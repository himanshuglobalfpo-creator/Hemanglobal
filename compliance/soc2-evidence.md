# SOC 2 Evidence Map

A living index mapping the SOC 2 Trust Services Criteria to concrete evidence in
this repository. It is a starting point for an audit, not a certification — pair
it with organizational controls (HR, vendor management, physical security) that
live outside the codebase.

Store point-in-time evidence (screenshots, exports, ticket links) alongside each
row in your evidence system; this file points the auditor at the *control* and
where it is implemented.

## Security (Common Criteria)

| TSC | Control | Evidence in repo |
|---|---|---|
| CC6.1 Logical access | Role-based access (owner/admin/accountant/…), granular permissions | `server/auth.ts` (`requireRole`/`requirePermission`), `shared/permissions.ts`, `tests/permissions_test.ts` |
| CC6.1 Tenant isolation | Every business query scoped to `org_id`; enforced statically | `server/org-scope.ts`, `tests/org_scope_guard_test.ts` (CI gate) |
| CC6.1 Authentication | Password + TOTP MFA, account lockout, email OTP | `server/auth.ts`, `server/totp.ts`, `tests/totp_test.ts`, `tests/otp_login_test.ts` |
| CC6.1 Session management | `__Host-` cookies, rotation on privilege change, absolute lifetime, sign-out-all | `server/auth.ts`, `server/csrf.ts`, `tests/security_hardening_test.ts` |
| CC6.6 Boundary protection | CSP (`frame-ancestors 'none'`), HSTS, security headers, CSRF | `server/index.ts`, `server/csrf.ts` |
| CC6.7 Data in transit/at rest | AES-256-GCM vault (secrets + attachment blobs); object-store encryption | `server/crypto-vault.ts`, `server/files.ts`, `tests/crypto_vault_blob_test.ts` |
| CC6.8 Malicious input | Zod validation, SSRF guard on webhooks, MIME allow-list on uploads | `server/webhooks.ts`, `server/files.ts`, `tests/webhook_hmac_test.ts` |
| CC7.1 Secrets management | All keys from env/secret-manager; boot guard refuses placeholder keys | `.env.example`, `server/crypto-vault.ts` (`assertEncryptionKey`) |
| CC7.2 Monitoring | Metrics + alerts (5xx, latency, failed-login spikes, signature failures) | `server/metrics.ts`, `monitoring/alerts.yml`, `OBSERVABILITY.md` |
| CC7.2 Anomaly detection | Error tracking correlated by request id; audit log | `server/observability.ts`, `audit_log` table |
| CC7.3 Log integrity/PII | Structured logs with secret/PII redaction (grep-tested) | `server/logger.ts`, `tests/log_redaction_test.ts` |
| CC8.1 Change management | PR-gated CI: lint, typecheck, tests, contract, build, prod-smoke, e2e; dependency audit | `.github/workflows/ci.yml`, `.github/workflows/security-audit.yml` |

## Availability

| TSC | Control | Evidence in repo |
|---|---|---|
| A1.2 Backup | PITR (30-day) + nightly immutable logical dump to object storage | `scripts/backup-logical.sh`, `RUNBOOK.md` |
| A1.2 Recovery testing | Weekly automated restore drill proving the recovered ledger balances | `scripts/restore-drill.sh`, `.github/workflows/restore-drill.yml`, `tests/restore_drill_test.ts` |
| A1.2 DR | RTO ≤ 2h / RPO ≤ 15min targets, region-failure procedure, roles | `RUNBOOK.md` |
| A1.1 Capacity/health | Liveness/readiness endpoints; DB pool metrics; load targets | `server/index.ts` (`/api/health/*`), `monitoring/`, `LOADTEST.md` |

## Confidentiality

| TSC | Control | Evidence in repo |
|---|---|---|
| C1.1 Data protection | Vault encryption for secrets and attachment blobs; encrypted object storage | `server/crypto-vault.ts`, `server/files.ts` |
| C1.1 Access restriction | Attachments and all records are org-scoped and permission-gated | `server/storage.ts`, `tests/attachments_test.ts` |
| C1.2 Disposal | GDPR export/delete + retention purge honoring the financial-records hold | `server/storage.ts` (org purge), `tests/trust_legal_test.ts` |

## Processing Integrity

| TSC | Control | Evidence in repo |
|---|---|---|
| PI1.1 Accuracy | Integer-cent money, balanced double-entry enforced; identity verifier | `server/db-integrity.ts`, `tests/journal_balance_cents_test.ts`, `tests/restore_drill_test.ts` |
| PI1.1 Completeness | Migrations transactional + tracked; golden import ties to the cent | `server/storage.ts` (`runMigrations`), `tests/migration_golden_test.ts` |

## Privacy

| TSC | Control | Evidence in repo |
|---|---|---|
| P4/P6 Data subject rights | Data export + account/org deletion, retention policy | `tests/trust_legal_test.ts`, `RUNBOOK.md` |
| P8 Log minimization | PII redaction in logs | `server/logger.ts`, `tests/log_redaction_test.ts` |
