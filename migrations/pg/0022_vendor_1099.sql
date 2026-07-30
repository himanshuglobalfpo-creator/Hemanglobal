-- ============================================================================
-- 0022_vendor_1099 — 1099 contractor tracking on vendors
--
-- track_1099: mark a vendor as 1099-reportable (contractors, freelancers).
-- tax_id:     their EIN/SSN from the W-9, printed on the form.
-- The 1099 Summary report accumulates cash paid to tracked vendors per calendar
-- year and lists those at or above the reporting threshold. Idempotent.
-- ============================================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS track_1099 BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS tax_id TEXT;
