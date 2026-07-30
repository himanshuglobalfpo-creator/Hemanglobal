-- ============================================================================
-- 0042_subscription_billing — platform subscriptions (Stripe Billing) (P4.1)
--
-- Platform billing is SEPARATE from app-Stripe (customer invoice payments): its
-- own columns, keys (PLATFORM_STRIPE_SECRET_KEY) and webhook endpoint. Signup
-- starts a 14-day trial; a failed payment enters dunning (grace_until); past the
-- grace the org goes read-only (mutating routes 402 except billing/auth).
-- Idempotent.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan                   TEXT NOT NULL DEFAULT 'trial';   -- trial | starter | plus | advanced
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_status         TEXT NOT NULL DEFAULT 'trialing';-- trialing | active | past_due | canceled
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at          TEXT;                            -- ISO datetime
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS seat_limit             INTEGER NOT NULL DEFAULT 3;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS grace_until            TEXT;                            -- dunning grace end (ISO)
