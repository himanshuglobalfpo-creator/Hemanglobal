-- ============================================================================
-- 0019_payroll_liabilities — remit accrued payroll liabilities (QBO "Pay Taxes")
--
-- Running payroll accrues Payroll Taxes Payable (2300) and Payroll Deductions
-- Payable (2310). This records remittances to the tax agencies: one payment can
-- clear several liability accounts, posting Dr <liability> / Cr Bank.
--
--   • payroll_liability_payments      — remittance header + the posted JE.
--   • payroll_liability_payment_lines — per-liability-account amount remitted.
--
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- Every statement is idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_liability_payments (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL,
  pay_date        TEXT    NOT NULL,
  bank_account_id INTEGER NOT NULL,
  entry_id        INTEGER,
  memo            TEXT,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_payroll_liab_payments_org ON payroll_liability_payments (org_id);

CREATE TABLE IF NOT EXISTS payroll_liability_payment_lines (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  payment_id   INTEGER NOT NULL,
  account_id   INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_payroll_liab_payment_lines_org_payment ON payroll_liability_payment_lines (org_id, payment_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_liab_payments_bank') THEN
    ALTER TABLE payroll_liability_payments ADD CONSTRAINT fk_payroll_liab_payments_bank
      FOREIGN KEY (bank_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_liab_payments_entry') THEN
    ALTER TABLE payroll_liability_payments ADD CONSTRAINT fk_payroll_liab_payments_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_liab_payment_lines_payment') THEN
    ALTER TABLE payroll_liability_payment_lines ADD CONSTRAINT fk_payroll_liab_payment_lines_payment
      FOREIGN KEY (payment_id) REFERENCES payroll_liability_payments(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_liab_payment_lines_account') THEN
    ALTER TABLE payroll_liability_payment_lines ADD CONSTRAINT fk_payroll_liab_payment_lines_account
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;
