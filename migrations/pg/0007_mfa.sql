-- ============================================================================
-- 0007_mfa — TOTP secrets, recovery codes, and login MFA challenges
--
-- totp_secret is stored in the crypto-vault "v1:" AES-256-GCM format (never
-- plaintext when a key is configured). recovery_codes is a JSON array of 8
-- bcrypt hashes; each code is single-use (hash removed on redemption).
-- mfa_challenges are 5-minute single-use tokens bridging password success →
-- code verification; they are NOT sessions and grant no API access.
-- users is a global table (no org_id) — consistent with migration 0000.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes TEXT;

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id TEXT PRIMARY KEY,                    -- random token handed to the client
  user_id INTEGER NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,    -- verify tries against THIS token
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires ON mfa_challenges(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mfa_challenges_user') THEN
    ALTER TABLE mfa_challenges
      ADD CONSTRAINT fk_mfa_challenges_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
