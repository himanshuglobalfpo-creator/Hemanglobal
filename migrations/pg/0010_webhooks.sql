-- ============================================================================
-- 0010_webhooks — outbound webhooks + delivery queue with retry state
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,               -- HMAC-SHA256 signing key (org-provided)
  events TEXT NOT NULL,               -- JSON array of subscribed event names
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL,
  webhook_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,              -- exact JSON body that gets signed/sent
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | success | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT now(),
  response_code INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org ON webhook_deliveries(org_id);
-- Worker scan path: due deliveries by status + time (see 0011 for composite).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhooks_org') THEN
    ALTER TABLE webhooks ADD CONSTRAINT fk_webhooks_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_deliveries_webhook') THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT fk_webhook_deliveries_webhook
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE;
  END IF;
END $$;
