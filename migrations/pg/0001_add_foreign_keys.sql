-- ============================================================================
-- 0001_add_foreign_keys — referential integrity for LedgerLite
--
-- PostgreSQL does not support "ADD CONSTRAINT IF NOT EXISTS", so every
-- constraint is added inside a DO block that checks pg_constraint first.
-- This makes the migration idempotent: re-running it (or running it against a
-- database where some constraints were added manually) is a no-op.
--
-- ON DELETE semantics:
--   CASCADE  — child rows are meaningless without the parent (lines, items,
--              applications, memberships, sessions).
--   RESTRICT — the parent is referenced by immutable ledger history; deleting
--              it would orphan financial records (accounts, customers,
--              vendors, invoices, bills referenced by applications).
--   SET NULL — the reference is informational; the row remains valid without
--              it (bank_transactions.entry_id, period_locks.closing_entry_id).
-- ============================================================================

DO $$
BEGIN

  -- --------------------------------------------------------------------------
  -- journal_lines
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_entry') THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT fk_journal_lines_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_lines_account') THEN
    ALTER TABLE journal_lines
      ADD CONSTRAINT fk_journal_lines_account
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;

  -- --------------------------------------------------------------------------
  -- invoices / invoice_lines
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_customer') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT fk_invoices_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_lines_invoice') THEN
    ALTER TABLE invoice_lines
      ADD CONSTRAINT fk_invoice_lines_invoice
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
  END IF;

  -- --------------------------------------------------------------------------
  -- bills / bill_lines
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_vendor') THEN
    ALTER TABLE bills
      ADD CONSTRAINT fk_bills_vendor
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_bill') THEN
    ALTER TABLE bill_lines
      ADD CONSTRAINT fk_bill_lines_bill
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE;
  END IF;

  -- --------------------------------------------------------------------------
  -- bank_transactions
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bank_transactions_bank_account') THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT fk_bank_transactions_bank_account
      FOREIGN KEY (bank_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bank_transactions_entry') THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT fk_bank_transactions_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;

  -- --------------------------------------------------------------------------
  -- reconciliations / reconciliation_items
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reconciliations_bank_account') THEN
    ALTER TABLE reconciliations
      ADD CONSTRAINT fk_reconciliations_bank_account
      FOREIGN KEY (bank_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reconciliation_items_reconciliation') THEN
    ALTER TABLE reconciliation_items
      ADD CONSTRAINT fk_reconciliation_items_reconciliation
      FOREIGN KEY (reconciliation_id) REFERENCES reconciliations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reconciliation_items_bank_transaction') THEN
    ALTER TABLE reconciliation_items
      ADD CONSTRAINT fk_reconciliation_items_bank_transaction
      FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
  END IF;

  -- --------------------------------------------------------------------------
  -- period_locks
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_period_locks_closing_entry') THEN
    ALTER TABLE period_locks
      ADD CONSTRAINT fk_period_locks_closing_entry
      FOREIGN KEY (closing_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;

  -- --------------------------------------------------------------------------
  -- credit notes (AR)
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_notes_customer') THEN
    ALTER TABLE credit_notes
      ADD CONSTRAINT fk_credit_notes_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_note_applications_credit_note') THEN
    ALTER TABLE credit_note_applications
      ADD CONSTRAINT fk_credit_note_applications_credit_note
      FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_note_applications_invoice') THEN
    ALTER TABLE credit_note_applications
      ADD CONSTRAINT fk_credit_note_applications_invoice
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT;
  END IF;

  -- --------------------------------------------------------------------------
  -- debit notes (AP)
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_debit_notes_vendor') THEN
    ALTER TABLE debit_notes
      ADD CONSTRAINT fk_debit_notes_vendor
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_debit_note_applications_debit_note') THEN
    ALTER TABLE debit_note_applications
      ADD CONSTRAINT fk_debit_note_applications_debit_note
      FOREIGN KEY (debit_note_id) REFERENCES debit_notes(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_debit_note_applications_bill') THEN
    ALTER TABLE debit_note_applications
      ADD CONSTRAINT fk_debit_note_applications_bill
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT;
  END IF;

  -- --------------------------------------------------------------------------
  -- auth / multi-tenancy
  -- --------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_org_memberships_user') THEN
    ALTER TABLE org_memberships
      ADD CONSTRAINT fk_org_memberships_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_org_memberships_org') THEN
    ALTER TABLE org_memberships
      ADD CONSTRAINT fk_org_memberships_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_user') THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;

END $$;
