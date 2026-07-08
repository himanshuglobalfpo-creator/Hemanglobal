-- 0004_attachments.sql — TASK 3: file attachments.
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice','bill','bank_transaction','journal_entry')),
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_org_entity ON attachments(org_id, entity_type, entity_id);
