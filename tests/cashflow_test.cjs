/**
 * Runtime verification of the cash flow fix.
 *
 * We cannot import storage.ts directly (it's TypeScript and uses ESM imports), so we
 * reproduce the FIXED algorithm in this file and run it against a synthetic ledger
 * stored in an in-memory SQLite database. We then verify that for every well-formed
 * scenario, the reconciliation gap is exactly zero.
 *
 * Scenarios covered:
 *   1. Clean Q1 — basic operating + investing + financing activity, no edge cases
 *   2. Year-end-close inside the period (the Bug #2 trigger)
 *   3. Intangible asset purchase (the Bug #1 trigger)
 *   4. Depreciation entry (the Bug #3 trigger)
 *   5. All four combined
 */

const initSqlJs = require('sql.js');

// ============================================================================
// Set up in-memory ledger
// ============================================================================
async function main() {
const SQL = await initSqlJs();
const db = new SQL.Database();
db.exec(`
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    memo TEXT,
    reference TEXT,
    source TEXT
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    description TEXT
  );
`);

// Helper to mimic better-sqlite3 prepare API on top of sql.js
function prepare(sql) {
  return {
    run: (...args) => {
      const stmt = db.prepare(sql);
      stmt.run(args);
      // For lastInsertRowid:
      const r = db.exec('SELECT last_insert_rowid() AS id')[0];
      stmt.free();
      return { lastInsertRowid: r ? r.values[0][0] : undefined };
    },
    get: (...args) => {
      const stmt = db.prepare(sql);
      stmt.bind(args);
      let row = null;
      if (stmt.step()) row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    all: (...args) => {
      const stmt = db.prepare(sql);
      stmt.bind(args);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    },
  };
}

// ----- Default chart of accounts (mirrors the real DEFAULT_COA) -----
const accountSeed = [
  { code: '1000', name: 'Checking',                type: 'asset',     subtype: 'bank' },
  { code: '1100', name: 'Accounts Receivable',     type: 'asset',     subtype: 'current_asset' },
  { code: '1200', name: 'Inventory',               type: 'asset',     subtype: 'current_asset' },
  { code: '1500', name: 'Office Equipment',        type: 'asset',     subtype: 'fixed_asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset',     subtype: 'accumulated_depreciation' },
  { code: '1700', name: 'Capitalized Software',    type: 'asset',     subtype: 'intangible_asset' },
  { code: '2000', name: 'Accounts Payable',        type: 'liability', subtype: 'current_liability' },
  { code: '2100', name: 'Sales Tax Payable',       type: 'liability', subtype: 'current_liability' },
  { code: '2700', name: 'Bank Loan',               type: 'liability', subtype: 'long_term_liability' },
  { code: '3000', name: "Owner's Equity",          type: 'equity',    subtype: 'equity' },
  { code: '3100', name: 'Retained Earnings',       type: 'equity',    subtype: 'equity' },
  { code: '4000', name: 'Sales Revenue',           type: 'income',    subtype: 'operating_income' },
  { code: '5000', name: 'Cost of Goods Sold',      type: 'expense',   subtype: 'cogs' },
  { code: '6000', name: 'Operating Expenses',      type: 'expense',   subtype: 'operating_expense' },
  { code: '6800', name: 'Depreciation Expense',    type: 'expense',   subtype: 'depreciation_expense' },
];
const insAcct = prepare('INSERT INTO accounts (code,name,type,subtype) VALUES (?,?,?,?)');
for (const a of accountSeed) insAcct.run(a.code, a.name, a.type, a.subtype);

const codeToId = {};
for (const r of prepare('SELECT id, code FROM accounts').all()) codeToId[r.code] = r.id;

let entryCounter = 0;
function postJE(date, memo, lines) {
  const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.001) throw new Error(`UNBALANCED JE "${memo}": Dr ${dr} vs Cr ${cr}`);
  const r = prepare('INSERT INTO journal_entries (date,memo,reference,source) VALUES (?,?,?,?)')
    .run(date, memo, `JE-${++entryCounter}`, 'test');
  const insLine = prepare('INSERT INTO journal_lines (entry_id,account_id,debit,credit,description) VALUES (?,?,?,?,?)');
  for (const l of lines) insLine.run(r.lastInsertRowid, l.acctId, l.debit || 0, l.credit || 0, l.description || '');
}

// ============================================================================
// FIXED algorithm — exact mirror of the corrected cashFlowStatement
// ============================================================================
function listAccounts() {
  return prepare('SELECT id, code, name, type, subtype FROM accounts').all();
}

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
  return { income, expenses, netIncome: +(income - expenses).toFixed(2) };
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
  const warnings = [];

  const isLongTermAsset = (a) => a.type === 'asset' && (a.subtype === 'fixed_asset' || a.subtype === 'intangible_asset');
  const isAccumDepreciation = (a) => a.type === 'asset' &&
    (a.subtype === 'accumulated_depreciation' || a.subtype === 'accumulated_amortization' ||
     /^accumulated\b.*(depreciation|amortization)/i.test(a.name));
  const isLongTermLiability = (a) => a.type === 'liability' && a.subtype === 'long_term_liability';
  const isBank = (a) => a.subtype === 'bank';

  // ---- Operating ----
  const operatingItems = [{ label: 'Net Income', amount: netIncome }];

  // Depreciation add-back
  let depAddback = 0;
  for (const a of all.filter(isAccumDepreciation)) {
    const ch = change(a.id);
    if (Math.abs(ch) < 0.01) continue;
    depAddback += -ch;
  }
  depAddback = +depAddback.toFixed(2);
  if (Math.abs(depAddback) >= 0.01) operatingItems.push({ label: 'Depreciation & Amortization', amount: depAddback });

  for (const a of all) {
    const ch = change(a.id);
    if (Math.abs(ch) < 0.01) continue;
    if (isBank(a)) continue;
    if (a.type === 'income' || a.type === 'expense') continue;
    if (isLongTermAsset(a)) continue;
    if (isAccumDepreciation(a)) continue;
    if (isLongTermLiability(a)) continue;
    if (a.type === 'equity') continue;
    if (a.type === 'asset') operatingItems.push({ label: `Change in ${a.name}`, amount: -ch });
    else if (a.type === 'liability') operatingItems.push({ label: `Change in ${a.name}`, amount: ch });
  }
  const operatingTotal = +operatingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);

  // ---- Investing ----
  const investingItems = [];
  for (const a of all.filter(isLongTermAsset)) {
    const ch = change(a.id);
    if (Math.abs(ch) < 0.01) continue;
    investingItems.push({ label: `Purchase/sale of ${a.name}`, amount: -ch });
  }
  const investingTotal = +investingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);

  // ---- Financing ----
  const financingItems = [];
  for (const a of all.filter(x => x.type === 'equity')) {
    const ch = change(a.id);
    if (Math.abs(ch) < 0.01) continue;
    financingItems.push({ label: `Change in ${a.name}`, amount: ch });
  }
  for (const a of all.filter(isLongTermLiability)) {
    const ch = change(a.id);
    if (Math.abs(ch) < 0.01) continue;
    financingItems.push({ label: `Change in ${a.name}`, amount: ch });
  }
  const financingTotal = +financingItems.reduce((s, i) => s + i.amount, 0).toFixed(2);
  const netCashChange = +(operatingTotal + investingTotal + financingTotal).toFixed(2);

  const cashAccts = all.filter(isBank);
  const cashStart = +cashAccts.reduce((s, a) => s + (startBalances.get(a.id)?.balance || 0), 0).toFixed(2);
  const cashEnd = +cashAccts.reduce((s, a) => s + (endBalances.get(a.id)?.balance || 0), 0).toFixed(2);
  const reconciliationGap = +(cashEnd - cashStart - netCashChange).toFixed(2);

  return {
    operating: { items: operatingItems, total: operatingTotal },
    investing: { items: investingItems, total: investingTotal },
    financing: { items: financingItems, total: financingTotal },
    netCashChange, cashStart, cashEnd, reconciliationGap,
    reconciles: Math.abs(reconciliationGap) < 0.01,
    warnings,
    netIncome,
  };
}

