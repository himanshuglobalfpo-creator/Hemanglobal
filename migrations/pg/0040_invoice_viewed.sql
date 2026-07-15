-- ============================================================================
-- 0040_invoice_viewed — invoice send/viewed tracking (P3.10)
--
-- sent_at is stamped when an invoice is emailed; first/last_viewed_at are
-- stamped when the public share page is opened (page view, no tracking pixel).
-- Together they drive the Sent → Viewed → Paid status chips. Idempotent.
-- ============================================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS first_viewed_at TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_viewed_at TEXT;
