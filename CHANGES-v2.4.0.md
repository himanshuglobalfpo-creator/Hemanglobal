# LedgerLite v2.4.0 — cumulative fixes over v2.3.0

## 1. P&L date-range filtering (server/storage.ts, profitAndLoss)
- BUG: the date/org predicate sat on the LEFT JOIN ON-clause for
  journal_entries; out-of-range journal_lines still aggregated, so every
  sub-period P&L was silently life-to-date. Also poisoned dashboardStats()
  and could break the balance-sheet identity via net income.
- FIX: predicate moved to WHERE with a NULL-safe guard
  `(je.id IS NULL OR (je.org_id = $1 AND je.date BETWEEN $2 AND $3))`;
  params reduced to [orgId, fromDate, toDate].
- TEST: tests/pl_date_range_test.js (Jan vs Mar sale; Jan-only P&L; balance
  sheet A = L + E as of Jan 31; documents the buggy ON-clause over-count).

## 2. Credit/debit note transactions + concurrency (server/creditNoteService.ts)
- BUG: all 14 write sites inside db.transaction blocks used the outer `db`
  handle (autocommit, outside the transaction); note/invoice reads and the
  remaining-credit check happened before the transaction with no lock →
  concurrent applies could over-apply a note, and partial failures left
  inconsistent residue.
- FIX: every write uses the `tx` handle; applyCreditNote/applyDebitNote read
  the note and invoice/bill INSIDE the tx with SELECT ... FOR UPDATE (fixed
  lock order note → invoice/bill) and re-check remaining after the lock;
  GL posts join the caller's tx via postJournalEntry(..., { _tx: tx });
  void-path JE posts are now awaited; the cross-connection touch() helper was
  removed (it would self-deadlock against the tx's own row lock) — updated_at
  is folded into the in-tx updates.
- TEST: tests/credit_note_apply_concurrency_test.ts (REAL Postgres via
  DATABASE_URL or embedded-postgres devDependency; two simultaneous applies →
  exactly one admitted; 10-way burst → exactly 5 of 10; verified to FAIL on
  the pre-fix code).

## 3. Stripe clearing account (server/stripe.ts + settings)
- BUG: checkout.session.completed posted payments to the FIRST bank-subtype
  account found (TODO in code) — arbitrary with multiple bank accounts.
- FIX: new org setting stripe_clearing_account_id (migration
  0012, FK → accounts ON DELETE RESTRICT), validated as a bank-subtype asset
  in the org. The webhook resolves the account from the setting and fails
  with "Stripe clearing account not configured" (HTTP 500 → Stripe retries)
  when unset — it never guesses. Payment-link creation and the public /pay
  route enforce the same precondition BEFORE money moves. Exposed via
  PATCH /api/orgs/:id, /api/auth/me, and /api/stripe/status
  (onlinePaymentsReady). New Settings page (nav + route) with a readiness
  checklist and bank-account selector; ship-from address UI included.
- TEST: tests/stripe_clearing_account_test.ts (real Postgres; fail-loud when
  unset; non-bank/cross-org/nonexistent rejected; RESTRICT verified; proves
  the old first-bank guess would have picked the wrong account).
- ROLLOUT NOTE: orgs already taking Stripe payments must set the clearing
  account in Settings after deploy; until then their webhooks 500-and-retry
  by design.

All tests wired into `npm test`. `tsc --noEmit`: 0 errors. Client builds.
