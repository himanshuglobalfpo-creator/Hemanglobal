-- ============================================================================
-- 0025_inventory_costing_method — FIFO/LIFO inventory costing
--
-- Per-org costing_method ('average' default | 'fifo' | 'lifo') plus a cost-layer
-- table for FIFO/LIFO. A layer is one purchase lot with remaining quantity and
-- remaining cost (integer cents); FIFO consumes oldest first, LIFO newest.
-- Idempotent.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS costing_method TEXT NOT NULL DEFAULT 'average';

CREATE TABLE IF NOT EXISTS inventory_layers (
  id                   SERIAL PRIMARY KEY,
  org_id               INTEGER NOT NULL,
  item_id              INTEGER NOT NULL,
  date                 TEXT NOT NULL,
  qty_remaining        INTEGER NOT NULL,
  cost_remaining_cents BIGINT NOT NULL,
  unit_cost_cents      BIGINT NOT NULL,
  source               TEXT NOT NULL,
  source_id            INTEGER,
  created_at           TIMESTAMP NOT NULL DEFAULT now()
);
-- Consumption order (FIFO asc / LIFO desc) and open-layer scans.
CREATE INDEX IF NOT EXISTS idx_inv_layers_item
  ON inventory_layers(org_id, item_id, date, id) WHERE qty_remaining > 0;
