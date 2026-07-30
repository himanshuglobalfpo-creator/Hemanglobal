-- ============================================================================
-- 0009_budgets — annual budgets with monthly lines per account (integer cents)
-- ============================================================================

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budgets_org ON budgets(org_id);

CREATE TABLE IF NOT EXISTS budget_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  budget_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount INTEGER NOT NULL,               -- integer cents
  UNIQUE (budget_id, account_id, month)
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_org ON budget_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget ON budget_lines(budget_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_budgets_org') THEN
    ALTER TABLE budgets ADD CONSTRAINT fk_budgets_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_budget_lines_budget') THEN
    ALTER TABLE budget_lines ADD CONSTRAINT fk_budget_lines_budget
      FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_budget_lines_account') THEN
    ALTER TABLE budget_lines ADD CONSTRAINT fk_budget_lines_account
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;
