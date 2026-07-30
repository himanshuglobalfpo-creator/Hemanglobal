-- ============================================================================
-- 0041_custom_roles — granular permissions & custom org roles (P3.11)
--
-- The four built-in roles (owner/admin/accountant/viewer) are defined in code
-- (shared/permissions.ts) so seeding is implicit and behavior is unchanged.
-- Custom roles are per-org named permission sets stored here; a membership's
-- `role` text may reference a built-in name OR a custom role name. "owner" is
-- immutable and implicitly holds every permission. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_roles (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  name         TEXT NOT NULL,                 -- unique per org; never a built-in name
  permissions  JSONB NOT NULL DEFAULT '[]',   -- array of permission keys
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_roles_name ON org_roles(org_id, lower(name));
