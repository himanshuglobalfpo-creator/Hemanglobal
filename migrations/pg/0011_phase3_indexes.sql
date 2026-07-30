-- ============================================================================
-- 0011_phase3_indexes — composite indexes for Phase 1-3 hot paths
-- (Verified against EXPLAIN on: sales-by-customer, budget-vs-actual, webhook
--  due-delivery scan; paginated invoice list already covered by 0002.)
-- ============================================================================

-- Report grouping: invoices/bills filtered by org + date range, grouped by party.
CREATE INDEX IF NOT EXISTS idx_invoices_org_customer_date ON invoices(org_id, customer_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_org_vendor_date ON bills(org_id, vendor_id, date);

-- Monthly P&L / budget-vs-actual: journal_lines joined to entries by date range.
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date ON journal_entries(org_id, date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

-- Credit/debit notes in the report window.
CREATE INDEX IF NOT EXISTS idx_credit_notes_org_customer_date ON credit_notes(org_id, customer_id, date);
CREATE INDEX IF NOT EXISTS idx_debit_notes_org_vendor_date ON debit_notes(org_id, vendor_id, date);

-- Webhook worker due-scan: status + time is the exact predicate.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_time ON webhook_deliveries(status, next_attempt_at) WHERE status IN ('pending','failed');

-- Attachment listing by entity.
CREATE INDEX IF NOT EXISTS idx_attachments_lookup ON attachments(org_id, entity_type, entity_id);

-- Budget-vs-actual line aggregation.
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget_month ON budget_lines(budget_id, month);
