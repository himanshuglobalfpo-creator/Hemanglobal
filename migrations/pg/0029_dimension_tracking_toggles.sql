-- ============================================================================
-- 0029_dimension_tracking_toggles — per-org enable switches for dimensions
--
-- QBO-style: an org turns Class / Location / Project tracking ON before the
-- dimension pickers appear in the UI. These booleans gate the UI only — the
-- data-integrity control stays server-side (assertDimensions org-scoping). All
-- default false (tracking off) so existing orgs are unchanged. Idempotent.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enable_class_tracking    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enable_location_tracking BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enable_project_tracking  BOOLEAN NOT NULL DEFAULT false;
