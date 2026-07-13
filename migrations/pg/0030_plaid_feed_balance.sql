-- ============================================================================
-- 0030_plaid_feed_balance — persist the bank-reported feed balance per item
--
-- The Banking cards show a "Bank feed" balance beside the in-books balance
-- (QBO-style). That number comes ONLY from a real aggregator, so we capture it
-- from Plaid's accountsBalanceGet at link + on every sync and store it here.
--   plaid_account_id  — the specific Plaid account mapped to our GL bank account
--                       (a Plaid item can expose several accounts).
--   feed_balance_cents/feed_balance_at — latest bank-reported balance + when.
-- All nullable; populated only when a feed reports a balance. Idempotent.
-- ============================================================================

ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS plaid_account_id  TEXT;
ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS feed_balance_cents BIGINT;
ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS feed_balance_at    TEXT;
