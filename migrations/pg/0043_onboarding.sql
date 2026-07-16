-- ============================================================================
-- 0043_onboarding — activation wizard, funnel events, demo mode (P4.2)
--
-- onboarding_events records the FIRST completion timestamp of each wizard step
-- per org (funnel analysis). organizations gains demo_seeded_at (set by
-- /api/seed-demo) so the demo banner + one-click clear can find and wipe demo
-- data, and onboarding_completed_at. Idempotent.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS demo_seeded_at         TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_completed_at TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS industry               TEXT;

CREATE TABLE IF NOT EXISTS onboarding_events (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  step         TEXT NOT NULL,                 -- profile | bank | import | invite | first_invoice
  completed_at TEXT NOT NULL,
  user_id      INTEGER
);
-- One row per (org, step): the FIRST completion is what the funnel measures.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_step ON onboarding_events(org_id, step);
