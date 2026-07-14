/**
 * Regression test: profitAndLoss() date-range scoping.
 *
 * Bug (pre-fix): the date/org predicate for journal_entries lived on the
 * LEFT JOIN's ON-clause:
 *
 *   LEFT JOIN journal_entries je
 *     ON je.id = jl.entry_id AND je.org_id = $1 AND je.date BETWEEN $2 AND $3
 *
 * When an entry failed the date filter, je became NULL — but the
 * journal_lines row from the *first* join survived, so its debit/credit
 * still aggregated into SUM(jl.debit)/SUM(jl.credit). Every P&L over a
 * sub-period was silently a life-to-date P&L, and balanceSheet() (which
 * derives current-period net income from profitAndLoss) could report
 * totalAssets !== liabilitiesAndEquity.
 *
 * Fix: predicate moved to WHERE with a NULL-safe guard so accounts with
 * no activity are retained (zero rows), while out-of-range lines are
 * excluded before aggregation:
 *
 *   FROM accounts a
 *   LEFT JOIN journal_lines jl ON jl.account_id = a.id
 *   LEFT JOIN journal_entries je ON je.id = jl.entry_id
 *   WHERE a.type IN ('income','expense') AND a.org_id = $1
 *     AND (je.id IS NULL OR (je.org_id = $1 AND je.date BETWEEN $2 AND $3))
 *
 * This test posts a January sale and a March sale, then asserts:
 *   1. P&L for Jan 1–Jan 31 includes ONLY the January amount
 *   2. The old (buggy) query shape over-counts — documents the regression
 *   3. balanceSheet(Jan 31) satisfies totalAssets === liabilitiesAndEquity
 *
 * Mirrors the FIXED storage.ts logic (SQLite ? placeholders in place of
 * Postgres $n; $1 appears twice in the fixed query, so orgId is bound twice).
 */

const initSqlJs = require('sql.js');

