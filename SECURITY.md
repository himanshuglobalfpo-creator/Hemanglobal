# Security Policy

We take the security of LedgerLite and its users' financial data seriously.
Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Email **security@ledgerlite.example** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version/commit and environment.

If you need to send sensitive details, ask for our PGP key in your first email.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | within **2 business days** |
| Initial assessment & severity | within **5 business days** |
| Fix or mitigation for high/critical | as fast as possible, typically **≤ 30 days** |
| Public disclosure | coordinated with you after a fix ships |

We follow **coordinated disclosure**: please give us reasonable time to remediate
before any public write-up. We're happy to credit you (or keep you anonymous —
your choice) in the release notes.

### Scope

In scope: the application code in this repository, its API, authentication and
session handling, tenant isolation, and data-at-rest handling.

Out of scope: findings that require a compromised host or a privileged operator,
volumetric DoS, social engineering, and reports about the weak CI/test
placeholder secrets (they never protect real data — the boot guard refuses them
in production; see below).

## Safe harbor

We will not pursue or support legal action against researchers who act in good
faith, avoid privacy violations and service disruption, and give us a
reasonable chance to fix an issue before disclosure.

## Security posture (summary)

- **Tenant isolation** — every business query is org-scoped; a CI static guard
  (`tests/org_scope_guard_test.ts`) fails the build on an unscoped query.
- **Data at rest** — Plaid/TOTP secrets and attachment blobs are AES-256-GCM
  encrypted (`server/crypto-vault.ts`); attachments are encrypted before they
  reach local disk or object storage.
- **Sessions** — HttpOnly cookies with the `__Host-` prefix in production,
  rotated on privilege change (org switch, MFA enable), with an absolute
  lifetime cap and a "sign out all other devices" control.
- **Transport & headers** — HSTS (1y, preload), a tuned CSP (`frame-ancestors
  'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- **CSRF** — double-submit token on every state-changing request.
- **Boot guard** — production refuses to start with a missing/malformed or
  well-known-placeholder `APP_ENCRYPTION_KEY`.
- **Dependencies** — `npm audit` gates HIGH/CRITICAL prod advisories in CI, with
  a weekly full report.
- **Observability** — no PII/secrets in logs (enforced by a redaction test);
  error tracking and alerting on abuse signals (failed-login spikes, signature
  failures). See `OBSERVABILITY.md`.
