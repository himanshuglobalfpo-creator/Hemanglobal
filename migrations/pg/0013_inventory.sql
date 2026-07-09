-- ============================================================================
-- 0013_inventory — stock-tracked catalog items with weighted-average costing
--
-- Adds two tenant-owned tables and one org-level policy flag:
--   • items              — the catalog. Inventory items carry a running
--                          quantity_on_hand (whole units) and avg_cost_cents
--                          (weighted-average unit cost, INTEGER CENTS), both
--                          maintained by the storage layer from movements.
--   • inventory_movements — append-only stock ledger. qty_delta is signed;
--                          entry_id links to the journal entry that posted the
--                          matching GL effect (purchase capitalization / COGS).
--   • organizations.allow_negative_stock — when false (default) a sale that
--                          would drive stock below zero is blocked.
--
-- org_id is NOT NULL with NO DEFAULT (house rule since 0003): a forgotten
-- org_id is a loud violation, never a silent landing in org 1. Storage stamps
-- currentOrgId() on every insert. Every statement is idempotent (safe re-run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id                          SERIAL PRIMARY KEY,
  org_id                      INTEGER NOT NULL,
  sku                         TEXT    NOT NULL,
  name                        TEXT    NOT NULL,
  description                 TEXT,
  type                        TEXT    NOT NULL,           -- 'inventory' | 'service' | 'noninventory'
  sales_account_id            INTEGER NOT NULL,
  expense_account_id          INTEGER NOT NULL,
  inventory_asset_account_id  INTEGER,                    -- NULL for service / non-inventory
  cogs_account_id             INTEGER NOT NULL,
  quantity_on_hand            INTEGER NOT NULL DEFAULT 0, -- whole units
  avg_cost_cents              INTEGER NOT NULL DEFAULT 0, -- weighted-average unit cost, cents
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at                  TIMESTAMP NOT NULL DEFAULT now()
);

-- Per-tenant uniqueness of SKU (mirrors accounts' UNIQUE(org_id, code)).
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_org_sku ON items (org_id, sku);
CREATE INDEX IF NOT EXISTS ix_items_org ON items (org_id);

-- FKs to the chart of accounts. ON DELETE RESTRICT: an account wired into an
-- item cannot be deleted out from under live stock postings.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_sales_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_sales_account
      FOREIGN KEY (sales_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_expense_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_expense_account
      FOREIGN KEY (expense_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_inventory_asset_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_inventory_asset_account
      FOREIGN KEY (inventory_asset_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_cogs_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_cogs_account
      FOREIGN KEY (cogs_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- inventory_movements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL,
  item_id         INTEGER NOT NULL,
  date            TEXT    NOT NULL,           -- YYYY-MM-DD
  qty_delta       INTEGER NOT NULL,           -- signed whole units
  unit_cost_cents INTEGER NOT NULL,           -- per-unit cost in cents
  source          TEXT    NOT NULL,           -- 'bill' | 'invoice' | 'adjustment' | 'opening'
  source_id       INTEGER,
  entry_id        INTEGER,                    -- FK to journal_entries (the GL effect)
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_inventory_movements_org_item ON inventory_movements (org_id, item_id);
CREATE INDEX IF NOT EXISTS ix_inventory_movements_entry ON inventory_movements (entry_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_moves_item') THEN
    ALTER TABLE inventory_movements ADD CONSTRAINT fk_inv_moves_item
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_moves_entry') THEN
    ALTER TABLE inventory_movements ADD CONSTRAINT fk_inv_moves_entry
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Optional item link on invoice / bill lines (drives GL account + stock).
-- ---------------------------------------------------------------------------
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_id INTEGER;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS item_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_lines_item') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_item
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_item') THEN
    ALTER TABLE bill_lines ADD CONSTRAINT fk_bill_lines_item
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Org policy: allow selling below zero stock? Default false (block).
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE;
