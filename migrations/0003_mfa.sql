-- 0003_mfa.sql — TASK 2: TOTP MFA.
-- totp_secret is stored encrypted with the crypto-vault v1 format
-- ("v1:<iv>:<tag>:<ciphertext>", AES-256-GCM). recovery_codes is a JSON
-- array of 8 bcrypt hashes; each code is single-use (hash removed on use).
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_codes TEXT;

-- 5-minute single-use MFA login challenges (NOT sessions).
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges(user_id);
