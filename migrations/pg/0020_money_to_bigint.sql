-- ============================================================================
-- 0020_money_to_bigint — widen every money column from INTEGER to BIGINT
--
-- Money is stored as INTEGER CENTS. A 32-bit integer caps a single amount at
-- $21,474,836.47 — too low for large invoices, payroll runs, or journal totals.
-- This widens every monetary column to BIGINT (8 bytes), lifting the cap to
-- ~$92 quadrillion while keeping the integer-cents contract. IDs, counts,
-- quantities, months and rates are deliberately left untouched.
--
-- ALTER ... TYPE BIGINT on an already-bigint column is a no-op success, so this
-- migration is safe to re-run. The node-postgres type parsers already return
-- int8/numeric as JS numbers (server/storage.ts), and the Drizzle schema uses
-- bigint({ mode: "number" }), so application code needs no data-shape changes.
-- ============================================================================

DO $$
DECLARE
  col TEXT[];
  money_cols TEXT[][] := ARRAY[
    -- journal
    ['journal_lines','debit'], ['journal_lines','credit'],
    -- inventory
    ['items','avg_cost_cents'], ['inventory_movements','unit_cost_cents'],
    -- invoices
    ['invoices','subtotal'], ['invoices','tax'], ['invoices','total'], ['invoices','amount_paid'],
    ['invoices','foreign_subtotal'], ['invoices','foreign_tax'], ['invoices','foreign_total'], ['invoices','foreign_amount_paid'],
    ['invoice_lines','amount'],
    -- bills
    ['bills','subtotal'], ['bills','tax'], ['bills','total'], ['bills','amount_paid'],
    ['bills','foreign_subtotal'], ['bills','foreign_tax'], ['bills','foreign_total'], ['bills','foreign_amount_paid'],
    ['bill_lines','amount'],
    -- bank
    ['bank_transactions','amount'], ['bank_rules','amount_min'], ['bank_rules','amount_max'],
    ['reconciliations','beginning_balance'], ['reconciliations','ending_balance'],
    -- credit / debit notes
    ['credit_notes','subtotal'], ['credit_notes','tax'], ['credit_notes','total'], ['credit_notes','applied_amount'], ['credit_notes','remaining_credit'],
    ['credit_note_lines','amount'], ['credit_note_applications','amount_applied'],
    ['debit_notes','subtotal'], ['debit_notes','tax'], ['debit_notes','total'], ['debit_notes','applied_amount'], ['debit_notes','remaining_debit'],
    ['debit_note_lines','amount'], ['debit_note_applications','amount_applied'],
    -- estimates
    ['estimates','subtotal_cents'], ['estimates','tax_cents'], ['estimates','total_cents'], ['estimate_lines','amount'],
    -- purchase orders
    ['purchase_order_lines','amount_cents'],
    -- fixed assets
    ['fixed_assets','cost_cents'], ['fixed_assets','salvage_cents'], ['depreciation_entries','amount_cents'],
    -- fx revaluation
    ['fx_revaluations','total_gain_cents'], ['fx_revaluations','total_loss_cents'],
    ['fx_revaluation_lines','foreign_outstanding_cents'], ['fx_revaluation_lines','booking_base_cents'],
    ['fx_revaluation_lines','revalued_base_cents'], ['fx_revaluation_lines','diff_cents'],
    -- payroll
    ['employees','pay_rate_cents'],
    ['payroll_runs','total_gross_cents'], ['payroll_runs','total_employee_tax_cents'], ['payroll_runs','total_employer_tax_cents'],
    ['payroll_runs','total_deductions_cents'], ['payroll_runs','total_net_cents'],
    ['payroll_items','gross_cents'], ['payroll_items','pretax_deduction_cents'], ['payroll_items','posttax_deduction_cents'],
    ['payroll_items','fed_withholding_cents'], ['payroll_items','state_withholding_cents'], ['payroll_items','ss_employee_cents'],
    ['payroll_items','medicare_employee_cents'], ['payroll_items','additional_medicare_cents'], ['payroll_items','ss_employer_cents'],
    ['payroll_items','medicare_employer_cents'], ['payroll_items','futa_cents'], ['payroll_items','suta_cents'],
    ['payroll_items','employee_tax_cents'], ['payroll_items','employer_tax_cents'], ['payroll_items','net_cents'],
    ['payroll_liability_payments','total_cents'], ['payroll_liability_payment_lines','amount_cents'],
    -- budgets (table lives only in migrations, not the Drizzle schema)
    ['budget_lines','amount']
  ];
BEGIN
  FOREACH col SLICE 1 IN ARRAY money_cols LOOP
    -- Only alter columns that exist and are not already bigint (keeps this
    -- idempotent and tolerant of environments missing an optional table).
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = col[1] AND column_name = col[2] AND data_type <> 'bigint'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE BIGINT', col[1], col[2]);
    END IF;
  END LOOP;
END $$;
