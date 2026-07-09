-- ============================================================================
-- 0015_estimates — quotes that convert into invoices
--
-- An estimate is a sales pre-document (a quote). It posts NO journal entry.
-- Converting it runs through the existing createInvoice() path (so the per-line
-- rounding, tax and GL logic is reused, never duplicated) and links the new
-- invoice back to the estimate via invoices.estimate_id.
--
--   • estimates        — header + snapshot totals (document-currency cents).
--   • estimate_lines   — mirror invoice_lines.
--   • estimate_shares  — public read-only /p/estimate/:token view (mirrors invoice_shares).
--   • invoices.estimate_id — links a converted invoice back to its estimate.
--
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- number is per-org unique, allocated by number_sequences (kind 'estimate').
-- Every statement is idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS estimates (
  id             SERIAL PRIMARY KEY,
  org_id         INTEGER NOT NULL,
  number         TEXT    NOT NULL,
  customer_id    INTEGER NOT NULL,
  date           TEXT    NOT NULL,
  expiry_date    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'draft', -- draft|sent|accepted|declined|expired|invoiced
  currency       TEXT    NOT NULL DEFAULT '',
  fx_rate        DOUBLE PRECISION NOT NULL DEFAULT 1,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  updated_at     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_estimates_org_number ON estimates (org_id, number);
CREATE INDEX IF NOT EXISTS ix_estimates_org ON estimates (org_id);
CREATE INDEX IF NOT EXISTS ix_estimates_status ON estimates (status, expiry_date);

CREATE TABLE IF NOT EXISTS estimate_lines (
  id                SERIAL PRIMARY KEY,
  org_id            INTEGER NOT NULL,
  estimate_id       INTEGER NOT NULL,
  description       TEXT    NOT NULL,
  quantity          DOUBLE PRECISION NOT NULL DEFAULT 1,
  rate              DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount            INTEGER NOT NULL DEFAULT 0,
  income_account_id INTEGER NOT NULL,
  item_id           INTEGER
);

CREATE INDEX IF NOT EXISTS ix_estimate_lines_org_est ON estimate_lines (org_id, estimate_id);

CREATE TABLE IF NOT EXISTS estimate_shares (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL,
  estimate_id     INTEGER NOT NULL,
  token           TEXT    NOT NULL UNIQUE,
  recipient_email TEXT,
  viewed_at       TEXT,
  view_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  revoked_at      TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_estimate_shares_org ON estimate_shares (org_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS estimate_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_estimates_customer') THEN
    ALTER TABLE estimates ADD CONSTRAINT fk_estimates_customer
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_estimate_lines_estimate') THEN
    ALTER TABLE estimate_lines ADD CONSTRAINT fk_estimate_lines_estimate
      FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_estimate_lines_income_account') THEN
    ALTER TABLE estimate_lines ADD CONSTRAINT fk_estimate_lines_income_account
      FOREIGN KEY (income_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_estimate_shares_estimate') THEN
    ALTER TABLE estimate_shares ADD CONSTRAINT fk_estimate_shares_estimate
      FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_estimate') THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_estimate
      FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE SET NULL;
  END IF;
END $$;
