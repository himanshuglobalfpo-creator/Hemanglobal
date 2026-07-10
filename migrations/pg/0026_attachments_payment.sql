-- ============================================================================
-- 0026_attachments_payment — allow attaching receipts to payments
--
-- Broadens the attachments.entity_type CHECK to include 'payment' (a payment
-- journal entry). bill / journal_entry / bank_transaction were already allowed.
-- Idempotent: drop the old constraint (whatever its exact allowed set) and add
-- the superset under a stable name.
-- ============================================================================

DO $$
BEGIN
  -- Drop the original inline check (named <table>_<col>_check by Postgres) if present.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_entity_type_check') THEN
    ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_entity_type_allowed') THEN
    ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_allowed;
  END IF;
  ALTER TABLE attachments
    ADD CONSTRAINT attachments_entity_type_allowed
    CHECK (entity_type IN ('invoice','bill','bank_transaction','journal_entry','payment'));
END $$;
