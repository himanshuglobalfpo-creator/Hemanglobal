-- ============================================================================
-- 0035_price_rules — price rules & customer-specific pricing
--
-- A price rule adjusts the unit rate at invoice/estimate line entry. Rules are
-- resolved (never written back to items) by GET /api/pricing/resolve, which
-- picks the best applicable rule: highest priority, then most specific. Rules
-- operate in the DOCUMENT currency — the base rate in and adjusted rate out are
-- both document-currency; no FX conversion happens in a rule.
--
-- Scope is two-dimensional:
--   item_scope     : all | list (price_rule_items) | category (items.category)
--   customer_scope : all | list (price_rule_customers)
-- Adjustment:
--   adjust_type    : percent (percent column) | fixed (amount_cents column)
--   direction      : discount | surcharge
-- Idempotent.
-- ============================================================================

-- Lightweight product category used by category-scoped rules (nullable).
ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT;

CREATE TABLE IF NOT EXISTS price_rules (
  id             SERIAL PRIMARY KEY,
  org_id         INTEGER NOT NULL,
  name           TEXT NOT NULL,
  item_scope     TEXT NOT NULL DEFAULT 'all',      -- all | list | category
  category       TEXT,                             -- when item_scope = 'category'
  customer_scope TEXT NOT NULL DEFAULT 'all',      -- all | list
  adjust_type    TEXT NOT NULL,                    -- percent | fixed
  direction      TEXT NOT NULL DEFAULT 'discount', -- discount | surcharge
  percent        DOUBLE PRECISION,                 -- when adjust_type = 'percent' (e.g. 10 = 10%)
  amount_cents   BIGINT,                           -- when adjust_type = 'fixed' (document-currency cents)
  start_date     TEXT,                             -- YYYY-MM-DD inclusive; NULL = open start
  end_date       TEXT,                             -- YYYY-MM-DD inclusive; NULL = open end
  priority       INTEGER NOT NULL DEFAULT 0,       -- higher wins first
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_rules_org_active ON price_rules(org_id, is_active);

-- Membership for list-scoped rules.
CREATE TABLE IF NOT EXISTS price_rule_items (
  id       SERIAL PRIMARY KEY,
  org_id   INTEGER NOT NULL,
  rule_id  INTEGER NOT NULL,
  item_id  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pri_rule_item ON price_rule_items(rule_id, item_id);
CREATE INDEX IF NOT EXISTS idx_pri_org ON price_rule_items(org_id, item_id);

CREATE TABLE IF NOT EXISTS price_rule_customers (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL,
  rule_id      INTEGER NOT NULL,
  customer_id  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prc_rule_customer ON price_rule_customers(rule_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_prc_org ON price_rule_customers(org_id, customer_id);
