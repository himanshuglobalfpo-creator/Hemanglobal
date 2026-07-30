-- ============================================================================
-- 0038_tax_filing — sales-tax filing workflow
--
-- A filing period per nexus state, cadence-driven. Liability is the tax
-- collected in the period scoped to the state's tax codes (each invoice's tax
-- equals its Sales Tax Payable credit, so this equals the sum of the tax JE
-- lines). "Record payment" posts Dr Sales Tax Payable / Cr Bank, clearing the
-- period's payable to zero. Idempotent.
-- ============================================================================

-- Associate a tax code with a state so filings can scope to it.
ALTER TABLE tax_codes ADD COLUMN IF NOT EXISTS state_code TEXT;

CREATE TABLE IF NOT EXISTS tax_filing_periods (
  id                   SERIAL PRIMARY KEY,
  org_id               INTEGER NOT NULL,
  state_code           TEXT NOT NULL,                 -- 2-char, uppercase
  cadence              TEXT NOT NULL DEFAULT 'quarterly', -- monthly | quarterly | annual
  period_start         TEXT NOT NULL,                 -- YYYY-MM-DD inclusive
  period_end           TEXT NOT NULL,                 -- YYYY-MM-DD inclusive
  due_date             TEXT NOT NULL,                 -- YYYY-MM-DD filing/payment due
  status               TEXT NOT NULL DEFAULT 'open',  -- open | filed | paid
  liability_cents      BIGINT NOT NULL DEFAULT 0,     -- snapshot at filing time
  confirmation_number  TEXT,
  filed_date           TEXT,
  paid_date            TEXT,
  payment_entry_id     INTEGER,                       -- FK to the payment journal entry
  reminder_sent        BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tfp_unique ON tax_filing_periods(org_id, state_code, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_tfp_due ON tax_filing_periods(status, due_date);
