-- 0005_budgets.sql — TASK 4d: budgets.
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_budgets_org ON budgets(org_id);

CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  budget_id INTEGER NOT NULL REFERENCES budgets(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount INTEGER NOT NULL DEFAULT 0,
  UNIQUE (budget_id, account_id, month)
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_org_budget ON budget_lines(org_id, budget_id);
