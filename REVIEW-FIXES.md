# LedgerLite v1.1.0 — Production-Readiness Review Fixes

Every item below was found by code audit (no assumptions) and verified by
typecheck (`npm run check`), production build (`npm run build`), and the test
suite (`npm test` — 6 files, all passing).

## Critical: multi-tenant isolation

| Fix | Files |
|---|---|
| Insert schemas accepted a client-supplied `orgId` (mass assignment) and defaulted missing values to org 1 — customers/vendors/accounts from tenant #2+ were written into **org 1's books**. Schemas now `.omit({ orgId })`; storage stamps `currentOrgId()` on every insert. | `shared/schema.ts`, `server/storage.ts` |
| Global search had no `org_id` filter on any of its 7 queries — every tenant could search every other tenant's customers, vendors, accounts, invoices, bills, journal entries, and bank transactions. All 7 now org-filtered. | `server/storage.ts` |
| IDOR on mutations: `updateAccount`, `updateTaxCode`, `deleteTaxCode`, `deleteCustomer`, `deleteVendor`, `updateBankRule`, `deleteBankRule`, `updateRecurring`, `deleteRecurring`, `reopenPeriod`, `reclassifyLines`, `createInvoiceShare` operated on raw IDs with no org check. All now verify ownership and scope their WHERE clauses. `reclassifyLines` additionally validates every submitted journal-line ID belongs to the active org before the bulk UPDATE. | `server/storage.ts` |
| `currentOrgId()` silently fell back to org 1 when called outside a request context (fail-open). It now throws (fail-closed). Out-of-request flows use explicit contexts: recurring catch-up runs each template inside `withOrg(template.orgId)`; share-link resolution runs inside `withOrg(share.orgId)`. | `server/org-scope.ts`, `server/storage.ts` |
| Public invoice share links only worked for org 1 (the invoice lookup ran with no org context). Now resolved in the share row's own org. | `server/storage.ts` |
| `yearEndClose` looked up Retained Earnings (3100) and prior year-end locks **across all orgs**; `reopenPeriod`'s "newer locks exist" check did the same. All org-scoped. | `server/storage.ts` |
| Stripe webhook defaulted missing `orgId` metadata to org 1 — a payment could post to the wrong tenant's ledger. Sessions without valid `invoiceId` + `orgId` metadata are now acknowledged-and-ignored with an error log. The `/pay` redirect takes the org from the share row and refuses to guess. | `server/stripe.ts` |
| New organizations received **no chart of accounts** (seeding ran once, into org 1) — tenant #2+ couldn't invoice, pay bills, or close a year. Added `seedOrgDefaults(orgId)`, called on signup and `POST /api/orgs`. | `server/storage.ts`, `server/auth-routes.ts` |
| Audit log listing leaked all orgs' entries; entries recorded `user: "system"` for everything. Now org-scoped and records the acting user ID. | `server/storage.ts` |

## Critical: security (non-tenancy)

- **Stored XSS on the public invoice page**: customer name/email/address, invoice
  number, status, notes, and line descriptions were interpolated into HTML
  unescaped. Added `escapeHtml()` applied to every interpolation. Stripe error
  pages no longer echo raw exception text into HTML. (`server/routes.ts`, `server/stripe.ts`)
- **Rate limiting on credential endpoints**: login, signup, and both password-reset
  endpoints now share a 30-req/15-min-per-IP limiter (the existing per-account
  lockout only covered single-account attacks). Limiters extracted to
  `server/rate-limit.ts`.
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, and HSTS on secure production
  requests. (`server/index.ts`)

## Completed pending features

- **Login / signup / forgot-password / reset-password UI** — the auth backend
  existed but the frontend had no way to authenticate; every API call would
  401 with no recourse. Added `client/src/pages/Auth.tsx` and an `AuthGate` in
  `App.tsx`, plus an account section in the sidebar with an **organization
  switcher** (multi-org users) and **logout**. Switching orgs clears the query
  cache so no stale tenant data lingers.
- **Plaid Link** — the "Connect with Plaid" button was an acknowledged stub.
  Now a full flow via `react-plaid-link`: link-token → Plaid Link UI →
  public-token exchange (bound to the selected chart-of-accounts bank account)
  → immediate first transaction sync.
- **Password-reset and invite emails are actually sent** through the existing
  SMTP module (`sendEmail`); previously tokens were only logged in dev and
  silently dropped in production. Existing users added to an org get a
  notification email. Reset links use the hash-router format
  (`/#/reset-password?token=…`) that the new Auth page parses.

## Build / compile fixes (release previously did not build)

- `recharts` (used by Dashboard) and `@tailwindcss/typography` (required by
  `tailwind.config.ts`) were missing from `package.json` — production build
  failed. Added, along with `cmdk` and `@radix-ui/react-switch` used by shipped
  UI components.
- Removed 30 unused shadcn/ui components that imported ~20 uninstalled packages
  (they broke `tsc --noEmit` and invited accidental use).
- `bankRuleSchema.partial()` / `createRecurringSchema.partial()` were called on
  refined Zod schemas where `.partial()` does not exist — both PATCH endpoints
  could not compile. Split into base + refined schemas; added
  `bankRuleUpdateSchema` and `updateRecurringSchema`. Storage re-validates
  cross-field invariants against the **merged** record on PATCH.
- Pinned `@types/express` to v4 (was v5 against `express@4`, causing
  `string | string[]` param type errors).
- Dockerfile copied client assets from a path Vite never writes to
  (`client/dist`); the build outputs to `dist/public`, which the server-bundle
  copy already includes.

## Tests

- Added `tests/schema_tenancy_test.ts` — runs against the **real**
  `shared/schema.ts` and proves request bodies cannot set `orgId`, plus
  exercises the new PATCH schemas. Wired into `npm test`.
- Caveat, stated plainly: `multi_tenant_test.js` tests a *mirror* of the
  storage logic, not the live storage layer — which is exactly how the bugs
  above shipped. Recommended next step: an HTTP-level test that boots the real
  server with two signed-up orgs and asserts cross-tenant 404s on every
  mutation route.

## Known remaining work (deliberate, documented)

1. **SQLite → Postgres before horizontal scaling.** `reusePort` multi-process
   and the in-memory rate limiter are single-node patterns; Drizzle makes the
   port mechanical, and Postgres row-level security would add a second tenancy
   net beneath the application layer.
2. Stripe deposit account is "first bank-subtype account in the org" — should
   become an org setting (TODO retained in `server/stripe.ts`).
3. Plaid webhook is acknowledged but not signature-verified (Plaid JWT
   verification) and does not auto-trigger syncs.
4. Email verification at signup (tokens are generated and stored, but no
   verification email/route yet).
5. Content-Security-Policy header — needs testing against Plaid Link and
   Stripe Checkout embeds before enabling.
