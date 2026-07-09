-- ============================================================================
-- 0014_purchase_orders — AP pre-document that converts into a bill
--
-- A purchase order is a COMMITMENT to buy; it posts NO journal entry. Receiving
-- a PO (fully or in part) creates a bill for the received portion via the
-- existing createBill() flow (that is where the GL effect and any inventory
-- movements happen). Over-receipt is blocked in the storage layer.
--
--   • purchase_orders       — header. number is per-org unique, allocated by the
--                             number_sequences allocator (kind 'purchase_order').
--   • purchase_order_lines  — ordered lines with a running qty_received.
--   • bills.po_id           — links a generated bill back to its PO.
--
-- org_id is NOT NULL with NO DEFAULT (house rule); storage stamps currentOrgId().
-- Every statement is idempotent (safe to re-run).
-- ============================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL,
  number        TEXT    NOT NULL,
  vendor_id     INTEGER NOT NULL,
  date          TEXT    NOT NULL,           -- YYYY-MM-DD
  expected_date TEXT,
  status        TEXT    NOT NULL DEFAULT 'open', -- open|partial|received|closed|cancelled
  currency      TEXT    NOT NULL DEFAULT '',
  fx_rate       DOUBLE PRECISION NOT NULL DEFAULT 1,
  notes         TEXT,
  updated_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_orders_org_number ON purchase_orders (org_id, number);
CREATE INDEX IF NOT EXISTS ix_purchase_orders_org ON purchase_orders (org_id);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                 SERIAL PRIMARY KEY,
  org_id             INTEGER NOT NULL,
  po_id              INTEGER NOT NULL,
  description        TEXT    NOT NULL,
  quantity           DOUBLE PRECISION NOT NULL DEFAULT 1, -- ordered quantity
  rate               DOUBLE PRECISION NOT NULL DEFAULT 0, -- unit price in dollars (sub-cent allowed)
  amount_cents       INTEGER NOT NULL DEFAULT 0,          -- round(quantity * rate * 100)
  expense_account_id INTEGER NOT NULL,
  item_id            INTEGER,                             -- optional catalog item
  qty_received       INTEGER NOT NULL DEFAULT 0           -- whole units received so far
);

CREATE INDEX IF NOT EXISTS ix_po_lines_org_po ON purchase_order_lines (org_id, po_id);

-- Link a generated bill back to the purchase order it came from.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS po_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_orders_vendor') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT fk_purchase_orders_vendor
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_po_lines_po') THEN
    ALTER TABLE purchase_order_lines ADD CONSTRAINT fk_po_lines_po
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_po_lines_expense_account') THEN
    ALTER TABLE purchase_order_lines ADD CONSTRAINT fk_po_lines_expense_account
      FOREIGN KEY (expense_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_po_lines_item') THEN
    ALTER TABLE purchase_order_lines ADD CONSTRAINT fk_po_lines_item
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_po') THEN
    ALTER TABLE bills ADD CONSTRAINT fk_bills_po
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