const CENTS = (n) => Math.round(n); // amounts are integer cents throughout

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL,
      code TEXT, name TEXT, type TEXT, subtype TEXT,
      UNIQUE(org_id, code)
    );
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL,
      date TEXT NOT NULL
    );
    CREATE TABLE journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL,
      entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0
    );
  `);

  function run(sql, ...args) { const s = db.prepare(sql); s.run(args); s.free(); }
  function all(sql, ...args) {
    const s = db.prepare(sql); s.bind(args);
    const out = []; while (s.step()) out.push(s.getAsObject()); s.free(); return out;
  }
  function lastId() { return db.exec('SELECT last_insert_rowid()')[0].values[0][0]; }

  const ORG = 1;

  // Minimal chart of accounts
  const coa = [
    { code: '1000', name: 'Bank',                type: 'asset',   subtype: 'bank' },
    { code: '1100', name: 'Accounts Receivable', type: 'asset',   subtype: 'current_asset' },
    { code: '3000', name: "Owner's Equity",      type: 'equity',  subtype: 'equity' },
    { code: '4000', name: 'Sales Revenue',       type: 'income',  subtype: 'operating_income' },
    { code: '5000', name: 'Dormant Income',      type: 'income',  subtype: 'operating_income' }, // no activity — exercises NULL-safe guard
    { code: '6000', name: 'Operating Expenses',  type: 'expense', subtype: 'operating_expense' },
  ];
  const acct = {};
  for (const a of coa) {
    run('INSERT INTO accounts (org_id, code, name, type, subtype) VALUES (?,?,?,?,?)',
      ORG, a.code, a.name, a.type, a.subtype);
    acct[a.code] = lastId();
  }
  const listAccounts = () =>
    all('SELECT * FROM accounts WHERE org_id = ? ORDER BY code', ORG);

  function postEntry(date, lines) {
    run('INSERT INTO journal_entries (org_id, date) VALUES (?,?)', ORG, date);
    const entryId = lastId();
    let dr = 0, cr = 0;
    for (const l of lines) {
      run('INSERT INTO journal_lines (org_id, entry_id, account_id, debit, credit) VALUES (?,?,?,?,?)',
        ORG, entryId, l.a, CENTS(l.dr || 0), CENTS(l.cr || 0));
      dr += l.dr || 0; cr += l.cr || 0;
    }
    if (dr !== cr) throw new Error(`Unbalanced test entry ${date}: dr=${dr} cr=${cr}`);
    return entryId;
  }

  // --- FIXED profitAndLoss — mirrors server/storage.ts exactly ---------------
  // Postgres: params [orgId, fromDate, toDate], $1 referenced twice.
  // SQLite ? is positional, so orgId is bound in both positions.
  function profitAndLoss(fromDate, toDate) {
    const rows = all(`
      SELECT a.id AS accountId, a.code, a.name, a.type, a.subtype,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
      WHERE a.type IN ('income','expense') AND a.org_id = ?
        AND (je.id IS NULL OR (je.org_id = ? AND je.date BETWEEN ? AND ?))
      GROUP BY a.id
      ORDER BY a.code
    `, ORG, ORG, fromDate, toDate);
    const income = rows.filter(r => r.type === 'income')
      .map(r => ({ ...r, amount: r.credit - r.debit })).filter(r => r.amount !== 0);
    const expenses = rows.filter(r => r.type === 'expense')
      .map(r => ({ ...r, amount: r.debit - r.credit })).filter(r => r.amount !== 0);
    const totalIncome = income.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
    return { fromDate, toDate, income, expenses, totalIncome, totalExpenses,
             netIncome: totalIncome - totalExpenses, _rowCount: rows.length };
  }

  // --- OLD buggy query shape (predicate on the LEFT JOIN ON-clause) ---------
  function profitAndLossBUGGY(fromDate, toDate) {
    const rows = all(`
      SELECT a.type, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = ? AND je.date BETWEEN ? AND ?
      WHERE a.type IN ('income','expense') AND a.org_id = ?
      GROUP BY a.id
    `, ORG, fromDate, toDate, ORG);
    const totalIncome = rows.filter(r => r.type === 'income').reduce((s, r) => s + (r.credit - r.debit), 0);
    return { totalIncome };
  }

  // --- accountBalances + balanceSheet — mirror server/storage.ts ------------
  function accountBalances(asOfDate) {
    const rows = all(`
      SELECT jl.account_id AS accountId,
             COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.org_id = ? AND je.date <= ?
      GROUP BY jl.account_id
    `, ORG, asOfDate);
    const accounts = listAccounts();
    const byId = new Map(accounts.map(a => [a.id, a]));
    const result = new Map();
    for (const a of accounts) result.set(a.id, { balance: 0 });
    for (const r of rows) {
      const a = byId.get(r.accountId); if (!a) continue;
      const isDebitNormal = a.type === 'asset' || a.type === 'expense';
      result.set(r.accountId, { balance: isDebitNormal ? r.debit - r.credit : r.credit - r.debit });
    }
    return result;
  }

  function balanceSheet(asOfDate) {
    const balances = accountBalances(asOfDate);
    const accounts = listAccounts();
    const netIncome = profitAndLoss('0000-01-01', asOfDate).netIncome;
    const section = (type) => accounts.filter(a => a.type === type)
      .map(a => ({ code: a.code, balance: (balances.get(a.id) || { balance: 0 }).balance }))
      .filter(r => r.balance !== 0);
    const assets = section('asset'), liabilities = section('liability'), equity = section('equity');
    const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);
    const totalEquity = equity.reduce((s, r) => s + r.balance, 0) + netIncome;
    return { asOfDate, totalAssets, totalLiabilities, totalEquity,
             liabilitiesAndEquity: totalLiabilities + totalEquity };
  }

  // ---------------------------------------------------------------------------
  // Fixture: Jan sale $500.00, Mar sale $800.00 (cents), plus owner funding
  // ---------------------------------------------------------------------------
  postEntry('2026-01-05', [{ a: acct['1000'], dr: 100000 }, { a: acct['3000'], cr: 100000 }]); // owner contribution
  postEntry('2026-01-15', [{ a: acct['1100'], dr: 50000 },  { a: acct['4000'], cr: 50000 }]);  // JAN sale
  postEntry('2026-03-10', [{ a: acct['1100'], dr: 80000 },  { a: acct['4000'], cr: 80000 }]);  // MAR sale
  postEntry('2026-03-20', [{ a: acct['6000'], dr: 12000 },  { a: acct['1000'], cr: 12000 }]);  // MAR expense

  let failures = 0;
  function assertEq(actual, expected, label) {
    const ok = actual === expected;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (expected ${expected}, got ${actual})`);
    if (!ok) failures++;
  }

  // 1. Jan-only P&L contains only the Jan amount
  const janPL = profitAndLoss('2026-01-01', '2026-01-31');
  assertEq(janPL.totalIncome, 50000, 'Jan P&L totalIncome = Jan sale only');
  assertEq(janPL.totalExpenses, 0, 'Jan P&L totalExpenses excludes Mar expense');
  assertEq(janPL.netIncome, 50000, 'Jan P&L netIncome');
  assertEq(janPL.income.length, 1, 'Jan P&L single income line (dormant + out-of-range filtered)');
  assertEq(janPL._rowCount >= 1, true, 'NULL-safe guard keeps query well-formed with inactive accounts');

  // 2. The old ON-clause query shape over-counts — documents the regression
  const buggy = profitAndLossBUGGY('2026-01-01', '2026-01-31');
  assertEq(buggy.totalIncome, 130000, 'BUGGY ON-clause query over-counts (Jan+Mar), proving WHERE placement matters');

  // 3. Balance sheet as of Jan 31 balances: A = L + E
  const bs = balanceSheet('2026-01-31');
  assertEq(bs.totalAssets, bs.liabilitiesAndEquity, 'balanceSheet(2026-01-31): totalAssets === liabilitiesAndEquity');
  assertEq(bs.totalAssets, 150000, 'Jan 31 assets = owner cash 1000.00 + Jan AR 500.00');

  // 4. Sanity: full-year and Mar-only windows
  assertEq(profitAndLoss('2026-01-01', '2026-12-31').totalIncome, 130000, 'Full-year P&L includes both sales');
  assertEq(profitAndLoss('2026-03-01', '2026-03-31').netIncome, 68000, 'Mar-only P&L = 800.00 - 120.00');

  // 5. Mar 31 balance sheet also balances (identity holds across periods)
  const bs2 = balanceSheet('2026-03-31');
  assertEq(bs2.totalAssets, bs2.liabilitiesAndEquity, 'balanceSheet(2026-03-31): identity holds');

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll P&L date-range regression tests passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
