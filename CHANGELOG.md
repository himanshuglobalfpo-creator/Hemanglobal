# Changelog

## v2.3.0 — Competitive parity (Phase 3)
- Multi-currency: foreign invoices/bills store base+foreign cents at the
  document rate; realized FX gain/loss (4950/6950) posts on payment; the GL
  stays 100% base currency. Manual FX rates at /api/settings/fx-rates.
- MFA (TOTP, RFC 6238, dependency-free): setup/enable/disable/verify, two-step
  login with single-use 5-minute challenge tokens, bcrypt recovery codes,
  owner enforcement after a 7-day grace period.
- File attachments on invoices/bills/bank tx/JEs: local or S3 (SigV4, no SDK),
  10MB + mime whitelist, org-verified, byte-identical download.
- Report pack: sales-by-customer, expenses-by-vendor, monthly P&L,
  budgets + budget-vs-actual — all with ?format=csv (RFC 4180).
- CSV data import: customers, vendors, chart-of-accounts, invoices,
  opening-balances; dry-run capable; per-row savepoints for partial invoice
  imports.
- Outbound webhooks: HMAC-SHA256 signed deliveries, 30s worker, exponential
  backoff, SSRF guard (blocks private/loopback/metadata ranges).
- Audit log filters (userId, entityId, free-text q) + CSV export + role guard.
- Phase-3 composite indexes; four new test suites (FX, TOTP, webhook HMAC,
  importer dry-run).


## v2.2.0 — Production hardening batch 3
- Plaid access tokens now encrypted at rest (AES-256-GCM vault, lazy re-encrypt
  of legacy rows; APP_ENCRYPTION_KEY required in production).
- Per-org auto-numbering for invoices/bills/credit notes/debit notes via an
  atomic number_sequences allocator; `number` optional at the API; preview via
  GET /api/settings/next-number; duplicate numbers return clean 400s.
- updated_at + auto-touch triggers on 10 core tables; optimistic concurrency
  (ifUnmodifiedSince → 409) on account/customer/vendor PATCH.
- Email verification enforced after a 24h grace period (verify + resend routes,
  signup email, client banner/overlay).
- Password complexity: min 10 chars, 3 of 4 character classes, and signup
  passwords may not contain the email local part.
- Boot-time DB connection retry with backoff (connection errors only; SQL
  errors still fail fast).
- Structured JSON logging in production with x-request-id correlation on every
  request and all 5xx logs.
- Health split (/api/health/live vs /ready) and Prometheus /api/metrics guarded
  by METRICS_TOKEN.

## v2.1.2 — Reconciliation cross-tenant fixes + org-scope CI guard

Fixes the three cross-tenant defects found in the reconciliation module during
the v2.1.1 audit, hardens related lookups, and adds an automated guard so this
bug class cannot ship again.

- **BUG-M1 (HIGH, read leak):** `getReconciliation()` — and therefore
  `completeReconciliation()`, which calls it — looked up reconciliations by id
  with no org filter, letting a user read another tenant's reconciliation and
  its bank transactions via `GET /api/reconciliations/:id`. Now org-scoped.
- **BUG-M2 (HIGH, write leak):** `toggleReconItem()` looked up the reconciliation
  with no org filter, letting a user mutate another tenant's reconciliation
  items via `POST /api/reconciliations/:id/toggle`. Now org-scoped.
- **BUG-M3 (MEDIUM, data integrity):** `toggleReconItem()` inserted
  `reconciliation_items` without setting `org_id`, so every tenant's items
  landed with the column default of 1. Insert now sets `orgId` explicitly;
  migration 0003 backfills legacy rows from the parent reconciliation and drops
  the misleading default so a future missing `org_id` fails loudly.
- **Defense-in-depth:** added explicit `orgId` filters to the void/unmatch
  payment-and-original journal-entry lookups, `getJournalLinesForAccount`, and
  the `startReconciliation` open-reconciliation check — all previously relied on
  a transitively org-scoped parent.
- **New: `tests/org_scope_guard_test.ts`** — a CI gate that statically scans
  `server/storage.ts` and fails the build on any business-table query missing an
  org filter (with a documented per-(method,table) allowlist for provably-safe
  child-row fetches). Wired into `npm test`. Verified it fails when a filter is
  removed and passes when restored.

## v2.1.1 — Residual bug fixes (pre-Phase-2)
- Fixed cross-tenant read leak in general-ledger report (org scoping).
- Fixed journal-entry balance validator to compare in integer cents
  (was rejecting valid balanced entries due to float equality).
- Hardened org scoping on getInvoice/getBill sub-lookups, customer/vendor
  statements, and bank-rule application paths.
- Removed stray Drizzle global-unique on accounts.code (DB uses composite
  UNIQUE(org_id, code)).
- Duplicate invoice/bill numbers now return a clean 400.

## v1.0.0 — Publish-ready release

This is the consolidated post-audit release. Earlier development versions
(v0.x) had four cash-flow bugs and various validation/security gaps that have
all been resolved here.

