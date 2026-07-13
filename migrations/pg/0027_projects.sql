-- ============================================================================
-- 0027_projects — project (job) tracking, third dimension after class/location
--
-- A projects table (optionally tied to a customer, QBO customer:job) plus a
-- nullable project_id on journal_lines / invoice_lines / bill_lines. Drives
-- per-project Profit & Loss. All columns nullable — projects are opt-in.
-- Mirrors migration 0023 (class/location). Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  customer_id INTEGER,
  status      TEXT NOT NULL DEFAULT 'active',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS project_id INTEGER;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS project_id INTEGER;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS project_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_jl_project
  ON journal_lines(project_id) WHERE project_id IS NOT NULL;
