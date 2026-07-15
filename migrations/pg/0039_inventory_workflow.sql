-- ============================================================================
-- 0039_inventory_workflow — low-stock reorder + product bundles
--
-- Reorder: items carry a reorder point/qty and a preferred vendor; a suggestion
-- fires when on-hand PLUS open (undelivered) PO quantity is at/below the point.
-- Bundles: a bundle item is composed of component items (bundle_components).
-- Selling a bundle explodes to component inventory relief + COGS while printing
-- as one line. Bundles cannot be nested (enforced in code). Idempotent.
-- ============================================================================

ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_point INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_qty   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS preferred_vendor_id INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bundle_components (
  id               SERIAL PRIMARY KEY,
  org_id           INTEGER NOT NULL,
  bundle_item_id   INTEGER NOT NULL,
  component_item_id INTEGER NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1   -- component units per 1 bundle
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_component ON bundle_components(bundle_item_id, component_item_id);
CREATE INDEX IF NOT EXISTS idx_bundle_org ON bundle_components(org_id, bundle_item_id);
