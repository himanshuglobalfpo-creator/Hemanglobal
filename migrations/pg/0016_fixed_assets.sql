-- ============================================================================
-- 0016_fixed_assets — fixed-asset register + automatic depreciation
--
-- A fixed asset capitalizes a purchase and depreciates it over a useful life.
-- Depreciation posts monthly as Dr Depreciation Expense / Cr Accumulated
-- Depreciation. Schedules are computed in integer cents with the last period
-- absorbing the rounding remainder (see shared/depreciation.ts).
--
--   • fixed_assets         — the register.
--   • depreciation_entries — one row per posted period. UNIQUE(org_id, asset_id,
--                            period) makes monthly posting idempotent (a repeat
--                            POST is a no-op) and lets the boot catch-up backfill
--                            missed months safely.
--
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- Every statement is idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fixed_assets (
  id                              SERIAL PRIMARY KEY,
  org_id                          INTEGER NOT NULL,
  name                            TEXT    NOT NULL,
  asset_account_id                INTEGER NOT NULL,
  accum_dep_account_id            INTEGER NOT NULL,
  depreciation_expense_account_id INTEGER NOT NULL,
  acquisition_date                TEXT    NOT NULL,           -- YYYY-MM-DD
  cost_cents                      INTEGER NOT NULL,
  salvage_cents                   INTEGER NOT NULL DEFAULT 0,
  useful_life_months              INTEGER NOT NULL,
  method                          TEXT    NOT NULL,           -- straight_line | double_declining
  status                          TEXT    NOT NULL DEFAULT 'active', -- active | disposed | fully_depreciated
  disposed_date                   TEXT,
  updated_at                      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_fixed_assets_org ON fixed_assets (org_id);
CREATE INDEX IF NOT EXISTS ix_fixed_assets_status ON fixed_assets (status);

CREATE TABLE IF NOT EXISTS depreciation_entries (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  asset_id     INTEGER NOT NULL,
  period       TEXT    NOT NULL,           -- YYYY-MM
  amount_cents INTEGER NOT NULL,
  entry_id     INTEGER,                    -- FK to journal_entries (null for a zero-amount period)
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- Idempotency: at most one depreciation row per asset per period.
CREATE UNIQUE INDEX IF NOT EXISTS ux_depreciation_entries_asset_period
  ON depreciation_entries (org_id, asset_id, period);
CREATE INDEX IF NOT EXISTS ix_depreciation_entries_asset ON depreciation_entries (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fixed_assets_asset_account') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fk_fixed_assets_asset_account
      FOREIGN KEY (asset_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fixed_assets_accum_account') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fk_fixed_assets_accum_account
      FOREIGN KEY (accum_dep_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fixed_assets_dep_expense_account') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fk_fixed_assets_dep_expense_account
      FOREIGN KEY (depreciation_expense_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_depreciation_entries_asset') THEN
    ALTER TABLE depreciation_entries ADD CONSTRAINT fk_depreciation_entries_asset
      FOREIGN KEY (asset_id) REFERENCES fixed_assets(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_depreciation_entries_entry') THEN
    ALTER TABLE depreciation_entries ADD CONSTRAINT fk_depreciation_entries_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;
END $$;
