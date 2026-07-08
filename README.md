# LedgerLite

Multi-tenant, double-entry accounting SaaS. Node 20+ / TypeScript / Express /
SQLite (better-sqlite3) / Zod. Vanilla-JS single-page client served statically.

**Global rules** (enforced everywhere):

- Every business row is **org-scoped** (`org_id` column + index + FK).
- Multi-statement writes run inside **transactions** (`db.transaction`).
- Money is **integer cents**; dates are **TEXT `YYYY-MM-DD`** (so
  `substr(date,1,7)` is an exact month bucket — used by the monthly P&L).
- Validation lives in **`shared/schema.ts`** (Zod).
- Schema changes are **numbered idempotent migrations** in `migrations/`,
  applied once each and recorded in `schema_migrations`.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm run check        # tsc --noEmit
npm test             # tsc --noEmit + node --test (24 tests)
```

Register an account in the UI — this creates your org, seeds the chart of
accounts (including FX Gain 4950 / FX Loss 6950), and signs you in as owner.

## Environment variables

| Variable       | Default                      | Purpose |
|----------------|------------------------------|---------|
| `PORT`         | `3000`                       | HTTP port |
| `DATA_DIR`     | `./data`                     | Root for SQLite DB + local uploads |
| `DB_PATH`      | `./data/ledgerlite.db`       | SQLite file (`:memory:` when `NODE_ENV=test`) |
| `VAULT_KEY`    | dev fallback (change it!)    | Key for crypto-vault v1 (AES-256-GCM) — encrypts TOTP secrets |
| `FILE_STORAGE` | `local`                      | Attachment driver: `local` or `s3` |
| `FILE_DIR`     | `./data/uploads`             | Local attachment directory (`<orgId>/<uuid>` keys) |
| `S3_ENDPOINT`  | —                            | S3-compatible endpoint (required for `FILE_STORAGE=s3`) |
| `S3_BUCKET`    | —                            | Bucket name |
| `S3_KEY`       | —                            | Access key id |
| `S3_SECRET`    | —                            | Secret access key |
| `S3_REGION`    | `us-east-1`                  | SigV4 region |
| `NODE_ENV`     | —                            | `production` enables secure cookies; `test` uses in-memory DB |

## Migrations

| File | Contents |
|------|----------|
| `0001_init.sql` | Base schema: orgs, users, org_users, sessions, accounts, customers, vendors, journal, invoices/lines, bills/lines, credit_notes, bank_transactions, closed_periods, audit_log |
| `0002_multi_currency.sql` | Customer/vendor `currency`; invoice/bill `currency`, `fx_rate`, `foreign_*` cents; `fx_rates` table |
| `0003_mfa.sql` | `users.totp_secret` (vault-encrypted), `totp_enabled`, `recovery_codes`; `mfa_challenges` |
| `0004_attachments.sql` | `attachments` (entity-typed, org-scoped) |
| `0005_budgets.sql` | `budgets`, `budget_lines` (month 1–12, integer cents) |
| `0006_webhooks.sql` | `webhooks`, `webhook_deliveries` |
| `0007_hot_path_indexes.sql` | Composite indexes for paginated lists, party reports, P&L/budget aggregation, webhook due-scan, audit filters |

## Multi-currency model (single-rate, phase 1)

- Each org has a **base currency**; the GL is 100% base currency.
- Customers/vendors may carry a foreign currency (NULL = base).
- A foreign invoice/bill stores **both** foreign cents and base cents converted
  at the **document-date rate** — rounded **per line, then summed**.
- No revaluation engine: realized FX gain/loss only, **on payment**.
  Example: €100 invoice @ 1.10 books \$110 to A/R. Paying €100 @ 1.08 books
  \$108 to bank and \$2 to **6950 FX Loss** (rate 1.12 would credit
  **4950 FX Gain** \$2). The final payment on a document relieves the exact
  remaining base balance, so per-payment rounding can never strand a cent.
- Manual rates: `GET/PUT /api/settings/fx-rates`. An explicit `fxRate` on a
  document wins; otherwise the latest stored rate on/before the document date
  is used; otherwise the request is rejected with `FX_RATE_REQUIRED`.

## MFA (TOTP)

- Dependency-free RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step) in `server/totp.ts`
  — verified against the RFC test vectors in `tests/totp.test.ts`.
- Flow: `POST /api/auth/mfa/setup` → `POST /api/auth/mfa/enable {code}`
  (returns 8 single-use recovery codes **once**; stored bcrypt-hashed).
  Login on an MFA account returns `{ mfaRequired, mfaToken }` (5-minute
  single-use challenge, **not** a session) → `POST /api/auth/mfa/verify
  { mfaToken, code | recoveryCode }`. Verify is rate-limited to 5/min/token.
- Enforcement: owners get a 7-day grace period from account creation; after
  that the business API returns `403 {"code":"MFA_REQUIRED"}` until enrolled
  (auth routes stay open so enrollment is always possible).
- TOTP secrets are encrypted at rest with crypto-vault v1
  (`v1:<iv>:<tag>:<ct>`, AES-256-GCM, key from `VAULT_KEY`).

## Attachments

Upload contract (deliberately **not** multipart): send raw file bytes as the
body with the file's `Content-Type`, metadata in the query string —
`POST /api/attachments?entityType=bill&entityId=7&filename=receipt.pdf`.
Rationale: `express.raw` with a 10 MB limit is fewer moving parts than a
hand-rolled multipart parser (no boundary/encoding edge cases) and works from
`fetch`/`curl` one-liners. Mime whitelist: pdf, png, jpg, webp, csv, xlsx.
The entity must exist **and belong to your org** — cross-org access is a 404.
Drivers: `local` (default) or `s3` (SigV4 with plain `fetch`, no SDK).

## Reports

All under `/api/reports/*`, all accept `?from=&to=` and **`?format=csv`**
(RFC 4180 via `server/csv.ts`, CRLF, quotes doubled — opens cleanly in Excel):
`trial-balance`, `sales-by-customer`, `expenses-by-vendor`,
`profit-loss-monthly` (one column per calendar month), and
`budget-vs-actual?budgetId=` (variance is favorable-positive: income above
budget / expense below budget; actuals use the same aggregation as the P&L so
the two always tie).

## Data import

`POST /api/import/{customers|vendors|chart-of-accounts|invoices|opening-balances}`
with a `text/csv` body (or JSON `{"csv":"..."}`). All support `?dryRun=true`
(full run inside a transaction, then rolled back — the report is exactly what
a real run would do). Invoices support `?partial=true` (per-row SAVEPOINTs);
otherwise any row error rejects the whole file. Opening balances require
`?asOfDate=YYYY-MM-DD`, must balance to the cent (the error reports the exact
difference), and post exactly **one** journal entry with source
`opening_balance`. Response shape:
`{ inserted, skipped, errors: [{row, message}], dryRun }`.
CSV templates live in [`templates/`](templates/).

## Webhooks

- CRUD under `/api/webhooks` (owner/admin). Events: `invoice.created`,
  `invoice.paid`, `invoice.voided`, `bill.created`, `bill.paid`,
  `credit_note.issued`, `period.closed` (+ `ping` for tests).
- Events are enqueued **after** the business transaction commits, never inside.
- Delivery worker: 30 s unref'd interval, 10 s fetch timeout, backoff
  1m/5m/30m/2h/12h, max 6 attempts, marks success on 2xx.
- SSRF guard at create **and** delivery time: hostnames are resolved and
  loopback/RFC1918/link-local/CGNAT/v6-private ranges are rejected
  (e.g. `http://169.254.169.254` → `400 SSRF_BLOCKED`); redirects are refused.

### Verifying a signature (receiver side)

```js
import crypto from "node:crypto";

app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
  const expected = crypto
    .createHmac("sha256", process.env.LEDGERLITE_WEBHOOK_SECRET) // shown once at creation
    .update(req.body) // RAW body bytes — do not re-serialize
    .digest("hex");
  const got = req.headers["x-ledgerlite-signature"] ?? "";
  const ok = got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  if (!ok) return res.status(401).end();
  const event = req.headers["x-ledgerlite-event"];
  // ... handle JSON.parse(req.body)
  res.status(200).end();
});
```

## Audit log

`GET /api/audit-log` (owner/admin/accountant) with filters `userId`,
`entityId`, `entityType`, `action`, `from`, `to`, and free-text `q` against
the summary (LIKE with `%`/`_` escaped), paginated, plus `?format=csv`.
Client page at `#/audit`.

## Production sweep notes (org-scoping audit)

Every query over business tables carries an `org_id` predicate. The
intentionally global exceptions, each commented in code:

1. `server/auth.ts` — `sessions` lookups/deletes are keyed by a 256-bit
   opaque token (the credential itself); `users`/`org_users` lookups are
   pre-auth by definition.
2. `server/routes.ts` (auth section) — `users` / `mfa_challenges` by unique
   email / token / authenticated user id: these are account-level, not
   org-level, tables.
3. `server/index.ts` — boot-time `SELECT id FROM orgs` to run the idempotent
   FX-account seed for every org.
4. `server/webhooks.ts` — the delivery worker drains due deliveries across
   all orgs by design; rows are addressed only by primary key and carry
   their own `org_id`.

Hot-path `EXPLAIN QUERY PLAN` results (all index-backed) are what migration
`0007_hot_path_indexes.sql` was written against: paginated invoice list →
`idx_invoices_org_date_id`; sales-by-customer → `idx_invoices_org_date_id`
range scan; P&L / budget-vs-actual → `idx_jl_org_account` + PK joins;
webhook due-scan → `idx_wh_deliveries_due`.

## Printable documents

Invoice documents and customer statements are print-ready HTML
(`/api/invoices/:id/document`, `/api/customers/:id/statement`) rendered with
`formatMoney(cents, currency)` — the **document** currency for foreign
invoices, base for everything else. Browser print-to-PDF produces the PDF,
keeping the server dependency-free.
