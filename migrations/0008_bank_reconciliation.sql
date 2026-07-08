-- 0008_bank_reconciliation.sql — Phase 5: bank reconciliation engine.
-- status: unmatched (fresh statement line) | matched (linked to journal
-- entries via bank_matches) | excluded (duplicate/error, ignored by rec).
ALTER TABLE bank_transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'unmatched';
-- sha256(account|date|amount|normalized description): duplicate detection
-- across imports (re-importing the same file is a no-op).
ALTER TABLE bank_transactions ADD COLUMN import_hash TEXT;

-- One bank line can clear MANY journal entries (a single deposit covering
-- several invoice payments), hence a join table rather than a column.
CREATE TABLE IF NOT EXISTS bank_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bank_transaction_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_matches_org_entry ON bank_matches(org_id, entry_id);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  statement_ending_balance INTEGER NOT NULL,
  cleared_balance INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  completed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reconciliations_org_acct ON reconciliations(org_id, account_id);

CREATE INDEX IF NOT EXISTS idx_bank_tx_org_acct_status ON bank_transactions(org_id, account_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_tx_org_hash ON bank_transactions(org_id, import_hash);