// ============================================================================
// SCENARIOS
// ============================================================================
function reset() {
  db.exec('DELETE FROM journal_lines; DELETE FROM journal_entries;');
  entryCounter = 0;
}

function dump(label, cf) {
  console.log(`\n========== ${label} ==========`);
  console.log('Net Income:', cf.netIncome);
  console.log('OPERATING:');
  cf.operating.items.forEach(i => console.log(`  ${i.label.padEnd(40)} ${String(i.amount).padStart(10)}`));
  console.log(`  ${'Net Cash from Operating'.padEnd(40)} ${String(cf.operating.total).padStart(10)}`);
  console.log('INVESTING:');
  cf.investing.items.forEach(i => console.log(`  ${i.label.padEnd(40)} ${String(i.amount).padStart(10)}`));
  console.log(`  ${'Net Cash from Investing'.padEnd(40)} ${String(cf.investing.total).padStart(10)}`);
  console.log('FINANCING:');
  cf.financing.items.forEach(i => console.log(`  ${i.label.padEnd(40)} ${String(i.amount).padStart(10)}`));
  console.log(`  ${'Net Cash from Financing'.padEnd(40)} ${String(cf.financing.total).padStart(10)}`);
  console.log(`Net change in cash:  ${cf.netCashChange}`);
  console.log(`Cash start → end:    ${cf.cashStart}  →  ${cf.cashEnd}   (Δ = ${(cf.cashEnd - cf.cashStart).toFixed(2)})`);
  console.log(`Reconciliation gap:  ${cf.reconciliationGap}   →  ${cf.reconciles ? '✓ RECONCILES' : '❌ FAILS'}`);
}

