-- ============================================================================
-- 0008_attachments — receipts/documents on invoices, bills, bank tx, JEs
-- Blobs live in the file driver (local dir or S3); this table is the index.
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice','bill','bank_transaction','journal_entry')),
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_org ON attachments(org_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(org_id, entity_type, entity_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_attachments_org') THEN
    ALTER TABLE attachments
      ADD CONSTRAINT fk_attachments_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
