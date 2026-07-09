-- ============================================================================
-- Migration 002_money_to_cents — REAL dollars → INTEGER cents
-- ============================================================================
-- Every money column moves from REAL (float dollars) to INTEGER (cents):
-- $10.99 = 1099. Floating point caused rounding drift on decimal inputs and
-- was the #1 data-integrity risk. Integer cents make all ledger math EXACT.
--
-- Columns converted (× 100, rounded):
--   journal_lines:            debit, credit
--   invoices:                 subtotal, tax, total, amount_paid
--   invoice_lines:            amount
--   bills:                    subtotal, tax, total, amount_paid
--   bill_lines:               amount
--   bank_transactions:        amount
--   bank_rules:               amount_min, amount_max
--   reconciliations:          beginning_balance, ending_balance
--   credit_notes:             subtotal, tax, total, applied_amount, remaining_credit
--   credit_note_lines:        amount
--   credit_note_applications: amount_applied
--   debit_notes:              subtotal, tax, total, applied_amount, remaining_debit
--   debit_note_lines:         amount
--   debit_note_applications:  amount_applied
--
-- NOT converted (stay REAL, by design):
--   *.quantity            — not money
--   tax_codes.rate        — a percentage (8.875), not money
--   *_lines.rate          — unit price INPUT in dollars (may be sub-cent, e.g.
--                           $0.0025/unit); every LEDGER amount derived from it
--                           is integer cents via Math.round(qty * rate * 100)
--
-- SQLite note: SQLite has no ALTER COLUMN TYPE, and column affinity is advisory
-- — INTEGER values stored in a REAL-affinity column remain exact integers up to
-- 2^53, which covers $90 trillion in cents. Converting the VALUES (× 100 with
-- rounding) is therefore the operative change; new databases additionally get
-- INTEGER column affinity from the updated CREATE TABLE DDL in initSchema().
-- This migration is applied exactly once, tracked in schema_migrations.

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Guard: bail out (no-op) if already applied. Enforced programmatically in
-- initSchema(); kept here as documentation of the idempotency contract.

UPDATE journal_lines SET
  debit  = CAST(ROUND(debit  * 100) AS INTEGER),
  credit = CAST(ROUND(credit * 100) AS INTEGER);

UPDATE invoices SET
  subtotal    = CAST(ROUND(subtotal    * 100) AS INTEGER),
  tax         = CAST(ROUND(tax         * 100) AS INTEGER),
  total       = CAST(ROUND(total       * 100) AS INTEGER),
  amount_paid = CAST(ROUND(amount_paid * 100) AS INTEGER);

UPDATE invoice_lines SET
  amount = CAST(ROUND(amount * 100) AS INTEGER);

UPDATE bills SET
  subtotal    = CAST(ROUND(subtotal    * 100) AS INTEGER),
  tax         = CAST(ROUND(tax         * 100) AS INTEGER),
  total       = CAST(ROUND(total       * 100) AS INTEGER),
  amount_paid = CAST(ROUND(amount_paid * 100) AS INTEGER);

UPDATE bill_lines SET
  amount = CAST(ROUND(amount * 100) AS INTEGER);

UPDATE bank_transactions SET
  amount = CAST(ROUND(amount * 100) AS INTEGER);

UPDATE bank_rules SET
  amount_min = CASE WHEN amount_min IS NULL THEN NULL ELSE CAST(ROUND(amount_min * 100) AS INTEGER) END,
  amount_max = CASE WHEN amount_max IS NULL THEN NULL ELSE CAST(ROUND(amount_max * 100) AS INTEGER) END;

UPDATE reconciliations SET
  beginning_balance = CAST(ROUND(beginning_balance * 100) AS INTEGER),
  ending_balance    = CAST(ROUND(ending_balance    * 100) AS INTEGER);

UPDATE credit_notes SET
  subtotal         = CAST(ROUND(subtotal         * 100) AS INTEGER),
  tax              = CAST(ROUND(tax              * 100) AS INTEGER),
  total            = CAST(ROUND(total            * 100) AS INTEGER),
  applied_amount   = CAST(ROUND(applied_amount   * 100) AS INTEGER),
  remaining_credit = CAST(ROUND(remaining_credit * 100) AS INTEGER);

UPDATE credit_note_lines SET
  amount = CAST(ROUND(amount * 100) AS INTEGER);

UPDATE credit_note_applications SET
  amount_applied = CAST(ROUND(amount_applied * 100) AS INTEGER);

UPDATE debit_notes SET
  subtotal        = CAST(ROUND(subtotal        * 100) AS INTEGER),
  tax             = CAST(ROUND(tax             * 100) AS INTEGER),
  total           = CAST(ROUND(total           * 100) AS INTEGER),
  applied_amount  = CAST(ROUND(applied_amount  * 100) AS INTEGER),
  remaining_debit = CAST(ROUND(remaining_debit * 100) AS INTEGER);

UPDATE debit_note_lines SET
  amount = CAST(ROUND(amount * 100) AS INTEGER);

UPDATE debit_note_applications SET
  amount_applied = CAST(ROUND(amount_applied * 100) AS INTEGER);

INSERT OR IGNORE INTO schema_migrations (name) VALUES ('002_money_to_cents');

COMMIT;

-- ============================================================================
-- ROLLBACK — integer cents → REAL dollars (÷ 100)
-- ============================================================================
-- Run ONLY if reverting to a pre-cents build. Reverses every conversion above.
--
-- BEGIN TRANSACTION;
--
-- UPDATE journal_lines SET debit = debit / 100.0, credit = credit / 100.0;
-- UPDATE invoices SET subtotal = subtotal / 100.0, tax = tax / 100.0,
--   total = total / 100.0, amount_paid = amount_paid / 100.0;
-- UPDATE invoice_lines SET amount = amount / 100.0;
-- UPDATE bills SET subtotal = subtotal / 100.0, tax = tax / 100.0,
--   total = total / 100.0, amount_paid = amount_paid / 100.0;
-- UPDATE bill_lines SET amount = amount / 100.0;
-- UPDATE bank_transactions SET amount = amount / 100.0;
-- UPDATE bank_rules SET
--   amount_min = CASE WHEN amount_min IS NULL THEN NULL ELSE amount_min / 100.0 END,
--   amount_max = CASE WHEN amount_max IS NULL THEN NULL ELSE amount_max / 100.0 END;
-- UPDATE reconciliations SET beginning_balance = beginning_balance / 100.0,
--   ending_balance = ending_balance / 100.0;
-- UPDATE credit_notes SET subtotal = subtotal / 100.0, tax = tax / 100.0,
--   total = total / 100.0, applied_amount = applied_amount / 100.0,
--   remaining_credit = remaining_credit / 100.0;
-- UPDATE credit_note_lines SET amount = amount / 100.0;
-- UPDATE credit_note_applications SET amount_applied = amount_applied / 100.0;
-- UPDATE debit_notes SET subtotal = subtotal / 100.0, tax = tax / 100.0,
--   total = total / 100.0, applied_amount = applied_amount / 100.0,
--   remaining_debit = remaining_debit / 100.0;
-- UPDATE debit_note_lines SET amount = amount / 100.0;
-- UPDATE debit_note_applications SET amount_applied = amount_applied / 100.0;
--
-- DELETE FROM schema_migrations WHERE name = '002_money_to_cents';
--
-- COMMIT;
