-- ============================================================================
-- 0031_invoice_form_settings — QBO-style invoice form (Manage panel)
--
-- organizations.invoice_settings: per-org JSON blob holding the Manage-panel
--   preferences (Customization field toggles, table column labels/visibility,
--   payment methods/options, design, scheduling). Validated by
--   invoiceSettingsSchema in shared/schema.ts — the DB stores whatever the
--   schema accepted, defaults live in code so they can evolve.
-- invoices.ship_to / invoices.terms: optional header fields the Customization
--   toggles reveal ("Ship to" free text; terms like "Net 30").
-- invoices.custom_fields: JSON text of {label: value} for org-defined custom
--   fields (same TEXT-JSON convention as invoices.tax_breakdown).
-- invoice_lines.service_date: optional per-line service date column.
-- All nullable / defaulted — existing rows and flows unchanged. Idempotent.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_settings JSONB NOT NULL DEFAULT '{}';

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ship_to       TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms         TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS custom_fields TEXT;

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS service_date TEXT;
