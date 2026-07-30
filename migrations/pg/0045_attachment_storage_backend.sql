-- ============================================================================
-- 0045_attachment_storage_backend — per-blob backend + integrity checksum
-- ============================================================================
-- Attachment blobs live in the file driver (local dir or S3). To support a
-- ZERO-DOWNTIME migration between backends we record, per row, WHERE its blob
-- currently lives and a SHA-256 of the stored (encrypted-at-rest) bytes:
--
--   • storage_backend — 'local' or 's3'. Reads resolve the driver per row, so
--     during a rolling local→s3 migration a half-migrated table still serves
--     every download from the correct store (the migrated ones fall through to
--     s3, the rest to local). New uploads record the primary backend.
--   • checksum_sha256 — hex SHA-256 of the exact bytes on disk/S3. The migrator
--     verifies the S3 copy read-back against this before flipping the row and
--     deleting the source, so a truncated/corrupt copy can never win.
--
-- Existing rows predate object storage, so their blobs are on local disk →
-- default 'local'. checksum backfills lazily on first migration.
-- Idempotent.
-- ============================================================================

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_storage_backend_allowed') THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_storage_backend_allowed
      CHECK (storage_backend IN ('local','s3'));
  END IF;
END $$;

-- Partial index: the migrator scans "rows not yet on the target backend" per
-- org; keeping only non-'s3' rows indexed keeps the scan cheap as s3 fills up.
CREATE INDEX IF NOT EXISTS idx_attachments_backend_pending
  ON attachments(org_id, storage_backend) WHERE storage_backend <> 's3';
