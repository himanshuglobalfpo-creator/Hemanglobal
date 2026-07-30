# v2.1.2 — Fix & Verification Report

This build corrects the three reconciliation cross-tenant bugs (M1/M2/M3) found
in the v2.1.1 audit and adds a CI guard against the whole bug class. Below is
exactly what changed and how it was verified.

## Fixes applied

| ID | Severity | File | Change |
|----|----------|------|--------|
| M1 | HIGH (read leak) | server/storage.ts `getReconciliation()` | Reconciliation lookup now filters `eq(reconciliations.orgId, currentOrgId())`. Also protects `completeReconciliation()`, which calls it. Route affected: `GET /api/reconciliations/:id`. |
| M2 | HIGH (write leak) | server/storage.ts `toggleReconItem()` | Reconciliation lookup now org-scoped. Route affected: `POST /api/reconciliations/:id/toggle`. |
| M3 | MEDIUM (data integrity) | server/storage.ts `toggleReconItem()` + shared/schema.ts + migrations/pg/0003 | Insert now sets `orgId: currentOrgId()`. Schema `orgId` no longer has `.default(1)`. Migration 0003 backfills legacy `reconciliation_items.org_id` from the parent reconciliation and drops the DB default. |
| — | Defense-in-depth | server/storage.ts | Added explicit `orgId` filters to: void/unmatch payment + original journal-entry lookups, `getJournalLinesForAccount()`, and the `startReconciliation()` open-reconciliation check. |
| — | Prevention | tests/org_scope_guard_test.ts | New CI gate; wired into `npm test`. |

## Verification performed (in this environment)

- **`tsc --noEmit`: 0 errors.**
- **Org-scope guard: PASSES** on the fixed code. Negative-tested: removing the
  `orgId` filter from `getReconciliation` makes the guard FAIL at that exact
  line (exit 1); restoring it passes. The guard checked 110 business-table
  queries against an 18-entry, per-(method,table) allowlist.
- **All logic/property tests pass:** cashflow, cashflow property (400 randomized
  scenarios, gap = $0.00), balance sheet (A = L + E), invoice rounding,
  multi-tenant isolation (in-memory harness), schema tenancy, taxjar logic, and
  the journal-balance-cents test (the v2.1.1 float-equality fix).

## Tests NOT run here (require a live PostgreSQL)

Two integration tests import `server/storage.ts` directly, which requires
`DATABASE_URL`:

- `tests/credit_debit_note_test.ts`
- `tests/invoice_statement_effect_test.ts`

These fail with "DATABASE_URL is not set" in any environment without Postgres —
including the original v2.1.1 — so this is a pre-existing harness requirement,
NOT a regression introduced by these fixes. Run them locally against your dev
database:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/ledgerlite npm test
```

## MANDATORY manual check before you deploy

Automated static analysis proves the filters are present; only a live two-tenant
test proves isolation end-to-end. After running migrations (including 0003):

1. Create Org A and Org B with separate users.
2. As Org A, create a reconciliation; note its numeric id.
3. As Org B: `GET /api/reconciliations/<Org A id>` → expect "not found", never
   Org A's data.
4. As Org B: `POST /api/reconciliations/<Org A id>/toggle` → expect "not found";
   Org A's reconciliation must be unchanged.
5. As Org B, start a reconciliation, toggle an item, then:
   `SELECT org_id FROM reconciliation_items ORDER BY id DESC LIMIT 1;`
   → must equal Org B's org id, not 1.

Only after all five pass are you clear to begin Phase 2.

## Migration note

Migration `0003_recon_items_org_backfill.sql` must run before this build serves
traffic. It is idempotent (safe to re-run). If you have existing
`reconciliation_items` rows created by v2.1.1 or earlier, they were tagged
`org_id = 1`; the backfill corrects them from the parent reconciliation.
