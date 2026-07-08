-- 0001_init.sql — LedgerLite base schema (Phase 1/2 foundation).
-- Conventions: money INTEGER cents; dates TEXT YYYY-MM-DD; every business
-- table carries org_id with an FK to orgs(id) and an org index.

CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','accountant','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_users_org ON org_users(org_id);
CREATE INDEX IF NOT EXISTS idx_org_users_user ON org_users(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_zip TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(org_id);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_zip TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendors_org ON vendors(org_id);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_org_date ON journal_entries(org_id, date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0)
);
CREATE INDEX IF NOT EXISTS idx_jl_org_entry ON journal_lines(org_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_org_account ON journal_lines(org_id, account_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  rate INTEGER NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_org_inv ON invoice_lines(org_id, invoice_id);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_bills_org ON bills(org_id);

CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  rate INTEGER NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_bill_lines_org_bill ON bill_lines(org_id, bill_id);

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org ON credit_notes(org_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  reconciled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_org ON bank_transactions(org_id);

CREATE TABLE IF NOT EXISTS closed_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  through_date TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_closed_periods_org ON closed_periods(org_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log(org_id, created_at);