function assertReconciles(label, cf) {
  if (cf.reconciles) {
    console.log(`✅ ${label}: gap = ${cf.reconciliationGap}`);
    return 0;
  } else {
    console.log(`❌ ${label}: gap = ${cf.reconciliationGap}  (expected 0)`);
    return 1;
  }
}

let failures = 0;

// ---------- Scenario 1: Clean Q1 ----------
{
  reset();
  // Opening balances: Bank 50000, AR 20000, Inv 15000, Equip 40000  = 125000
  //                   AP 8000, LTL 25000, Capital 50000, RE 42000   = 125000
  postJE('2025-12-31', 'Opening balances', [
    { acctId: codeToId['1000'], debit: 50000 },
    { acctId: codeToId['1100'], debit: 20000 },
    { acctId: codeToId['1200'], debit: 15000 },
    { acctId: codeToId['1500'], debit: 40000 },
    { acctId: codeToId['2000'], credit: 8000 },
    { acctId: codeToId['2700'], credit: 25000 },
    { acctId: codeToId['3000'], credit: 50000 },
    { acctId: codeToId['3100'], credit: 42000 },
  ]);
  // Q1 activity
  postJE('2026-01-15', 'Sales',          [{acctId: codeToId['1100'], debit: 30000}, {acctId: codeToId['4000'], credit: 30000}]);
  postJE('2026-01-20', 'Collections',    [{acctId: codeToId['1000'], debit: 25000}, {acctId: codeToId['1100'], credit: 25000}]);
  postJE('2026-02-01', 'COGS',           [{acctId: codeToId['5000'], debit: 12000}, {acctId: codeToId['1200'], credit: 12000}]);
  postJE('2026-02-15', 'OpEx cash',      [{acctId: codeToId['6000'], debit: 9500}, {acctId: codeToId['1000'], credit: 9500}]);
  postJE('2026-02-20', 'OpEx accrued',   [{acctId: codeToId['6000'], debit: 3000}, {acctId: codeToId['2000'], credit: 3000}]);
  postJE('2026-03-01', 'Loan principal', [{acctId: codeToId['2700'], debit: 3000}, {acctId: codeToId['1000'], credit: 3000}]);
  postJE('2026-03-10', 'Owner contrib',  [{acctId: codeToId['1000'], debit: 5000}, {acctId: codeToId['3000'], credit: 5000}]);
  postJE('2026-03-15', 'Buy equipment',  [{acctId: codeToId['1500'], debit: 15000}, {acctId: codeToId['1000'], credit: 15000}]);

  const cf = cashFlowStatement('2026-01-01', '2026-03-31');
  dump('Scenario 1 — CLEAN Q1', cf);
  failures += assertReconciles('Scenario 1 — Clean Q1', cf);
}

