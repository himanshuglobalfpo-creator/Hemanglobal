-- ============================================================================
-- 0012_stripe_clearing_account — org-configurable Stripe clearing account
--
-- The Stripe webhook used to post payments to the FIRST bank-subtype account
-- it found ("convention: code 1000"). For an org with more than one bank
-- account that silently books money to whichever account happens to sort
-- first. Payments now post to an explicit per-org setting; when it is unset
-- the webhook fails loudly instead of guessing.
--
-- FK is ON DELETE RESTRICT deliberately: deleting the account that live
-- Stripe payments settle into must be blocked until the org picks a new
-- clearing account — otherwise money arrives at Stripe with nowhere to book.
-- Idempotent, matching the house migration style.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_clearing_account_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_orgs_stripe_clearing_account'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT fk_orgs_stripe_clearing_account
      FOREIGN KEY (stripe_clearing_account_id) REFERENCES accounts(id)
      ON DELETE RESTRICT;
  END IF;
END $$;
