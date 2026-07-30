-- ============================================================================
-- 0037_report_schedules — scheduled report delivery
--
-- A schedule renders a report on a cadence and emails it. next_run is advanced
-- by exactly one cadence period each time it fires, so a schedule fires ONCE
-- per period no matter how often the scheduler tick runs. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS report_schedules (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL,
  report_key  TEXT NOT NULL,                 -- e.g. profit-loss | balance-sheet | trial-balance
  params      JSONB NOT NULL DEFAULT '{}',   -- report params (range mode, dimensions, compare)
  cadence     TEXT NOT NULL DEFAULT 'monthly',-- daily | weekly | monthly | quarterly | annual
  recipients  TEXT NOT NULL DEFAULT '',      -- comma-separated emails
  next_run    TEXT NOT NULL,                 -- YYYY-MM-DD the schedule is next due
  last_run    TEXT,                          -- YYYY-MM-DD it last fired
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  INTEGER,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules(is_active, next_run);
CREATE INDEX IF NOT EXISTS idx_report_schedules_org ON report_schedules(org_id);
