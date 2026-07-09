-- ============================================================================
-- 0017_fx_revaluation — period-end unrealized foreign-currency revaluation
--
-- The ledger already books REALIZED FX at payment time. This adds UNREALIZED
-- FX: at period end the base-currency carrying value of OPEN foreign invoices
-- and bills is remeasured at the as-of-date rate and the difference is posted to
-- Unrealized FX Gain/Loss against A/R or A/P. Because unrealized revaluations
-- reverse at the start of the next period, every run is recorded so it can be
-- reversed exactly.
--
--   • fx_revaluations       — one row per run (the adjusting JE + reversal JE).
--   • fx_revaluation_lines  — per-document detail (audit / explainability).
--
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- Every statement is idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fx_revaluations (
  id                SERIAL PRIMARY KEY,
  org_id            INTEGER NOT NULL,
  as_of_date        TEXT    NOT NULL,           -- YYYY-MM-DD
  currency          TEXT,                       -- null = all foreign currencies
  entry_id          INTEGER,                    -- adjusting JE (null if nothing to adjust)
  reversal_entry_id INTEGER,                    -- reversing JE (set once reversed)
  reversal_date     TEXT,
  status            TEXT    NOT NULL DEFAULT 'posted', -- posted | reversed
  total_gain_cents  INTEGER NOT NULL DEFAULT 0,
  total_loss_cents  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_fx_revaluations_org ON fx_revaluations (org_id);

CREATE TABLE IF NOT EXISTS fx_revaluation_lines (
  id                        SERIAL PRIMARY KEY,
  org_id                    INTEGER NOT NULL,
  revaluation_id            INTEGER NOT NULL,
  doc_type                  TEXT    NOT NULL,   -- invoice | bill
  doc_id                    INTEGER NOT NULL,
  currency                  TEXT    NOT NULL,
  rate                      DOUBLE PRECISION NOT NULL,
  foreign_outstanding_cents INTEGER NOT NULL,
  booking_base_cents        INTEGER NOT NULL,
  revalued_base_cents       INTEGER NOT NULL,
  diff_cents                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_fx_revaluation_lines_org_reval ON fx_revaluation_lines (org_id, revaluation_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fx_reval_entry') THEN
    ALTER TABLE fx_revaluations ADD CONSTRAINT fk_fx_reval_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fx_reval_reversal_entry') THEN
    ALTER TABLE fx_revaluations ADD CONSTRAINT fk_fx_reval_reversal_entry
      FOREIGN KEY (reversal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fx_reval_lines_reval') THEN
    ALTER TABLE fx_revaluation_lines ADD CONSTRAINT fk_fx_reval_lines_reval
      FOREIGN KEY (revaluation_id) REFERENCES fx_revaluations(id) ON DELETE CASCADE;
  END IF;
END $$;
