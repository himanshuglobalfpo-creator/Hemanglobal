-- ============================================================================
-- 0005_updated_at — updated_at on core business tables + auto-touch triggers
--
-- One shared trigger function; one BEFORE UPDATE trigger per table.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and
-- DROP TRIGGER IF EXISTS before each CREATE TRIGGER.
-- Used by the optimistic-concurrency check on PATCH accounts/customers/vendors
-- (ifUnmodifiedSince → 409 when the row changed since the client read it).
-- ============================================================================

ALTER TABLE accounts            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE customers           ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE vendors             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE invoices            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE bills               ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE bank_transactions   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE bank_rules          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE recurring_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE tax_codes           ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE reconciliations     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_bills_updated_at ON bills;
CREATE TRIGGER trg_bills_updated_at BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_bank_transactions_updated_at ON bank_transactions;
CREATE TRIGGER trg_bank_transactions_updated_at BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_bank_rules_updated_at ON bank_rules;
CREATE TRIGGER trg_bank_rules_updated_at BEFORE UPDATE ON bank_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_recurring_templates_updated_at ON recurring_templates;
CREATE TRIGGER trg_recurring_templates_updated_at BEFORE UPDATE ON recurring_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tax_codes_updated_at ON tax_codes;
CREATE TRIGGER trg_tax_codes_updated_at BEFORE UPDATE ON tax_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_reconciliations_updated_at ON reconciliations;
CREATE TRIGGER trg_reconciliations_updated_at BEFORE UPDATE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
