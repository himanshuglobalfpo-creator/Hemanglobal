/**
 * Property test for balanceSheet():
 * For any well-formed (balanced) ledger and any as-of date,
 *   totalAssets = totalLiabilities + totalEquity
 * This is the accounting identity. Should always hold to within rounding.
 *
 * Re-uses the random ledger generator from cashflow_property_test.
 */

const initSqlJs = require('sql.js');

async function main() {
const SQL = await initSqlJs();

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

function txnTemplates(c) {
  return [
    { lines: [{a: c['1100'], dr: 100}, {a: c['4000'], cr: 100}] },     // Sale on credit
    { lines: [{a: c['1000'], dr: 100}, {a: c['4000'], cr: 100}] },     // Cash sale
    { lines: [{a: c['1000'], dr: 100}, {a: c['1100'], cr: 100}] },     // Collect AR
    { lines: [{a: c['5000'], dr: 100}, {a: c['1200'], cr: 100}] },     // COGS
    { lines: [{a: c['1200'], dr: 100}, {a: c['2000'], cr: 100}] },     // Buy inventory on credit
    { lines: [{a: c['2000'], dr: 100}, {a: c['1000'], cr: 100}] },     // Pay vendor
    { lines: [{a: c['6000'], dr: 100}, {a: c['1000'], cr: 100}] },     // OpEx
    { lines: [{a: c['1500'], dr: 100}, {a: c['1000'], cr: 100}] },     // Buy equipment
    { lines: [{a: c['2700'], dr: 100}, {a: c['1000'], cr: 100}] },     // Loan principal
    { lines: [{a: c['1000'], dr: 100}, {a: c['3000'], cr: 100}] },     // Owner contrib
    { lines: [{a: c['6800'], dr: 100}, {a: c['1510'], cr: 100}] },     // Depreciation
    { lines: [{a: c['1700'], dr: 100}, {a: c['1000'], cr: 100}] },     // Buy software
  ];
}

function randomDate(yMin, yMax) {
  const y = yMin + Math.floor(Math.random() * (yMax - yMin + 1));
  const m = 1 + Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// FIXED algorithm port (mirrors balanceSheet in storage.ts)
function makeAlgo(prepare, listAccounts) {
  function accountBalances(asOfDate) {
    const rows = prepare(`
      SELECT jl.account_id AS accountId, COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.date <= ? GROUP BY jl.account_id`).all(asOfDate);
    const all = listAccounts();
    const acctMap = new Map(all.map(a => [a.id, a]));
    const result = new Map();
    for (const a of all) result.set(a.id, { balance: 0 });
    for (const r of rows) {
      const a = acctMap.get(r.accountId); if (!a) continue;
      const isDebitNormal = a.type === 'asset' || a.type === 'expense';
      result.set(r.accountId, { balance: isDebitNormal ? r.debit - r.credit : r.credit - r.debit });
    }
    return result;
  }
  function profitAndLoss(fromDate, toDate) {
    const all = listAccounts();
    let income = 0, expenses = 0;
    for (const a of all) {
      if (a.type !== 'income' && a.type !== 'expense') continue;
      const r = prepare(`SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
        FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE jl.account_id=? AND je.date>=? AND je.date<=?`).get(a.id, fromDate, toDate);
      if (a.type === 'income') income += (r.cr - r.dr);
      else expenses += (r.dr - r.cr);
    }
    return { netIncome: +(income - expenses).toFixed(2) };
  }
  function balanceSheet(asOfDate) {
    const balances = accountBalances(asOfDate);
    const all = listAccounts();
    const pl = profitAndLoss('0000-01-01', asOfDate);
    const netIncome = pl.netIncome;
    const sumByType = (t) => +all.filter(a => a.type === t)
      .reduce((s, a) => s + (balances.get(a.id)?.balance || 0), 0).toFixed(2);
    const totalAssets = sumByType('asset');
    const totalLiabilities = sumByType('liability');
    const equityFromAccounts = sumByType('equity');
    const totalEquity = +(equityFromAccounts + netIncome).toFixed(2);
    return { totalAssets, totalLiabilities, totalEquity, netIncome,
             gap: +(totalAssets - totalLiabilities - totalEquity).toFixed(2) };
  }
  return { balanceSheet };
}

// =============================================================================
const N_SIMS = 100;
let totalQueries = 0, failures = 0;
const examples = [];

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
  for (const a of accountSeed) prepare('INSERT INTO accounts (code,name,type,subtype) VALUES (?,?,?,?)').run(a.code, a.name, a.type, a.subtype);
  const codeToId = {};
  for (const r of prepare('SELECT id, code FROM accounts').all()) codeToId[r.code] = r.id;
  const tpls = txnTemplates(codeToId);
  function listAccounts() { return prepare('SELECT id, code, name, type, subtype FROM accounts').all(); }

  // Opening: Bank 100k = Owner's Equity 100k
  prepare('INSERT INTO journal_entries (date) VALUES (?)').run('2022-12-31');
  let oid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(oid, codeToId['1000'], 100000, 0);
  prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(oid, codeToId['3000'], 0, 100000);

  // Random transactions across 2023 and 2024
  const nTxns = 5 + Math.floor(Math.random() * 45);
  for (let i = 0; i < nTxns; i++) {
    const t = tpls[Math.floor(Math.random() * tpls.length)];
    const amt = Math.round(Math.random() * 9000 + 100);
    const date = randomDate(2023, 2024);
    prepare('INSERT INTO journal_entries (date) VALUES (?)').run(date);
    const eid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    for (const ln of t.lines) {
      prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(eid, ln.a, (ln.dr || 0) * (amt / 100), (ln.cr || 0) * (amt / 100));
    }
  }

  // Optionally close 2023
  const close2023 = Math.random() < 0.5;
  if (close2023) {
    let income = 0, expense = 0;
    for (const a of listAccounts()) {
      if (a.type !== 'income' && a.type !== 'expense') continue;
      const r = prepare(`SELECT COALESCE(SUM(debit),0) dr, COALESCE(SUM(credit),0) cr
        FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE jl.account_id=? AND je.date>=? AND je.date<=?`).get(a.id, '2023-01-01', '2023-12-31');
      if (a.type === 'income') income += (r.cr - r.dr); else expense += (r.dr - r.cr);
    }
    const ni = income - expense;
    if (Math.abs(ni) > 0.01) {
      prepare('INSERT INTO journal_entries (date) VALUES (?)').run('2023-12-31');
      const cid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      for (const a of listAccounts()) {
        if (a.type !== 'income' && a.type !== 'expense') continue;
        const r = prepare(`SELECT COALESCE(SUM(debit),0) dr, COALESCE(SUM(credit),0) cr
          FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
          WHERE jl.account_id=? AND je.date>=? AND je.date<=?`).get(a.id, '2023-01-01', '2023-12-31');
        if (a.type === 'income') {
          const bal = r.cr - r.dr; if (Math.abs(bal) < 0.01) continue;
          prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, bal > 0 ? bal : 0, bal < 0 ? -bal : 0);
        } else {
          const bal = r.dr - r.cr; if (Math.abs(bal) < 0.01) continue;
          prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, a.id, bal < 0 ? -bal : 0, bal > 0 ? bal : 0);
        }
      }
      prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES (?,?,?,?)').run(cid, codeToId['3100'], ni < 0 ? -ni : 0, ni > 0 ? ni : 0);
    }
  }

  const algo = makeAlgo(prepare, listAccounts);

  // Test BS at multiple as-of dates
  const dates = ['2023-06-30', '2023-12-31', '2024-06-30', '2024-12-31'];
  for (const d of dates) {
    const bs = algo.balanceSheet(d);
    totalQueries++;
    if (Math.abs(bs.gap) >= 0.01) {
      failures++;
      if (examples.length < 5) examples.push({ sim, asOf: d, close2023, ...bs });
    }
  }

  db.close();
}

console.log(`\nBalance Sheet property test:`);
console.log(`  Simulations: ${N_SIMS}`);
console.log(`  Total balance-sheet queries: ${totalQueries}`);
console.log(`  Failures (Assets ≠ Liab + Equity): ${failures}`);
if (failures > 0) {
  console.log(`  Sample failures:`);
  for (const f of examples) console.log('   ', f);
  process.exit(1);
} else {
  console.log(`  ✅ Property holds: A = L + E in every case`);
}
}
main().catch(e => { console.error(e); process.exit(1); });
