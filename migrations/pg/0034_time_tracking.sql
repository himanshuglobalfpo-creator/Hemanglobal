-- ============================================================================
-- 0034_time_tracking — billable time entries + project budgets
--
-- time_entries records billable/non-billable work against a project. A billable
-- entry becomes revenue when it is added to an invoice: invoiced_line_id links
-- it to the exact invoice_line it was billed on. That link is the double-billing
-- guard — an entry with a non-null invoiced_line_id is already billed and cannot
-- be added again. Voiding/deleting the invoice NULLs the link (the time is
-- preserved and becomes billable again), it never deletes the entry.
--
-- projects gains two budget columns (integer cents) for actual-vs-budget. All
-- money is integer cents; minutes are whole integers (hours = minutes / 60).
-- Idempotent.
-- ============================================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_income_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_cost_cents   BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS time_entries (
  id                SERIAL PRIMARY KEY,
  org_id            INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,               -- who logged the time
  project_id        INTEGER NOT NULL,               -- the job this time is for
  service_date      TEXT NOT NULL,                  -- YYYY-MM-DD the work happened
  description       TEXT NOT NULL DEFAULT '',
  minutes           INTEGER NOT NULL,               -- whole minutes worked
  billable          BOOLEAN NOT NULL DEFAULT true,
  rate_cents        BIGINT NOT NULL DEFAULT 0,      -- billing rate per hour, integer cents
  invoiced_line_id  INTEGER,                        -- FK to invoice_lines once billed; NULL = unbilled
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Timesheet & project reads.
CREATE INDEX IF NOT EXISTS idx_time_entries_org_project ON time_entries(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_org_user_date ON time_entries(org_id, user_id, service_date);
-- Unbilled-time lookups (billable AND not yet linked to an invoice line).
CREATE INDEX IF NOT EXISTS idx_time_entries_unbilled ON time_entries(org_id, project_id) WHERE invoiced_line_id IS NULL AND billable = true;
-- Fast unlink on invoice void/delete.
CREATE INDEX IF NOT EXISTS idx_time_entries_invoiced_line ON time_entries(invoiced_line_id);
