-- ============================================================================
-- 0047_email_suppressions — deliverability suppression list
-- ============================================================================
-- Hard bounces and spam complaints must NEVER be emailed again: continuing to
-- send tanks the sending domain's reputation for every tenant. This list is the
-- authority sendEmail() consults before every real send. It is GLOBAL (keyed by
-- address, not org): a dead/complaining address is dead for the whole domain,
-- regardless of which tenant last triggered a send.
--
-- Populated by the provider bounce/complaint webhook (POST /api/email/webhook,
-- SES or Postmark). Idempotent upsert on the address.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,           -- 'hard_bounce' | 'complaint' | 'manual'
  source      TEXT,                    -- 'ses' | 'postmark' | 'manual'
  detail      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
