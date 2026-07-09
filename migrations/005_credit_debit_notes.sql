-- ============================================================================
-- Migration 005 — Credit notes (AR) and debit notes (AP)
-- ============================================================================
-- NOTE: This project runs on SQLite (better-sqlite3), so this migration uses
-- SQLite dialect. Amounts are REAL dollars (2dp) to match every existing
-- monetary column in this schema (invoices.total, journal_lines.debit, ...).
-- The same DDL is applied idempotently at boot by initSchema() in
-- server/storage.ts — this file is the canonical migration record.

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,                       -- CN-0001, sequential per org
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id), -- optional: invoice this credit is against
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','applied','void')),
  reason TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  applied_amount REAL NOT NULL DEFAULT 0,
  remaining_credit REAL NOT NULL DEFAULT 0,   -- total - applied_amount (kept in sync)
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org ON credit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_status ON credit_notes(status);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  revenue_account_id INTEGER NOT NULL REFERENCES accounts(id) -- income (or expense for returns)
);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_note ON credit_note_lines(credit_note_id);

CREATE TABLE IF NOT EXISTS credit_note_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_applied REAL NOT NULL CHECK (amount_applied > 0),
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_by INTEGER REFERENCES users(id)
);
-- "sum of applications <= credit_note.total" cannot be a SQLite table constraint;
-- it is enforced transactionally in server/creditNoteService.ts (applyCreditNote).
CREATE INDEX IF NOT EXISTS idx_cn_applications_note ON credit_note_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_cn_applications_invoice ON credit_note_applications(invoice_id);

CREATE TABLE IF NOT EXISTS debit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL,                       -- DN-0001, sequential per org
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  bill_id INTEGER REFERENCES bills(id),       -- optional: bill this debit note disputes
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','void')),
  reason TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  applied_amount REAL NOT NULL DEFAULT 0,
  remaining_debit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_debit_notes_org ON debit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_vendor ON debit_notes(vendor_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_status ON debit_notes(status);

CREATE TABLE IF NOT EXISTS debit_note_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  debit_note_id INTEGER NOT NULL REFERENCES debit_notes(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  expense_account_id INTEGER NOT NULL REFERENCES accounts(id) -- must be type expense
);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_note ON debit_note_lines(debit_note_id);

CREATE TABLE IF NOT EXISTS debit_note_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL DEFAULT 1,
  debit_note_id INTEGER NOT NULL REFERENCES debit_notes(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  amount_applied REAL NOT NULL CHECK (amount_applied > 0),
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_dn_applications_note ON debit_note_applications(debit_note_id);
CREATE INDEX IF NOT EXISTS idx_dn_applications_bill ON debit_note_applications(bill_id);
