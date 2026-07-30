# LedgerLite

A multi-tenant accounting SaaS — invoices, bills, banking, double-entry journal,
period close, and the full standard report set (P&L, Balance Sheet, Trial Balance,
Cash Flow, A/R Aging, A/P Aging, General Ledger, Tax Liability).

Built with TypeScript, Express, React, Drizzle ORM, and PostgreSQL.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set APP_BASE_URL. Email/Stripe/Plaid are optional.

# 3. Run
npm run dev          # http://localhost:5000

# 4. Sign up
# Open the URL above and create your first account.
# The first user becomes the owner of a new organization.
```

### Production

```bash
docker compose up -d
```

Or without Docker:

```bash
npm run build
NODE_ENV=production npm start
```

---

## Features

### Accounting core
- **Double-entry ledger** — every transaction is a balanced journal entry.
  Debits-must-equal-credits is enforced at both the Zod and SQL layers.
- **Reports** — P&L, Balance Sheet, Trial Balance, Cash Flow Statement (indirect
  method), A/R Aging, A/P Aging, General Ledger, Tax Liability. All computed
  live from the journal — no batch jobs, no drift between reports.
- **Period close + year-end close** — supports non-calendar fiscal years.
  Closing entry posts to Retained Earnings; reopen reverses it.
- **Audit log** — every mutation is recorded with action, entity, summary, and metadata.

### Multi-tenancy
- Organizations + users + memberships. Sessions stored server-side (revocable).
- Roles: owner, admin, accountant, viewer.
- Every business table carries `org_id`. Reports and queries scope to the
  active org via AsyncLocalStorage middleware.

### Security
- bcrypt password hashing (10 rounds).
- Account lockout: 5 failed logins → 15-min cool-off.
- Server-side session table with TTL + cleanup.
- Public share tokens have configurable expiry (default 90 days) and can be revoked.
- Per-IP rate limiting on public endpoints (60 req/min).
- Per-route input validation via Zod (ISO-date validation, length bounds, etc.).

### Banking
- Manual entry, CSV import, and **Plaid** sync (cursor-based incremental).
- Bank rules engine: priority + filters + auto-post action.
- Reconciliation flow with statement balance matching.

### Invoicing
- Invoice + bill creation with sales tax. Per-line rounding ensures JEs balance exactly.
- PDF export (PDFKit-based).
- Public share links (token-based, no auth, rate-limited).
- **Stripe Checkout** integration: customer pays online → webhook auto-records the payment.

### Recurring transactions
- Templates for invoices, bills, and journal entries.
- Frequencies: daily / weekly / monthly / quarterly / yearly.
- Catch-up scheduler runs on server start (idempotent).

---

## Configuration

See `.env.example` for the complete list. Most features are optional and
gracefully no-op when their credentials are missing.

| Variable | Required | Purpose |
|---|---|---|
| `APP_BASE_URL` | Yes | Public URL of the app (used in share links) |
| `DATABASE_URL` | Yes | PostgreSQL connection string (e.g. `postgresql://user:pass@host:5432/db`) |
| `PORT` | No | HTTP port. Default `5000` |
| `SMTP_*` | No | Email sending. Without these, emails log to stdout |
| `STRIPE_SECRET_KEY` | No | Online invoice payments |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signature verification |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | No | Bank connections |
| `PLAID_ENV` | No | `sandbox` / `development` / `production` |

---

## API

The complete API is at `/api/*`. Auth-required for all endpoints except:

- `POST /api/auth/signup`, `POST /api/auth/login`, etc.
- `GET /api/health`
- `POST /api/stripe/webhook`, `POST /api/plaid/webhook`
- `GET /p/invoice/:token` (public token-based share)

Auth flow:

```bash
# Sign up
curl -X POST http://localhost:5000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery","name":"Alice","orgName":"Acme Inc."}'

# Login (sets ll_session cookie)
curl -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"correct horse battery"}'

# Use the cookie
curl http://localhost:5000/api/auth/me -b cookies.txt
```

---

## Testing

```bash
npm test
```

Runs five test suites:

| Suite | What it verifies |
|---|---|
| `cashflow_test.js` | 5 hand-crafted scenarios — bug regression coverage |
| `cashflow_property_test.js` | 100 random ledgers × 4 sub-periods = 400 cases. Reconciliation gap = exactly 0.00 in every one |
| `balance_sheet_test.js` | 400 random scenarios. Assets = Liabilities + Equity always |
| `invoice_rounding_test.js` | Invoice JEs balance for tricky decimal inputs |
| `multi_tenant_test.js` | Two orgs in one database stay completely isolated |

All five pass on every commit. Wire into CI with `npm test`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  client/  (React + Vite + Tailwind + shadcn/ui)                 │
│  └── 16 pages, all using react-query for state                  │
└─────────────────────────────────────────────────────────────────┘
                              ▼ (HTTP/JSON)
