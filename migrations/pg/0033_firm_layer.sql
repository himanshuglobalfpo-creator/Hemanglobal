-- ============================================================================
-- 0033_firm_layer — accounting-firm access to client orgs
--
-- A firm is an organization flagged is_firm. Its accountant/admin members reach
-- client orgs through firm_client_access (NOT org_memberships), so client member
-- lists stay clean and access is revocable in one place. A grant is created
-- 'pending' when a firm invites a client owner by email; the owner approves via
-- a single-use token link, which binds client_org_id and flips it to 'active'.
-- Access is re-resolved from this table on every request, so setting a row to
-- 'revoked' cuts access on the very next request. Idempotent.
-- ============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_firm BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS firm_client_access (
  id                   SERIAL PRIMARY KEY,
  firm_org_id          INTEGER NOT NULL,                 -- the firm organization
  client_org_id        INTEGER,                          -- bound on approval
  granted_role         TEXT NOT NULL DEFAULT 'accountant',
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | active | revoked | declined
  invite_email         TEXT NOT NULL,
  invite_token         TEXT NOT NULL,
  invited_by_user_id   INTEGER NOT NULL,
  approved_by_user_id  INTEGER,
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  approved_at          TEXT,
  revoked_at           TEXT
);

-- Access-resolution lookups: "does firm F have an active grant on client C?"
CREATE INDEX IF NOT EXISTS idx_fca_client ON firm_client_access(client_org_id, status);
CREATE INDEX IF NOT EXISTS idx_fca_firm ON firm_client_access(firm_org_id, status);
-- Approval-link lookups by token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fca_token ON firm_client_access(invite_token);
-- At most one live grant per (firm, client): an active/pending pair is unique,
-- while revoked/declined rows accumulate as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fca_firm_client_live
  ON firm_client_access(firm_org_id, client_org_id)
  WHERE status IN ('pending', 'active') AND client_org_id IS NOT NULL;
