-- ============================================================================
-- 0028_bank_txn_payee — payee/vendor tag on categorized bank transactions
--
-- When a downloaded/imported bank transaction is categorized, it can now carry a
-- payee: a free-text name and/or a link to a vendor entity. Bank rules gain a
-- payee_vendor_id so auto-categorization can also tag the payee (QBO-style).
-- All columns nullable. Idempotent.
-- ============================================================================

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS payee     TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS vendor_id INTEGER;

ALTER TABLE bank_rules ADD COLUMN IF NOT EXISTS payee_vendor_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_bank_txn_vendor
  ON bank_transactions(vendor_id) WHERE vendor_id IS NOT NULL;
