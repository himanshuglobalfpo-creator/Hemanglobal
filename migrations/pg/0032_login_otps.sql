-- ============================================================================
-- 0032_login_otps — email one-time-code login
--
-- A short-lived, single-use 6-digit code emailed to a user for passwordless
-- sign-in. The code itself is never stored — only a bcrypt hash. Codes expire
-- after 5 minutes and lock out after too many wrong attempts. At most one live
-- code per user (a new request supersedes the old). Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS login_otps (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  code_hash   TEXT NOT NULL,                  -- bcrypt of the 6-digit code
  expires_at  TIMESTAMP NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,     -- wrong verify tries against this code
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps(user_id);
CREATE INDEX IF NOT EXISTS idx_login_otps_expires ON login_otps(expires_at);
