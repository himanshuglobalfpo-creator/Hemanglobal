-- ============================================================================
-- 0046_report_covering_indexes — index-only aggregation for reports at scale
-- ============================================================================
-- The P&L / balance-sheet / trial-balance engine (storage buildReport) runs:
--
--   SELECT jl.account_id, SUM(jl.debit), SUM(jl.credit)
--     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
--    WHERE je.org_id = $1 AND je.date BETWEEN $2 AND $3
--    GROUP BY jl.account_id;
--
-- je is filtered by idx_journal_entries_org_date_id; the jl side is then reached
-- by entry_id. Without the covering columns, every matching line is a heap
-- fetch just to read (account_id, debit, credit) — the dominant cost at 100k+
-- lines. INCLUDE-ing those three turns the jl access into an INDEX-ONLY scan.
--
-- The second index serves org-scoped account aggregation (account ledgers,
-- integrity checks) the same way. Both are additive and idempotent.
-- ============================================================================

-- Report join+aggregate path: reach lines by entry, read the aggregated columns
-- straight from the index.
CREATE INDEX IF NOT EXISTS idx_jl_entry_covering
  ON journal_lines(entry_id) INCLUDE (account_id, debit, credit);

-- Org+account aggregation path (trial balance by account, account ledgers).
CREATE INDEX IF NOT EXISTS idx_jl_org_account_covering
  ON journal_lines(org_id, account_id) INCLUDE (debit, credit);
