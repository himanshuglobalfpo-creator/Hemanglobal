/**
 * Property test: for any sequence of randomly-generated balanced journal entries,
 * the cash flow report's reconciliation gap must be exactly 0.00.
 *
 * Generates 100 random ledgers, each with up to 50 journal entries spanning
 * 2 years, and checks the invariant on multiple sub-period queries.
 */

const initSqlJs = require('sql.js');

async function main() {
const SQL = await initSqlJs();

// Account templates we'll randomly draw from
const accountSeed = [
  { code: '1000', name: 'Bank',                    type: 'asset',     subtype: 'bank' },
  { code: '1100', name: 'Accounts Receivable',     type: 'asset',     subtype: 'current_asset' },
  { code: '1200', name: 'Inventory',               type: 'asset',     subtype: 'current_asset' },
  { code: '1500', name: 'Equipment',               type: 'asset',     subtype: 'fixed_asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset',     subtype: 'accumulated_depreciation' },
  { code: '1700', name: 'Capitalized Software',    type: 'asset',     subtype: 'intangible_asset' },
  { code: '2000', name: 'Accounts Payable',        type: 'liability', subtype: 'current_liability' },
  { code: '2100', name: 'Sales Tax Payable',       type: 'liability', subtype: 'current_liability' },
  { code: '2700', name: 'Bank Loan',               type: 'liability', subtype: 'long_term_liability' },
  { code: '3000', name: "Owner's Equity",          type: 'equity',    subtype: 'equity' },
  { code: '3100', name: 'Retained Earnings',       type: 'equity',    subtype: 'equity' },
  { code: '4000', name: 'Sales Revenue',           type: 'income',    subtype: 'operating_income' },
  { code: '5000', name: 'COGS',                    type: 'expense',   subtype: 'cogs' },
  { code: '6000', name: 'Operating Expenses',      type: 'expense',   subtype: 'operating_expense' },
  { code: '6800', name: 'Depreciation Expense',    type: 'expense',   subtype: 'depreciation_expense' },
];

// Realistic transaction templates (each is balanced)
function txnTemplates(c) {
  return [
    { name: 'Sale on credit', lines: [{a: c['1100'], dr: 100}, {a: c['4000'], cr: 100}] },
    { name: 'Cash sale',      lines: [{a: c['1000'], dr: 100}, {a: c['4000'], cr: 100}] },
    { name: 'Collect AR',     lines: [{a: c['1000'], dr: 100}, {a: c['1100'], cr: 100}] },
    { name: 'COGS',           lines: [{a: c['5000'], dr: 100}, {a: c['1200'], cr: 100}] },
    { name: 'Buy inventory',  lines: [{a: c['1200'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'Buy on credit',  lines: [{a: c['1200'], dr: 100}, {a: c['2000'], cr: 100}] },
    { name: 'Pay vendor',     lines: [{a: c['2000'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'OpEx cash',      lines: [{a: c['6000'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'OpEx accrued',   lines: [{a: c['6000'], dr: 100}, {a: c['2000'], cr: 100}] },
    { name: 'Buy equipment',  lines: [{a: c['1500'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'Buy software',   lines: [{a: c['1700'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'Loan principal', lines: [{a: c['2700'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'New loan',       lines: [{a: c['1000'], dr: 100}, {a: c['2700'], cr: 100}] },
    { name: 'Owner contrib',  lines: [{a: c['1000'], dr: 100}, {a: c['3000'], cr: 100}] },
    { name: 'Owner draw',     lines: [{a: c['3000'], dr: 100}, {a: c['1000'], cr: 100}] },
    { name: 'Depreciation',   lines: [{a: c['6800'], dr: 100}, {a: c['1510'], cr: 100}] },
    { name: 'Sales tax',      lines: [{a: c['1100'], dr: 10},  {a: c['2100'], cr: 10}] },
  ];
}

function randomDate(year, month) {
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoDateInRange(startY, startM, endY, endM) {
  const months = [];
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    months.push([y, m]);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  const [py, pm] = months[Math.floor(Math.random() * months.length)];
  return randomDate(py, pm);
}

// ---- Ported FIXED algorithm (mirrors storage.ts exactly) ----
function makeAlgo(prepare, listAccounts) {

  function accountBalances(asOfDate) {
    const rows = prepare(`
      SELECT jl.account_id AS accountId,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl
      INNER JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.date <= ?
      GROUP BY jl.account_id
    `).all(asOfDate);
    const all = listAccounts();
    const acctMap = new Map(all.map(a => [a.id, a]));
    const result = new Map();
    for (const a of all) result.set(a.id, { debit: 0, credit: 0, balance: 0 });
    for (const r of rows) {
      const a = acctMap.get(r.accountId);
      if (!a) continue;
      const isDebitNormal = a.type === 'asset' || a.type === 'expense';
      const balance = isDebitNormal ? r.debit - r.credit : r.credit - r.debit;
      result.set(r.accountId, { debit: r.debit, credit: r.credit, balance });
    }
    return result;
  }

  function profitAndLoss(fromDate, toDate) {
    const all = listAccounts();
    let income = 0, expenses = 0;
    for (const a of all) {
      if (a.type !== 'income' && a.type !== 'expense') continue;
      const r = prepare(`
        SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_id = ? AND je.date >= ? AND je.date <= ?
      `).get(a.id, fromDate, toDate);
      if (a.type === 'income') income += (r.cr - r.dr);
      else expenses += (r.dr - r.cr);
    }
    return { netIncome: +(income - expenses).toFixed(2) };
  }

  function cashFlowStatement(fromDate, toDate) {
    const all = listAccounts();
    const beforeFrom = (() => {
      const d = new Date(fromDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const startBalances = accountBalances(beforeFrom);
    const endBalances = accountBalances(toDate);
    const change = (id) => {
      const s = startBalances.get(id)?.balance || 0;
      const e = endBalances.get(id)?.balance || 0;
      return +(e - s).toFixed(2);
    };
    const pl = profitAndLoss(fromDate, toDate);
    const netIncome = pl.netIncome;

    const isLongTermAsset = (a) => a.type === 'asset' && (a.subtype === 'fixed_asset' || a.subtype === 'intangible_asset');
    const isAccumDep = (a) => a.type === 'asset' && (a.subtype === 'accumulated_depreciation' || a.subtype === 'accumulated_amortization');
    const isLTL = (a) => a.type === 'liability' && a.subtype === 'long_term_liability';
    const isBank = (a) => a.subtype === 'bank';

    const operatingItems = [{ label: 'Net Income', amount: netIncome }];
    let depAdd = 0;
    for (const a of all.filter(isAccumDep)) {
      const ch = change(a.id); if (Math.abs(ch) < 0.01) continue;
      depAdd += -ch;
    }
    depAdd = +depAdd.toFixed(2);
    if (Math.abs(depAdd) >= 0.01) operatingItems.push({ label: 'D&A', amount: depAdd });
    for (const a of all) {
      const ch = change(a.id);
      if (Math.abs(ch) < 0.01) continue;
      if (isBank(a) || a.type === 'income' || a.type === 'expense' || isLongTermAsset(a) || isAccumDep(a) || isLTL(a) || a.type === 'equity') continue;
      if (a.type === 'asset') operatingItems.push({ label: a.name, amount: -ch });
      else if (a.type === 'liability') operatingItems.push({ label: a.name, amount: ch });
    }
    const operatingTotal = +operatingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);

    const investingItems = [];
    for (const a of all.filter(isLongTermAsset)) {
      const ch = change(a.id); if (Math.abs(ch) < 0.01) continue;
      investingItems.push({ amount: -ch });
    }
    const investingTotal = +investingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);

    const financingItems = [];
    for (const a of all.filter(x => x.type === 'equity')) {
      const ch = change(a.id); if (Math.abs(ch) < 0.01) continue;
      financingItems.push({ amount: ch });
    }
    for (const a of all.filter(isLTL)) {
      const ch = change(a.id); if (Math.abs(ch) < 0.01) continue;
      financingItems.push({ amount: ch });
    }
    const financingTotal = +financingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);
    const netCashChange = +(operatingTotal + investingTotal + financingTotal).toFixed(2);
    const cashAccts = all.filter(isBank);
    const cashStart = +cashAccts.reduce((s, a) => s + (startBalances.get(a.id)?.balance || 0), 0).toFixed(2);
    const cashEnd = +cashAccts.reduce((s, a) => s + (endBalances.get(a.id)?.balance || 0), 0).toFixed(2);
    return { netCashChange, cashStart, cashEnd, gap: +(cashEnd - cashStart - netCashChange).toFixed(2) };
  }

  return { cashFlowStatement };
}

// =============================================================================
// Run N random ledger sims, each with several CF queries
// =============================================================================
const N_SIMS = 100;
const N_TXNS_MIN = 5, N_TXNS_MAX = 50;
const N_QUERIES_PER_SIM = 3;

let totalQueries = 0, failures = 0;
const failureExamples = [];

for (let sim = 0; sim < N_SIMS; sim++) {
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, type TEXT, subtype TEXT);
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT);
    CREATE TABLE journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, account_id INTEGER, debit REAL DEFAULT 0, credit REAL DEFAULT 0);
  `);

  function prepare(sql) {
    return {
      run: (...args) => { const s = db.prepare(sql); s.run(args); s.free(); },
      get: (...args) => { const s = db.prepare(sql); s.bind(args); let r = null; if (s.step()) r = s.getAsObject(); s.free(); return r; },
      all: (...args) => { const s = db.prepare(sql); s.bind(args); const o = []; while (s.step()) o.push(s.getAsObject()); s.free(); return o; },
    };
  }

  // Seed accounts
  for (const a of accountSeed) {
    prepare('INSERT INTO accounts (code,name,type,subtype) VALUES (?,?,?,?)').run(a.code, a.name, a.type, a.subtype);
  }
  const codeToId = {};
  for (const r of prepare('SELECT id, code FROM accounts').all()) codeToId[r.code] = r.id;
  const tpls = txnTemplates(codeToId);

  function listAccounts() {
    return prepare('SELECT id, code, name, type, subtype FROM accounts').all();
  }

  // Seed an opening balance JE that's balanced: Bank 100000 / Owner's Equity 100000
  prepare('INSERT INTO journal_entries (date) VALUES (?)').run('2023-12-31');
  let openId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(openId, codeToId['1000'], 100000, 0);
  prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(openId, codeToId['3000'], 0, 100000);

  // Generate random JEs across 2024-2025
  const nTxns = N_TXNS_MIN + Math.floor(Math.random() * (N_TXNS_MAX - N_TXNS_MIN));
  for (let i = 0; i < nTxns; i++) {
    const tpl = tpls[Math.floor(Math.random() * tpls.length)];
    const amt = Math.round(Math.random() * 9000 + 100);
    const date = isoDateInRange(2024, 1, 2025, 12);
    prepare('INSERT INTO journal_entries (date) VALUES (?)').run(date);
    const eid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    for (const ln of tpl.lines) {
      prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(
        eid, ln.a, (ln.dr || 0) * (amt / 100), (ln.cr || 0) * (amt / 100)
      );
    }
  }

  // Optionally post a closing JE at end of 2024
  if (Math.random() < 0.5) {
    // Compute prior-year NI from journal lines in 2024
    let income = 0, expense = 0;
    for (const a of listAccounts()) {
      if (a.type !== 'income' && a.type !== 'expense') continue;
      const r = prepare(`SELECT COALESCE(SUM(debit),0) dr, COALESCE(SUM(credit),0) cr
        FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE jl.account_id=? AND je.date>=? AND je.date<=?`).get(a.id, '2024-01-01', '2024-12-31');
      if (a.type === 'income') income += (r.cr - r.dr);
      else expense += (r.dr - r.cr);
    }
    const ni2024 = income - expense;
    if (Math.abs(ni2024) > 0.01) {
      prepare('INSERT INTO journal_entries (date) VALUES (?)').run('2024-12-31');
      const cid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      // Close all income/expense accounts to RE
      for (const a of listAccounts()) {
        if (a.type !== 'income' && a.type !== 'expense') continue;
        const r = prepare(`SELECT COALESCE(SUM(debit),0) dr, COALESCE(SUM(credit),0) cr
          FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
          WHERE jl.account_id=? AND je.date>=? AND je.date<=?`).get(a.id, '2024-01-01', '2024-12-31');
        if (a.type === 'income') {
          const bal = r.cr - r.dr;
          if (Math.abs(bal) < 0.01) continue;
          if (bal > 0) prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, bal, 0);
          else prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, 0, -bal);
        } else {
          const bal = r.dr - r.cr;
          if (Math.abs(bal) < 0.01) continue;
          if (bal > 0) prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, 0, bal);
          else prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, -bal, 0);
        }
      }
      // Plug RE
      if (ni2024 > 0) prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, codeToId['3100'], 0, ni2024);
      else prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, codeToId['3100'], -ni2024, 0);
    }
  }

  const algo = makeAlgo(prepare, listAccounts);

  // Run several cash flow queries — varying sub-periods
  const queries = [
    ['2024-01-01', '2024-12-31'], // FY 2024
    ['2025-01-01', '2025-12-31'], // FY 2025
    ['2024-06-01', '2025-06-30'], // straddling year
    ['2024-01-01', '2025-12-31'], // both years
  ];
  for (const [from, to] of queries) {
    const cf = algo.cashFlowStatement(from, to);
    totalQueries++;
    if (Math.abs(cf.gap) >= 0.01) {
      failures++;
      if (failureExamples.length < 3) failureExamples.push({ sim, from, to, ...cf });
    }
  }

  db.close();
}

console.log(`\nProperty test results:`);
console.log(`  Simulations: ${N_SIMS}`);
console.log(`  Total cash-flow queries: ${totalQueries}`);
console.log(`  Failures (non-zero gap): ${failures}`);
if (failures > 0) {
  console.log(`  Sample failures:`);
  for (const f of failureExamples) console.log('   ', f);
  process.exit(1);
} else {
  console.log(`  ✅ Property holds: reconciliation gap is exactly 0.00 in every case`);
}
}
main().catch(e => { console.error(e); process.exit(1); });
