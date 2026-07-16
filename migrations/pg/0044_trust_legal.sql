-- ============================================================================
-- 0044_trust_legal — ToS acceptance, org deletion + retention (P4.3)
--
-- Signup records the accepted ToS/Privacy version + timestamp. "Delete
-- organization" soft-flags a deletion (deletion_scheduled_at = now + 7 days);
-- the scheduler hard-purges after the grace. A financial-records hold (default
-- on, 7 years) EXCLUDES the audit log and closed-period journal entries from
-- that purge. Idempotent.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at      TEXT;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_requested_at   TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_scheduled_at   TEXT;   -- hard-purge on/after this (7-day grace)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS financial_records_hold  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS retention_years         INTEGER NOT NULL DEFAULT 7;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purged_at               TEXT;    -- set when the purge has run
CREATE INDEX IF NOT EXISTS idx_org_deletion_due ON organizations(deletion_scheduled_at);