┌─────────────────────────────────────────────────────────────────┐
│  server/                                                         │
│  ├── auth.ts          — bcrypt, sessions, middleware            │
│  ├── auth-routes.ts   — signup/login/me/switch-org              │
│  ├── org-scope.ts     — AsyncLocalStorage per request           │
│  ├── routes.ts        — 100+ business endpoints                 │
│  ├── storage.ts       — accounting domain (3,400 lines)         │
│  ├── plaid.ts         — bank connections                        │
│  ├── stripe.ts        — invoice payments                        │
│  ├── pdf.ts           — invoice / statement PDFs                │
│  └── email.ts         — SMTP                                     │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL (Drizzle ORM)                                           │
│  19 tables. Every business table has org_id (FK organizations). │
│  Auto-migrations on first boot — no manual steps.               │
└─────────────────────────────────────────────────────────────────┘
```

### Why the cash flow report is correct

The cash flow statement is derived live from the journal — never stored,
never cached. The math follows the accounting identity:

```
ΔCash = ΔLiabilities + ΔEquity + NetIncome − ΔOtherAssets
```

For any well-formed (balanced) ledger, the three-section total **must** equal
the actual change in bank balances exactly. The engine includes a self-check
that surfaces a `reconciliationGap` when this invariant breaks. Across 400
randomized property tests, the gap is always 0.00.

The four classification bugs that originally caused non-zero gaps —
intangibles misclassified, Retained Earnings excluded, depreciation not added
back, NULL subtypes — are all fixed and regression-tested.

---

## Database migrations

LedgerLite uses **forward-compatible auto-migrations**. On every boot:

1. `CREATE TABLE IF NOT EXISTS …` runs for every table.
2. For tables that exist but lack newer columns (org_id, expires_at, etc.),
   `ALTER TABLE ADD COLUMN` runs guarded by PRAGMA probes — safe to run repeatedly.
3. The default organization (id=1, slug="default") is auto-created if no org exists.
4. All pre-existing rows are attributed to org_id=1 via the `DEFAULT 1` clause.

This means you can deploy a new version on top of an existing database without
running anything manually.

---

## License

MIT

## New environment variables (v2.2.0)

| Variable | Purpose |
|---|---|
| `APP_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — AES-256-GCM key for encrypting Plaid access tokens at rest; **required in production** (boot fails without it). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CSP_ENFORCE` | Set to `true` to serve the Content-Security-Policy as enforcing; otherwise it is sent as `Content-Security-Policy-Report-Only` so violations can be observed safely first. |
| `METRICS_TOKEN` | Shared secret for `GET /api/metrics` (send as `x-metrics-token` header). When unset, the metrics endpoint returns 404 and is effectively disabled. |

## Phase 3 — competitive parity (v2.3.0)

### Environment variables (full)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `APP_ENCRYPTION_KEY` | prod | 64 hex chars (32 bytes). Encrypts Plaid tokens **and** TOTP secrets at rest. Boot fails in production without it. |
| `CSP_ENFORCE` | no | `true` serves an enforcing CSP; otherwise report-only. |
| `METRICS_TOKEN` | no | Bearer for `GET /api/metrics` (`x-metrics-token`). Unset → 404. |
| `FILE_STORAGE` | no | `local` (default) or `s3`. |
| `FILE_DIR` | no | Local attachment root (default `./data/uploads`). |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_KEY` / `S3_SECRET` / `S3_REGION` | s3 | S3-compatible storage (AWS S3 / Cloudflare R2 / MinIO; SigV4, no SDK). Blobs are AES-256-GCM encrypted **before** upload — the store only ever holds ciphertext. |
| `PORT` | no | HTTP port (default 5000). |

**Migrating local → S3 (zero-downtime).** Set `FILE_STORAGE=s3` + the `S3_*`
vars and deploy. Each attachment records which backend holds it, so downloads
keep working while blobs are still on disk. An owner then drains the old store
by POSTing `/api/attachments/migrate` (batched, resumable, SHA-256 read-back
verified — a corrupt copy never replaces the source) until `remaining` is 0;
`GET /api/attachments/storage` shows the per-backend counts. `docker-compose up`
brings up a MinIO service + bucket for local dev, and CI runs the driver
contract test (`tests/file_driver_test.ts`) against MinIO.

### Migrations (apply in order; runner is automatic at boot)

`0000_init`, `0001_add_foreign_keys`, `0002_pagination_indexes`, `0003_recon_backfill`, `0004_number_sequences`, `0005_updated_at`, `0006_multi_currency`, `0007_mfa`, `0008_attachments`, `0009_budgets`, `0010_webhooks`, `0011_phase3_indexes`.

### Webhook signature verification

Every delivery carries `x-ledgerlite-event` and `x-ledgerlite-signature` (hex HMAC-SHA256 of the **raw request body** using the webhook's secret). Verify in your receiver:

```js
import crypto from "node:crypto";
function verify(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  // constant-time compare
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

Events: `invoice.created`, `invoice.paid`, `invoice.voided`, `bill.created`, `bill.paid`, `credit_note.issued`, `period.closed`. Retries: 6 attempts, backoff 1m/5m/30m/2h/12h.

### Import CSV templates

All import endpoints accept a `text/csv` body (or JSON `{ csv }`), support `?dryRun=true`, and return `{ inserted, skipped, errors[] }`.

- **customers / vendors** (`POST /api/import/customers`, `/vendors`):
  `name,email,phone,address,shipping_city,shipping_state,shipping_zip`
- **chart-of-accounts** (`POST /api/import/chart-of-accounts`):
  `code,name,type,subtype`
- **invoices** (`POST /api/import/invoices`, flat rows grouped by `number`; `?partial=true` to allow per-row skips):
  `number,customer_name,date,due_date,line_description,quantity,rate,income_account_code,tax_rate`
- **opening-balances** (`POST /api/import/opening-balances`, JSON body `{ csv, asOfDate }`; debits must equal credits):
  `account_code,debit,credit`

### Multi-currency

Org has a base currency; customers/vendors may carry a foreign currency. Foreign invoices/bills store both foreign and base cents (converted at the document-date rate). The GL is 100% base currency; realized FX gain/loss posts on payment to `4950 FX Gain` / `6950 FX Loss`. Manage rates at `GET/PUT /api/settings/fx-rates`.

### MFA (TOTP)

`POST /api/auth/mfa/setup` → `enable` (returns recovery codes once) → on login, TOTP-enabled accounts get `{ mfaRequired, mfaToken }`, completed via `POST /api/auth/mfa/verify`. Owners must enable MFA within 7 days of account creation.
