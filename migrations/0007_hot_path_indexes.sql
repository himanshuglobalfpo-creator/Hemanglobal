-- 0007_hot_path_indexes.sql — TASK 8: composite indexes for hot paths
-- verified with EXPLAIN QUERY PLAN (see README "Performance" section).

-- Paginated invoice/bill lists: ORDER BY date DESC, id DESC within org (+ status filter).
CREATE INDEX IF NOT EXISTS idx_invoices_org_date_id ON invoices(org_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices(org_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_org_date_id ON bills(org_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bills_org_status ON bills(org_id, status);

-- Sales-by-customer / expenses-by-vendor: range scan by org + date, group by party.
CREATE INDEX IF NOT EXISTS idx_invoices_org_customer_date ON invoices(org_id, customer_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_org_vendor_date ON bills(org_id, vendor_id, date);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org_customer_date ON credit_notes(org_id, customer_id, date);

-- Budget-vs-actual & P&L monthly: journal lines joined to entries by org+date,
-- aggregated per account.
CREATE INDEX IF NOT EXISTS idx_jl_account_entry ON journal_lines(account_id, entry_id);

-- Webhook due-delivery scan: WHERE status IN ('pending','failed') AND next_attempt_at <= now AND attempts < 6.
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_webhook_created ON webhook_deliveries(webhook_id, created_at DESC);

-- Audit page: filter by org + entity/user/action + created range.
CREATE INDEX IF NOT EXISTS idx_audit_org_entity ON audit_log(org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_org_user ON audit_log(org_id, user_id);
