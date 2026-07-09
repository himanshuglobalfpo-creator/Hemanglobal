-- ============================================================================
-- 0006_multi_currency — single-rate multi-currency foundation
--
-- Model (Phase 3 scope, exactly): the GL stays 100% in the org's base
-- currency. Foreign-currency invoices/bills store BOTH the foreign cents and
-- the base cents converted at the document-date rate. Realized FX gain/loss
-- posts on payment (payment-rate vs document-rate difference). No revaluation
-- engine in this phase.
-- Legacy rows: currency='' means "org base currency", fx_rate=1, foreign_*=0.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE customers ADD COLUMN IF NOT EXISTS currency TEXT;  -- NULL = org base
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS currency TEXT;  -- NULL = org base

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS foreign_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS foreign_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS foreign_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS foreign_amount_paid INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bills ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS foreign_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS foreign_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS foreign_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS foreign_amount_paid INTEGER NOT NULL DEFAULT 0;

-- Manual/imported exchange rates. rate = base-currency units per 1 foreign
-- unit (e.g. from EUR to USD: 1.10 means €1 = $1.10).
CREATE TABLE IF NOT EXISTS fx_rates (
  org_id INTEGER NOT NULL,
  date TEXT NOT NULL,          -- YYYY-MM-DD (TEXT dates, consistent with the rest of the schema)
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  source TEXT,
  PRIMARY KEY (org_id, date, from_code, to_code)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_org ON fx_rates(org_id);
