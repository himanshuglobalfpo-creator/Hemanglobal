-- ============================================================================
-- 0000_init — PostgreSQL initial schema for LedgerLite
-- Full end-state translated from the SQLite bootstrap (initSchema) including
-- all forward-compat columns (tax_breakdown, shipping_*, expires_at, ...).
-- Money is INTEGER CENTS everywhere. Dates are TEXT 'YYYY-MM-DD' (app-level
-- contract); audit/created timestamps are real TIMESTAMPs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- AUTH & MULTI-TENANCY (first; business tables reference organizations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  fy_end_month INTEGER NOT NULL DEFAULT 12,
  fy_end_day INTEGER NOT NULL DEFAULT 31,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  email_verify_token TEXT,
  password_reset_token TEXT,
  password_reset_expires TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(password_reset_token);

CREATE TABLE IF NOT EXISTS org_memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON org_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON org_memberships(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  active_org_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at TEXT,
  ip_address TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- BUSINESS TABLES — every one carries org_id (default 1 = "Default Organization")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_zip TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  memo TEXT,
  reference TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org ON journal_entries(org_id, date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org ON journal_lines(org_id);

-- Invoice/bill numbers are unique PER ORG (a global UNIQUE would both block
-- tenant #2 from using "INV-0001" and leak other tenants' numbers via errors).
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  tax_breakdown TEXT,
  notes TEXT,
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  income_account_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_bills_org ON bills(org_id);

CREATE TABLE IF NOT EXISTS bill_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  bill_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  expense_account_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  bank_account_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched',
  entry_id INTEGER,
  external_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  imported_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_account ON bank_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_status ON bank_transactions(status);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org ON bank_transactions(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_tx_external ON bank_transactions(bank_account_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_rules (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  bank_account_id INTEGER,
  description_contains TEXT,
  amount_comparator TEXT,
  amount_min INTEGER,
  amount_max INTEGER,
  direction TEXT,
  action_type TEXT NOT NULL,
  category_account_id INTEGER,
  transfer_account_id INTEGER,
  auto_post BOOLEAN NOT NULL DEFAULT true,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_rules_active ON bank_rules(is_active, priority);

CREATE TABLE IF NOT EXISTS reconciliations (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  bank_account_id INTEGER NOT NULL,
  statement_date TEXT NOT NULL,
  beginning_balance INTEGER NOT NULL DEFAULT 0,
  ending_balance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  completed_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_bank ON reconciliations(bank_account_id);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  reconciliation_id INTEGER NOT NULL,
  bank_transaction_id INTEGER NOT NULL,
  cleared BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_item ON reconciliation_items(reconciliation_id, bank_transaction_id);

CREATE TABLE IF NOT EXISTS recurring_templates (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  frequency TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT,
  max_occurrences INTEGER,
  occurrences_posted INTEGER NOT NULL DEFAULT 0,
  next_run_date TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  payload TEXT NOT NULL,
  last_run_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recur_next ON recurring_templates(is_active, next_run_date);

CREATE TABLE IF NOT EXISTS tax_codes (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  agency TEXT,
  liability_account_id INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS period_locks (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  lock_date TEXT NOT NULL,
  reason TEXT,
  is_year_end BOOLEAN NOT NULL DEFAULT false,
  closing_entry_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_period_locks_date ON period_locks(lock_date);

-- NOTE: "user" is a reserved word in PostgreSQL — always quoted.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  ts TIMESTAMP NOT NULL DEFAULT now(),
  "user" TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id);

CREATE TABLE IF NOT EXISTS invoice_shares (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  recipient_email TEXT,
  sent_at TEXT,
  email_status TEXT,
  email_error TEXT,
  viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_shares_invoice ON invoice_shares(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_shares_token ON invoice_shares(token);

CREATE TABLE IF NOT EXISTS plaid_items (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  bank_account_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  cursor TEXT,
  institution_name TEXT,
  last_sync_at TEXT,
  last_sync_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plaid_items_org ON plaid_items(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_items_item_id ON plaid_items(item_id);

-- ---------------------------------------------------------------------------
-- CREDIT NOTES (AR) & DEBIT NOTES (AP)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_notes (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  invoice_id INTEGER,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','applied','void')),
  reason TEXT NOT NULL,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  applied_amount INTEGER NOT NULL DEFAULT 0,
  remaining_credit INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org ON credit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_status ON credit_notes(status);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  credit_note_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  revenue_account_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_note ON credit_note_lines(credit_note_id);

CREATE TABLE IF NOT EXISTS credit_note_applications (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  credit_note_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  amount_applied INTEGER NOT NULL CHECK (amount_applied > 0),
  applied_at TIMESTAMP NOT NULL DEFAULT now(),
  applied_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cn_applications_note ON credit_note_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_cn_applications_invoice ON credit_note_applications(invoice_id);

CREATE TABLE IF NOT EXISTS debit_notes (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,
  vendor_id INTEGER NOT NULL,
  bill_id INTEGER,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','void')),
  reason TEXT NOT NULL,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  applied_amount INTEGER NOT NULL DEFAULT 0,
  remaining_debit INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_debit_notes_org ON debit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_vendor ON debit_notes(vendor_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_status ON debit_notes(status);

CREATE TABLE IF NOT EXISTS debit_note_lines (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  debit_note_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  expense_account_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_note ON debit_note_lines(debit_note_id);

CREATE TABLE IF NOT EXISTS debit_note_applications (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1,
  debit_note_id INTEGER NOT NULL,
  bill_id INTEGER NOT NULL,
  amount_applied INTEGER NOT NULL CHECK (amount_applied > 0),
  applied_at TIMESTAMP NOT NULL DEFAULT now(),
  applied_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dn_applications_note ON debit_note_applications(debit_note_id);
CREATE INDEX IF NOT EXISTS idx_dn_applications_bill ON debit_note_applications(bill_id);

-- ---------------------------------------------------------------------------
-- TAX NEXUS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_nexus_states (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  state_code TEXT NOT NULL,
  registration_number TEXT,
  effective_date TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nexus_org_state ON org_nexus_states(org_id, state_code);
