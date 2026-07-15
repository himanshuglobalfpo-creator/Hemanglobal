// ============================================================================
// SALES-TAX FILING WORKFLOW (P3.8) — liability tie-out & payment clears payable
// ============================================================================
// Graded invariants:
//   1. A period's liability equals the sum of the tax JE lines for that period
//      (the tax collected on the state's tax codes = the Sales Tax Payable
//      credits from those invoices).
//   2. Recording the payment posts Dr Sales Tax Payable / Cr Bank and clears the
//      period's payable movement to exactly zero.
//
// Postgres harness (uses $DATABASE_URL if set, else embedded-postgres).
import { setupTestDb } from "./harness";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("tax_filing");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Taxco','taxco')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('t@t.test','x','Taxer')`);
    await seedOrgDefaults(1);

    await withOrg({ orgId: 1, userId: 1 }, async () => {
      const custId = (await pool.query(`INSERT INTO customers (org_id, name) VALUES (1,'Acme') RETURNING id`)).rows[0].id as number;
      const income = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='4000'`)).rows[0].id as number;
      const stp = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='2100'`)).rows[0].id as number;
      const bank = (await pool.query(`SELECT id FROM accounts WHERE org_id=1 AND code='1000'`)).rows[0].id as number;
      // Each state files against its own Sales Tax Payable account.
      const nyAcct = (await pool.query(`INSERT INTO accounts (org_id, code, name, type, subtype, is_active) VALUES (1,'2101','NY Sales Tax Payable','liability','current_liability',true) RETURNING id`)).rows[0].id as number;
      const caCode = (await pool.query(`INSERT INTO tax_codes (org_id, name, rate, liability_account_id, state_code) VALUES (1,'CA Sales Tax',10,$1,'CA') RETURNING id`, [stp])).rows[0].id as number;
      const nyCode = (await pool.query(`INSERT INTO tax_codes (org_id, name, rate, liability_account_id, state_code) VALUES (1,'NY Sales Tax',8,$1,'NY') RETURNING id`, [nyAcct])).rows[0].id as number;

      const mkInv = (n: string, code: number, rate: number) => storage.createInvoice({
        number: n, customerId: custId, date: "2026-02-15", dueDate: "2026-03-15", taxRate: rate, taxCodeId: code,
        lines: [{ description: "Goods", quantity: 1, rate: 1000, incomeAccountId: income }],
      } as any);
      await mkInv("INV-CA1", caCode, 10); // $1000 → $100 CA tax
      await mkInv("INV-CA2", caCode, 10); // $1000 → $100 CA tax
      await mkInv("INV-NY1", nyCode, 8);  // $80 NY tax — excluded from CA

      const from = "2026-01-01", to = "2026-03-31";

      console.log("Test: liability equals the sum of the period's tax JE lines (CA only)");
      const liability = await storage.computeStateTaxLiability("CA", from, to);
      // Independent: sum of tax CREDITS to the CA Sales Tax Payable account from
      // invoice JEs in the period.
      const jeTax = Number((await pool.query(
        `SELECT COALESCE(SUM(jl.credit),0)::bigint AS t
           FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.org_id=1 AND jl.account_id=$1 AND je.source='invoice' AND je.date BETWEEN $2 AND $3`,
        [stp, from, to]
      )).rows[0].t);
      check("CA liability = $200.00 (20000 cents)", liability === 20000);
      check("liability equals the CA tax JE credit lines", liability === jeTax);
      check("NY tax is excluded from the CA period", (await storage.computeStateTaxLiability("NY", from, to)) === 8000);

      console.log("Test: file then pay clears the payable to zero");
      const period = await storage.createTaxFilingPeriod({ stateCode: "CA", cadence: "quarterly", periodStart: from, periodEnd: to } as any);
      check("period opens with the snapshot liability", period.liabilityCents === 20000 && period.status === "open");
      check("due date defaults to 20 days after period end", period.dueDate === "2026-04-20");

      const filed = await storage.recordTaxFiling(period.id, "CA-CONF-123", "2026-04-10");
      check("filing records confirmation + status filed", filed!.status === "filed" && filed!.confirmationNumber === "CA-CONF-123");

      const paid = await storage.recordTaxPayment(period.id, bank, "2026-04-15");
      check("payment marks the period paid with a JE link", paid.status === "paid" && !!paid.paymentEntryId);

      // The payment JE is Dr 2100 / Cr Bank for the liability.
      const pmtLines = (await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE entry_id=$1 ORDER BY debit DESC`, [paid.paymentEntryId])).rows as any[];
      check("payment debits Sales Tax Payable by the liability", pmtLines[0].account_id === stp && Number(pmtLines[0].debit) === 20000);
      check("payment credits the bank by the liability", pmtLines[1].account_id === bank && Number(pmtLines[1].credit) === 20000);

      // Net movement on the CA tax account across collection + payment = 0.
      const movement = await storage.stateTaxPayableMovement("CA", from, "2026-04-30");
      check("CA Sales Tax Payable movement clears to zero (collected − paid)", movement === 0);

      console.log("Test: a paid period cannot be paid again");
      let threw = false;
      try { await storage.recordTaxPayment(period.id, bank, "2026-04-16"); } catch { threw = true; }
      check("double payment is rejected", threw);
    });

    await pool.end();
  } finally {
    await cleanup();
  }

  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — liability = period tax JE lines; payment clears the payable to zero");
})().catch((e) => { console.error("FAIL:", e.stack || e.message); process.exit(1); });
