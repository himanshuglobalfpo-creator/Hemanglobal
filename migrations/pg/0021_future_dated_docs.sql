-- ============================================================================
-- 0021_future_dated_docs — per-org future-dated document policy (BUG-005)
--
-- Invoices, bills, and journal entries dated more than `future_dated_grace_days`
-- beyond today are flagged. With `strict_future_dates` OFF (the default) the API
-- returns a non-blocking warning the client can surface; with it ON the write is
-- rejected. Defaults (0 grace days, non-strict) preserve today's behavior: only
-- a genuinely future-dated document is flagged, and never blocked, until an org
-- opts into strict mode. Idempotent, matching the house migration style.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS strict_future_dates BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS future_dated_grace_days INTEGER NOT NULL DEFAULT 0;
