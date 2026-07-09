-- ============================================================================
-- 0003_recon_items_org_backfill — fix mis-tagged reconciliation_items.org_id
--
-- Bug M3 (v2.1.1 audit): toggleReconItem inserted reconciliation_items WITHOUT
-- setting org_id, so every row landed with the column DEFAULT of 1 regardless
-- of tenant. This migration:
--   1. Backfills org_id from the parent reconciliation (source of truth).
--   2. Drops the DEFAULT so any future insert that forgets org_id fails loudly
--      (NOT NULL, no default) instead of silently landing in org 1.
-- Both statements are idempotent / safe to re-run.
-- ============================================================================

-- 1. Backfill: copy the parent reconciliation's org_id onto any item that
--    disagrees with it. Naturally idempotent (second run matches zero rows).
UPDATE reconciliation_items ri
SET org_id = r.org_id
FROM reconciliations r
WHERE ri.reconciliation_id = r.id
  AND ri.org_id <> r.org_id;

-- 2. Drop the misleading default. DROP DEFAULT is safe to re-run: if no
--    default exists, the statement is a no-op success in PostgreSQL.
ALTER TABLE reconciliation_items ALTER COLUMN org_id DROP DEFAULT;
