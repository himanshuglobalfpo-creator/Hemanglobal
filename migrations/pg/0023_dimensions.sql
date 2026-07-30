-- ============================================================================
-- 0023_dimensions — class & location (dimensional) tracking
--
-- Two definition tables (classes, locations) plus optional class_id/location_id
-- on journal_lines (the GL truth reports filter on) and on invoice_lines /
-- bill_lines (which propagate their dimensions onto the posted GL lines).
-- All columns are nullable — dimensions are opt-in. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS classes (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_classes_org ON classes(org_id);

CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_locations_org ON locations(org_id);

ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS class_id    INTEGER;
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS location_id INTEGER;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS class_id    INTEGER;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS location_id INTEGER;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS class_id    INTEGER;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS location_id INTEGER;

-- Partial indexes so dimension-filtered reports stay fast without bloating the
-- undimensioned common case.
CREATE INDEX IF NOT EXISTS idx_jl_class    ON journal_lines(class_id)    WHERE class_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jl_location ON journal_lines(location_id) WHERE location_id IS NOT NULL;