### Major features added
- **Multi-tenancy**: organizations + users + memberships + sessions. Every
  business table now carries `org_id`. Reports and queries are scoped to the
  active org via AsyncLocalStorage middleware.
- **Authentication**: bcrypt password hashing, server-side sessions, account
  lockout after 5 failed logins, password reset flow, email verification, and
  member invites with role-based access control.
- **Stripe payments**: customers can pay invoices online via Checkout. The
  webhook automatically records the payment in the ledger.
- **Plaid integration**: cursor-based incremental bank sync, item management,
  webhook for real-time updates. Replaces the v0.x stub.

### Cash flow correctness (4 bugs fixed)
1. Intangible assets were misclassified as Operating instead of Investing.
2. Retained Earnings was excluded from Financing, breaking reconciliation
   whenever a closing entry fell inside the cash-flow period.
3. Depreciation was never added back as a non-cash adjustment.
4. NULL subtypes silently fell through classification rules.

The engine now reconciles to exactly $0.00 on every balanced ledger. Verified
by `cashflow_property_test.js` across 400 randomized scenarios.

### Posting / ledger correctness (6 fixes)
- Invoice/bill JE rounding mismatch could create $0.01 imbalances on certain
  decimal inputs. Fixed with per-line round-then-sum.
- Bill purchase-tax was being added to a random expense account from a `Map`.
  Now goes to dedicated `1150 Sales Tax Receivable` (asset) with fallback.
- `payInvoice` / `payBill` now reject overpayments and validate that the
  receiving account is bank-subtype.
- `matchBankTransaction` `categorize` and `transfer` paths were bypassing
  period locks. Locks are now respected.
- `voidInvoice` posts a balanced reversal entry.
- `voidBill` was missing entirely; now mirrors `voidInvoice`.

### Data integrity (5 fixes)
- `deleteCustomer` / `deleteVendor` now refuse to delete records referenced
  by invoices/bills (was silently orphaning ledger history).
- `updateAccount` blocks changes to `type`, `code`, or `subtype` once an
  account has journal lines (would have corrupted reports retroactively).
- `startReconciliation` validates account type and prevents two open
  reconciliations on the same account.
- A/R and A/P aging skip voided invoices/bills and surface a warning when
  the aging total diverges from the GL balance.
- `reopenPeriod` now blocks reopening older periods if newer year-ends exist.

### Year-end close (2 fixes)
- Hardcoded `fyStart = ${year}-01-01` (wrong for non-calendar fiscal years)
  replaced with a calculation that supports custom fiscal-year start dates.
- Running year-end-close twice for the same year is now blocked instead of
  posting two closing JEs.

### Validation hardening (across ~14 schemas)
- ISO date validation rejects `"tomorrow"`, `2026-13-99`, etc.
- All numeric IDs validated as positive integers (was accepting NaN).
- Length bounds added to every string field.
- Invoice/bill `quantity > 0` (was allowing 0).
- `dueDate >= date` enforced.
- `taxRate <= 100` enforced.
- Recurring `endDate >= startDate` enforced.
- Bank rule `categorize` / `transfer` actions require their target accounts.
- Recurring template payloads validated per-kind (FK existence, account types,
  JE balance) at create/update time.
- A JE line cannot have both debit and credit set, nor neither.

### Security (4 additions)
- Public share tokens have configurable expiry (default 90 days) and can be
  revoked via `POST /api/invoices/shares/:id/revoke`.
- Per-IP rate limiting on public endpoints (`/p/invoice/:token`, etc.) at
  60 req/min — defends against token enumeration.
- PDF Content-Disposition header is sanitized (was vulnerable to header
  injection via invoice number / customer name with `\r\n"\`).
- Plaid stubs now fail loudly when keys are present but the SDK isn't wired
  up, instead of silently returning fake tokens.

### Server hardening (4 additions)
- Body parser limit raised to 5 MB (was Express default ~100 KB) so CSV
  imports can complete.
- Response body logging only on errors (was dumping full responses for every
  request, including sensitive data and large reports).
- Graceful shutdown on SIGTERM/SIGINT — drains in-flight requests before
  exiting; prevents partial JE posts during recurring catch-up.
- `trust proxy` enabled in production so `req.ip` is correct behind nginx /
  Cloudflare.

### Frontend
- Error boundary wraps the page tree. A page crash now shows a recoverable
  error UI with stack trace and "Try again" / "Go to dashboard" actions
  (was a white screen).
- Cash flow report surfaces the actual `reconciliationGap` and any
  classification warnings when the report doesn't reconcile.

### Tests
Five test suites added:
- `cashflow_test.js` — 5 hand-crafted scenarios
- `cashflow_property_test.js` — 100 random ledgers × 4 sub-periods = 400 cases
- `balance_sheet_test.js` — 400 random scenarios verifying A = L + E
- `invoice_rounding_test.js` — tricky decimal cases
- `multi_tenant_test.js` — proves data isolation between orgs

All run via `npm test`.

### Default chart of accounts
- Added `1150 Sales Tax Receivable` for purchase-tax handling.
