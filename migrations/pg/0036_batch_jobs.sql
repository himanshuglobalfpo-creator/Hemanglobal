-- ============================================================================
-- 0036_batch_jobs — background jobs for batch actions & statements
--
-- A job records a batch operation (kind + payload) and its per-item results, so
-- batch actions are idempotent and resumable: re-running a job skips items whose
-- result is already 'ok'. result is a JSON array of {id, status, message}.
-- reminder_exempt on invoices/bills lets a batch action exclude documents from
-- statement/reminder runs. Idempotent.
-- ============================================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_exempt BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS reminder_exempt BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS jobs (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL,
  kind        TEXT NOT NULL,                 -- e.g. invoice.void | invoice.send | customer.statement
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued',-- queued | running | completed | failed
  progress    INTEGER NOT NULL DEFAULT 0,    -- items processed
  total       INTEGER NOT NULL DEFAULT 0,    -- items to process
  result      JSONB NOT NULL DEFAULT '[]',   -- [{id, status: ok|error|skipped, message}]
  error       TEXT,                          -- job-level fatal error
  created_by  INTEGER,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_org ON jobs(org_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(org_id, status);
