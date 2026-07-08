-- 0002_multi_currency.sql — TASK 1 foundation (single-rate model).
-- customers/vendors: NULL currency = org base currency.
ALTER TABLE customers ADD COLUMN currency TEXT NULL;
ALTER TABLE vendors ADD COLUMN currency TEXT NULL;

-- invoices/bills: '' currency = org base (legacy rows); foreign_* columns
-- hold DOCUMENT-currency cents; subtotal/tax/total/amount_paid stay BASE cents.
ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN foreign_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN foreign_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN foreign_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN foreign_amount_paid INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bills ADD COLUMN currency TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE bills ADD COLUMN foreign_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN foreign_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN foreign_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN foreign_amount_paid INTEGER NOT NULL DEFAULT 0;

-- Manual/imported exchange rates.
CREATE TABLE IF NOT EXISTS fx_rates (
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  date TEXT NOT NULL,
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (org_id, date, from_code, to_code)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_org ON fx_rates(org_id);
