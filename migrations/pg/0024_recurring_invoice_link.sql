-- ============================================================================
-- 0024_recurring_invoice_link — link auto-generated invoices to their template
--
-- Recurring customer invoices already generate via the catch-up mechanism; this
-- records the originating template on each generated invoice so an org can see
-- (and report on) every invoice a template produced. Idempotent.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS recurring_template_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_invoices_recurring
  ON invoices(recurring_template_id) WHERE recurring_template_id IS NOT NULL;
