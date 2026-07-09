-- ============================================================================
-- 0004_number_sequences — per-org auto-numbering for invoices/bills/notes
--
-- One row per (org, kind). next_value is the NEXT number to hand out.
-- Allocation is a single atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING
-- in storage.nextNumber(), which is race-safe under concurrency (row-level
-- lock on the upserted row serializes concurrent allocators).
-- ============================================================================

CREATE TABLE IF NOT EXISTS number_sequences (
  org_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'invoice' | 'bill' | 'credit_note' | 'debit_note'
  prefix TEXT NOT NULL,         -- 'INV-' | 'BILL-' | 'CN-' | 'DN-'
  next_value INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 4,
  PRIMARY KEY (org_id, kind)
);
