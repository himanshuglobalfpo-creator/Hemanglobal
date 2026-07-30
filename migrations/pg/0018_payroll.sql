-- ============================================================================
-- 0018_payroll — employees, pay runs, and automatic GL posting (QBO-style)
--
-- A pay run computes each employee's gross, employee-withheld taxes, employer
-- taxes and net pay (integer cents; annual wage-base caps use posted YTD wages)
-- and posts ONE balanced journal entry:
--   Dr Wages Expense + Dr Payroll Tax Expense
--   Cr Payroll Taxes Payable + Cr Payroll Deductions Payable + Cr Bank (net pay)
--
--   • employees      — the roster (salary/hourly, frequency, withholding rates).
--   • payroll_runs   — one pay run header + totals + the posted JE.
--   • payroll_items  — per-employee computed detail for a run.
--
-- The default chart of accounts gains 2300 Payroll Taxes Payable, 2310 Payroll
-- Deductions Payable and 6350 Payroll Tax Expense (see storage seedOrgDefaults).
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- Every statement is idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS employees (
  id                       SERIAL PRIMARY KEY,
  org_id                   INTEGER NOT NULL,
  name                     TEXT    NOT NULL,
  email                    TEXT,
  pay_type                 TEXT    NOT NULL,           -- salary | hourly
  pay_rate_cents           INTEGER NOT NULL,           -- annual salary (salary) or hourly rate (hourly)
  pay_frequency            TEXT    NOT NULL,           -- weekly | biweekly | semimonthly | monthly
  federal_withholding_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  state_withholding_rate   DOUBLE PRECISION NOT NULL DEFAULT 0,
  status                   TEXT    NOT NULL DEFAULT 'active', -- active | inactive
  hire_date                TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT now(),
  updated_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_employees_org ON employees (org_id);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                        SERIAL PRIMARY KEY,
  org_id                    INTEGER NOT NULL,
  pay_date                  TEXT    NOT NULL,
  period_start              TEXT    NOT NULL,
  period_end                TEXT    NOT NULL,
  status                    TEXT    NOT NULL DEFAULT 'draft', -- draft | posted | void
  bank_account_id           INTEGER NOT NULL,
  entry_id                  INTEGER,
  total_gross_cents         INTEGER NOT NULL DEFAULT 0,
  total_employee_tax_cents  INTEGER NOT NULL DEFAULT 0,
  total_employer_tax_cents  INTEGER NOT NULL DEFAULT 0,
  total_deductions_cents    INTEGER NOT NULL DEFAULT 0,
  total_net_cents           INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_payroll_runs_org ON payroll_runs (org_id);

CREATE TABLE IF NOT EXISTS payroll_items (
  id                       SERIAL PRIMARY KEY,
  org_id                   INTEGER NOT NULL,
  run_id                   INTEGER NOT NULL,
  employee_id              INTEGER NOT NULL,
  hours                    DOUBLE PRECISION,
  gross_cents              INTEGER NOT NULL DEFAULT 0,
  pretax_deduction_cents   INTEGER NOT NULL DEFAULT 0,
  posttax_deduction_cents  INTEGER NOT NULL DEFAULT 0,
  fed_withholding_cents    INTEGER NOT NULL DEFAULT 0,
  state_withholding_cents  INTEGER NOT NULL DEFAULT 0,
  ss_employee_cents        INTEGER NOT NULL DEFAULT 0,
  medicare_employee_cents  INTEGER NOT NULL DEFAULT 0,
  additional_medicare_cents INTEGER NOT NULL DEFAULT 0,
  ss_employer_cents        INTEGER NOT NULL DEFAULT 0,
  medicare_employer_cents  INTEGER NOT NULL DEFAULT 0,
  futa_cents               INTEGER NOT NULL DEFAULT 0,
  suta_cents               INTEGER NOT NULL DEFAULT 0,
  employee_tax_cents       INTEGER NOT NULL DEFAULT 0,
  employer_tax_cents       INTEGER NOT NULL DEFAULT 0,
  net_cents                INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_payroll_items_org_run ON payroll_items (org_id, run_id);
CREATE INDEX IF NOT EXISTS ix_payroll_items_employee ON payroll_items (employee_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_bank_account') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_bank_account
      FOREIGN KEY (bank_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_items_run') THEN
    ALTER TABLE payroll_items ADD CONSTRAINT fk_payroll_items_run
      FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_items_employee') THEN
    ALTER TABLE payroll_items ADD CONSTRAINT fk_payroll_items_employee
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
  END IF;
END $$;