// ---------- Scenario 2: Year-end close inside the period ----------
{
  reset();
  // Set up books at Dec 30 2025: prior-year activity creating $20k of cumulative income still in Income account
  postJE('2024-01-01', 'Opening', [
    { acctId: codeToId['1000'], debit: 50000 },
    { acctId: codeToId['1100'], debit: 20000 },
    { acctId: codeToId['1200'], debit: 15000 },
    { acctId: codeToId['1500'], debit: 40000 },
    { acctId: codeToId['2000'], credit: 8000 },
    { acctId: codeToId['2700'], credit: 25000 },
    { acctId: codeToId['3000'], credit: 50000 },
    { acctId: codeToId['3100'], credit: 42000 },
  ]);
  // Pre-2026 (i.e. 2025) sales of 20k still sitting in Income account, balanced by AR... actually need to be careful.
  // Let's say prior year 2025: Sales $20k all collected in cash. So Bank +20k, Income +20k.
  // To keep books balanced in starting balances, increase Bank +20k and Income +20k.
  postJE('2025-06-15', 'Prior-year sale (collected)', [
    { acctId: codeToId['1000'], debit: 20000 },
    { acctId: codeToId['4000'], credit: 20000 },
  ]);
  // Year-end close on 2025-12-31 — closes the $20k income to RE
  postJE('2025-12-31', 'Year-end close 2025', [
    { acctId: codeToId['4000'], debit: 20000 },
    { acctId: codeToId['3100'], credit: 20000 },
  ]);
  // Q1 2026 activity (same as scenario 1)
  postJE('2026-01-15', 'Sales',          [{acctId: codeToId['1100'], debit: 30000}, {acctId: codeToId['4000'], credit: 30000}]);
  postJE('2026-01-20', 'Collections',    [{acctId: codeToId['1000'], debit: 25000}, {acctId: codeToId['1100'], credit: 25000}]);
  postJE('2026-02-01', 'COGS',           [{acctId: codeToId['5000'], debit: 12000}, {acctId: codeToId['1200'], credit: 12000}]);
  postJE('2026-02-15', 'OpEx cash',      [{acctId: codeToId['6000'], debit: 9500}, {acctId: codeToId['1000'], credit: 9500}]);
  postJE('2026-02-20', 'OpEx accrued',   [{acctId: codeToId['6000'], debit: 3000}, {acctId: codeToId['2000'], credit: 3000}]);
  postJE('2026-03-01', 'Loan principal', [{acctId: codeToId['2700'], debit: 3000}, {acctId: codeToId['1000'], credit: 3000}]);
  postJE('2026-03-10', 'Owner contrib',  [{acctId: codeToId['1000'], debit: 5000}, {acctId: codeToId['3000'], credit: 5000}]);
  postJE('2026-03-15', 'Buy equipment',  [{acctId: codeToId['1500'], debit: 15000}, {acctId: codeToId['1000'], credit: 15000}]);

  // Annual report covering the year-end close: Oct 1 2025 to Mar 31 2026 — STRADDLES year-end-close JE.
  const cf = cashFlowStatement('2025-10-01', '2026-03-31');
  dump('Scenario 2 — Year-end close INSIDE period', cf);
  failures += assertReconciles('Scenario 2 — Year-end close inside period', cf);
}

// ---------- Scenario 3: Intangible asset purchase ----------
{
  reset();
  postJE('2025-12-31', 'Opening', [
    { acctId: codeToId['1000'], debit: 100000 },
    { acctId: codeToId['3000'], credit: 100000 },
  ]);
  postJE('2026-02-01', 'Capitalize software', [
    { acctId: codeToId['1700'], debit: 30000 },
    { acctId: codeToId['1000'], credit: 30000 },
  ]);
  const cf = cashFlowStatement('2026-01-01', '2026-03-31');
  dump('Scenario 3 — Intangible purchase', cf);
  failures += assertReconciles('Scenario 3 — Intangible purchase', cf);
  // Sanity: should appear in Investing, not Operating
  const investingHasIt = cf.investing.items.some(i => i.label.includes('Capitalized Software'));
  if (!investingHasIt) { console.log('❌ Intangible purchase missing from Investing section'); failures++; }
  else console.log('✅ Intangible purchase appeared in Investing');
}

