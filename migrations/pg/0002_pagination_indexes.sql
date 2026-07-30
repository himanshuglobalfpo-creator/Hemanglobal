-- ============================================================================
-- 0002_pagination_indexes — composite indexes for the paginated list queries
--
-- Every paginated endpoint filters on org_id and sorts as noted below. The
-- existing single-column org indexes force a sort node on every page; these
-- composite indexes let PostgreSQL satisfy WHERE + ORDER BY + LIMIT with a
-- single index scan (verified via EXPLAIN — see acceptance in Task 1).
-- All idempotent via IF NOT EXISTS.
-- ============================================================================

-- invoices: WHERE org_id = ? ORDER BY date DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_invoices_org_date_id ON invoices(org_id, date DESC, id DESC);

-- bills: WHERE org_id = ? ORDER BY date DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_bills_org_date_id ON bills(org_id, date DESC, id DESC);

-- journal_entries: WHERE org_id = ? ORDER BY date DESC, id DESC
-- (existing idx_journal_entries_org(org_id, date) is ASC and lacks the id
-- tiebreaker; this one matches the sort exactly)
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date_id ON journal_entries(org_id, date DESC, id DESC);

-- customers / vendors: WHERE org_id = ? ORDER BY name
CREATE INDEX IF NOT EXISTS idx_customers_org_name ON customers(org_id, name);
CREATE INDEX IF NOT EXISTS idx_vendors_org_name ON vendors(org_id, name);

-- bank_transactions: WHERE org_id = ? [AND bank_account_id = ?] [AND status = ?]
--                    ORDER BY date DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_bank_tx_org_date_id ON bank_transactions(org_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bank_tx_org_account_date ON bank_transactions(org_id, bank_account_id, date DESC, id DESC);

-- audit_log: WHERE org_id = ? [+ optional filters] ORDER BY id DESC
CREATE INDEX IF NOT EXISTS idx_audit_log_org_id_desc ON audit_log(org_id, id DESC);

-- suggestMatches (Task 8b) candidate queries: org + status + outstanding balance
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices(org_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_org_status ON bills(org_id, status);