// ---------- Scenario 4: Depreciation entry ----------
{
  reset();
  postJE('2025-12-31', 'Opening', [
    { acctId: codeToId['1000'], debit: 100000 },
    { acctId: codeToId['1500'], debit: 60000 },
    { acctId: codeToId['1510'], credit: 0 },
    { acctId: codeToId['3000'], credit: 160000 },
  ]);
  // Depreciation: Dr Dep Exp 5000 / Cr Accum Dep 5000
  postJE('2026-02-15', 'Q1 depreciation', [
    { acctId: codeToId['6800'], debit: 5000 },
    { acctId: codeToId['1510'], credit: 5000 },
  ]);
  const cf = cashFlowStatement('2026-01-01', '2026-03-31');
  dump('Scenario 4 — Depreciation', cf);
  failures += assertReconciles('Scenario 4 — Depreciation', cf);
  const hasAddback = cf.operating.items.some(i => i.label === 'Depreciation & Amortization' && Math.abs(i.amount - 5000) < 0.01);
  if (!hasAddback) { console.log('❌ Depreciation add-back missing or wrong amount'); failures++; }
  else console.log('✅ Depreciation add-back of $5,000 in Operating');
}

// ---------- Scenario 5: Combined — all four bug triggers in one period ----------
{
  reset();
  postJE('2024-01-01', 'Opening', [
    { acctId: codeToId['1000'], debit: 50000 },
    { acctId: codeToId['1100'], debit: 20000 },
    { acctId: codeToId['1200'], debit: 15000 },
    { acctId: codeToId['1500'], debit: 40000 },
    { acctId: codeToId['1700'], debit: 0 },
    { acctId: codeToId['1510'], credit: 0 },
    { acctId: codeToId['2000'], credit: 8000 },
    { acctId: codeToId['2700'], credit: 25000 },
    { acctId: codeToId['3000'], credit: 50000 },
    { acctId: codeToId['3100'], credit: 42000 },
  ]);
  postJE('2025-06-15', 'Prior-year sale', [{ acctId: codeToId['1000'], debit: 20000 }, { acctId: codeToId['4000'], credit: 20000 }]);
  postJE('2025-12-31', 'Year-end close 2025', [{ acctId: codeToId['4000'], debit: 20000 }, { acctId: codeToId['3100'], credit: 20000 }]);
  // Q1 2026: sales, collections, depreciation, intangible purchase, equipment, loan, owner
  postJE('2026-01-15', 'Sales',           [{acctId: codeToId['1100'], debit: 30000}, {acctId: codeToId['4000'], credit: 30000}]);
  postJE('2026-01-20', 'Collections',     [{acctId: codeToId['1000'], debit: 25000}, {acctId: codeToId['1100'], credit: 25000}]);
  postJE('2026-02-01', 'COGS',            [{acctId: codeToId['5000'], debit: 12000}, {acctId: codeToId['1200'], credit: 12000}]);
  postJE('2026-02-10', 'OpEx cash',       [{acctId: codeToId['6000'], debit: 9500},  {acctId: codeToId['1000'], credit: 9500}]);
  postJE('2026-02-15', 'Depreciation',    [{acctId: codeToId['6800'], debit: 2000},  {acctId: codeToId['1510'], credit: 2000}]);
  postJE('2026-02-20', 'OpEx accrued',    [{acctId: codeToId['6000'], debit: 3000},  {acctId: codeToId['2000'], credit: 3000}]);
  postJE('2026-03-01', 'Buy software',    [{acctId: codeToId['1700'], debit: 8000},  {acctId: codeToId['1000'], credit: 8000}]);
  postJE('2026-03-05', 'Loan principal',  [{acctId: codeToId['2700'], debit: 3000},  {acctId: codeToId['1000'], credit: 3000}]);
  postJE('2026-03-10', 'Owner contrib',   [{acctId: codeToId['1000'], debit: 5000},  {acctId: codeToId['3000'], credit: 5000}]);
  postJE('2026-03-15', 'Buy equipment',   [{acctId: codeToId['1500'], debit: 15000}, {acctId: codeToId['1000'], credit: 15000}]);

  // Period: Oct 1 2025 — Mar 31 2026 (straddles year-end-close)
  const cf = cashFlowStatement('2025-10-01', '2026-03-31');
  dump('Scenario 5 — ALL FOUR bug triggers combined', cf);
  failures += assertReconciles('Scenario 5 — Combined', cf);
}

// ============================================================================
console.log(`\n========== SUMMARY ==========`);
if (failures === 0) console.log(`✅ ALL 5 SCENARIOS PASS — reconciliation gap is exactly 0.00 in every case`);
else console.log(`❌ ${failures} assertion(s) failed`);
process.exit(failures);
}  // end main

main().catch(e => { console.error(e); process.exit(1); });
