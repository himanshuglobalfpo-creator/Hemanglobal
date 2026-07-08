#!/usr/bin/env python3
"""CPA accounting validation suite (Phase 4 audit artifact).

Usage:
  rm -rf data && PORT=3150 VAULT_KEY=any npx tsx server/index.ts &   # fresh server
  python3 scripts/cpa-validation.py                                   # 53 assertions

Drives the API, then independently verifies every posting at the
journal-line level with direct SQL against the database. Reports are
reconciled against raw ledger recomputations, never against themselves.
"""
import json, urllib.request, http.cookiejar, sqlite3, sys

B = "http://localhost:3150"
DB = "data/ledgerlite.db"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
results = []

def req(method, path, data=None, ctype="application/json"):
    body = (json.dumps(data).encode() if ctype == "application/json" else data.encode()) if data is not None else None
    r = urllib.request.Request(B + path, data=body, headers={"Content-Type": ctype} if body else {}, method=method)
    try:
        resp = op.open(r); return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw
    except Exception as e:
        return 0, str(e)

def rec(section, name, ok, detail=""):
    results.append((section, name, ok, detail))

def sql(q, *args):
    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(q, args).fetchall()]
    con.close(); return rows

def je_lines(source, source_id):
    return sql("""SELECT a.code, a.name, jl.debit, jl.credit
                  FROM journal_entries je
                  JOIN journal_lines jl ON jl.entry_id = je.id
                  JOIN accounts a ON a.id = jl.account_id
                  WHERE je.source = ? AND je.source_id = ? ORDER BY je.id, jl.id""", source, source_id)

def tb_balanced(label):
    r = sql("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE org_id = ?", ORG)[0]
    rec("Trial Balance", f"balances after {label}", r["d"] == r["c"], f"DR {r['d']} CR {r['c']}")

# ---------------- setup ----------------
req("POST", "/api/auth/register", {"email":"cpa@audit.test","password":"password123","name":"CPA","orgName":"CPA Audit Co","baseCurrency":"USD"})
_, me = req("GET", "/api/auth/me"); ORG = me["orgId"]
_, accts = req("GET", "/api/accounts")
A = {a["code"]: a["id"] for a in accts}
_, cust = req("POST", "/api/customers", {"name":"Client One"})
_, ven = req("POST", "/api/vendors", {"name":"Vendor One"})
CUST, VEN = cust["id"], ven["id"]

# ============ 1. INVOICE POSTING ============
# $200 revenue + 10% tax = $220 total
_, inv = req("POST", "/api/invoices", {"customerId":CUST,"date":"2026-03-01","dueDate":"2026-04-01",
    "lines":[{"description":"Service","quantity":2,"rate":10000,"accountId":A["4000"],"taxRate":10}]})
lines = je_lines("invoice", inv["id"])
by = {(l["code"]): (l["debit"], l["credit"]) for l in lines}
rec("Invoice", "DR Accounts Receivable 1100 = total", by.get("1100") == (22000, 0), str(by.get("1100")))
rec("Invoice", "CR Revenue 4000 = subtotal", by.get("4000") == (0, 20000), str(by.get("4000")))
rec("Invoice", "CR Sales Tax Payable 2100 = tax", by.get("2100") == (0, 2000), str(by.get("2100")))
rec("Invoice", "exactly 3 lines, no strays", len(lines) == 3)
tb_balanced("invoice")

# ============ 2. PAYMENT POSTING ============
req("POST", f"/api/invoices/{inv['id']}/pay", {"date":"2026-03-10","amount":22000,"bankAccountId":A["1000"]})
lines = je_lines("invoice_payment", inv["id"])
by = {l["code"]: (l["debit"], l["credit"]) for l in lines}
rec("Payment", "DR Bank 1000", by.get("1000") == (22000, 0), str(by.get("1000")))
rec("Payment", "CR Accounts Receivable 1100", by.get("1100") == (0, 22000), str(by.get("1100")))
rec("Payment", "exactly 2 lines", len(lines) == 2)
tb_balanced("payment")

# ============ 3. VENDOR BILL POSTING ============
_, bill = req("POST", "/api/bills", {"vendorId":VEN,"date":"2026-03-05","dueDate":"2026-04-05",
    "lines":[{"description":"Rent","quantity":1,"rate":50000,"accountId":A["6000"],"taxRate":0}]})
lines = je_lines("bill", bill["id"])
by = {l["code"]: (l["debit"], l["credit"]) for l in lines}
rec("Vendor Bill", "DR Expense 6000", by.get("6000") == (50000, 0), str(by.get("6000")))
rec("Vendor Bill", "CR Accounts Payable 2000", by.get("2000") == (0, 50000), str(by.get("2000")))
tb_balanced("bill")

# ============ 4. BILL PAYMENT POSTING ============
req("POST", f"/api/bills/{bill['id']}/pay", {"date":"2026-03-15","amount":50000,"bankAccountId":A["1000"]})
lines = je_lines("bill_payment", bill["id"])
by = {l["code"]: (l["debit"], l["credit"]) for l in lines}
rec("Bill Payment", "DR Accounts Payable 2000", by.get("2000") == (50000, 0), str(by.get("2000")))
rec("Bill Payment", "CR Bank 1000", by.get("1000") == (0, 50000), str(by.get("1000")))
tb_balanced("bill payment")

# ============ 5. MANUAL JOURNAL VALIDATION ============
c, _ = req("POST", "/api/journal-entries", {"date":"2026-03-20","memo":"capital",
    "lines":[{"accountId":A["1000"],"debit":100000,"credit":0},{"accountId":A["3000"],"debit":0,"credit":100000}]})
rec("Manual Journal", "balanced journal accepted", c == 201)
c, e = req("POST", "/api/journal-entries", {"date":"2026-03-20","memo":"unbal",
    "lines":[{"accountId":A["1000"],"debit":100,"credit":0},{"accountId":A["3000"],"debit":0,"credit":99}]})
rec("Manual Journal", "unbalanced rejected", c == 400, str(e)[:70])
c, _ = req("POST", "/api/journal-entries", {"date":"2026-03-20","memo":"one line",
    "lines":[{"accountId":A["1000"],"debit":100,"credit":0}]})
rec("Manual Journal", "single-line rejected", c == 400)
c, _ = req("POST", "/api/journal-entries", {"date":"2026-03-20","memo":"both sides",
    "lines":[{"accountId":A["1000"],"debit":100,"credit":100},{"accountId":A["3000"],"debit":100,"credit":100}]})
rec("Manual Journal", "debit+credit on same line rejected", c == 400)
c, _ = req("POST", "/api/journal-entries", {"date":"2026-03-20","memo":"negative",
    "lines":[{"accountId":A["1000"],"debit":-100,"credit":0},{"accountId":A["3000"],"debit":0,"credit":-100}]})
rec("Manual Journal", "negative amounts rejected", c == 400)
tb_balanced("manual journal")

# ============ 6. FX REALIZED GAIN/LOSS POSTING (CPA check) ============
_, ecust = req("POST", "/api/customers", {"name":"Euro Kunde","currency":"EUR"})
_, einv = req("POST", "/api/invoices", {"customerId":ecust["id"],"date":"2026-03-02","dueDate":"2026-04-02",
    "currency":"EUR","fxRate":1.10,"lines":[{"description":"Export","quantity":1,"rate":10000,"accountId":A["4000"],"taxRate":0}]})
lines = je_lines("invoice", einv["id"])
by = {l["code"]: (l["debit"], l["credit"]) for l in lines}
rec("FX", "EUR invoice books BASE cents: DR A/R $110.00", by.get("1100") == (11000, 0), str(by.get("1100")))
req("POST", f"/api/invoices/{einv['id']}/pay", {"date":"2026-03-25","foreignAmount":10000,"fxRate":1.08,"bankAccountId":A["1000"]})
lines = je_lines("invoice_payment", einv["id"])
by = {l["code"]: (l["debit"], l["credit"]) for l in lines}
rec("FX", "payment: DR Bank $108 (payment rate)", by.get("1000") == (10800, 0), str(by.get("1000")))
rec("FX", "payment: CR A/R $110 (document rate)", by.get("1100") == (0, 11000), str(by.get("1100")))
rec("FX", "payment: DR FX Loss 6950 $2.00 balances the entry", by.get("6950") == (200, 0), str(by.get("6950")))
tb_balanced("FX payment")

# ============ 7. VOID REVERSAL NETS TO ZERO ============
_, vinv = req("POST", "/api/invoices", {"customerId":CUST,"date":"2026-03-06","dueDate":"2026-04-06",
    "lines":[{"description":"Voidable","quantity":1,"rate":7700,"accountId":A["4000"],"taxRate":0}]})
req("POST", f"/api/invoices/{vinv['id']}/void", {})
net = sql("""SELECT COALESCE(SUM(jl.debit - jl.credit),0) net FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id
             WHERE je.source IN ('invoice','invoice_void') AND je.source_id = ?""", vinv["id"])[0]["net"]
per_acct = sql("""SELECT a.code, SUM(jl.debit - jl.credit) n FROM journal_lines jl
                  JOIN journal_entries je ON je.id = jl.entry_id
                  JOIN accounts a ON a.id = jl.account_id
                  WHERE je.source IN ('invoice','invoice_void') AND je.source_id = ?
                  GROUP BY a.code HAVING n != 0""", vinv["id"])
rec("Void", "void + original net to zero on EVERY account", net == 0 and len(per_acct) == 0)

# ============ 8. REPORTS vs RAW LEDGER ============
# Trial balance report vs raw
_, tb = req("GET", "/api/reports/trial-balance")
tb_dr, tb_cr = sum(r["debit"] for r in tb), sum(r["credit"] for r in tb)
rec("Reports", "Trial Balance report balances", tb_dr == tb_cr, f"{tb_dr} == {tb_cr}")

# raw ledger per-account nets
raw = {r["code"]: r["n"] for r in sql("""SELECT a.code, COALESCE(SUM(jl.debit - jl.credit),0) n
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id WHERE a.org_id = ? GROUP BY a.code""", ORG)}
tb_map = {r["code"]: r["debit"] - r["credit"] for r in tb}
mismatch = [c for c in raw if raw[c] != tb_map.get(c, 0)]
rec("Reports", "Trial Balance ties to raw journal_lines per account", not mismatch, str(mismatch))

# Balance sheet: A = L + E and ties to raw ledger
_, bs = req("GET", "/api/reports/balance-sheet")
rec("Reports", "Assets = Liabilities + Equity", bs["balanced"],
    f"A {bs['assets']['total']} = L {bs['liabilities']['total']} + E {bs['equity']['total']}")
types = {r["code"]: r["type"] for r in sql("SELECT code, type FROM accounts WHERE org_id = ?", ORG)}
raw_assets = sum(n for c, n in raw.items() if types[c] == "asset")
raw_liab = sum(-n for c, n in raw.items() if types[c] == "liability")
raw_eq_accts = sum(-n for c, n in raw.items() if types[c] == "equity")
raw_earn = sum(-n for c, n in raw.items() if types[c] == "income") - sum(n for c, n in raw.items() if types[c] == "expense")
rec("Reports", "Balance Sheet assets tie to ledger", bs["assets"]["total"] == raw_assets, f"{bs['assets']['total']} vs {raw_assets}")
rec("Reports", "Balance Sheet liabilities tie to ledger", bs["liabilities"]["total"] == raw_liab)
rec("Reports", "Balance Sheet equity (incl. earnings) ties to ledger", bs["equity"]["total"] == raw_eq_accts + raw_earn)

# P&L vs raw ledger
_, pl = req("GET", "/api/reports/profit-loss-monthly?from=2026-01-01&to=2026-12-31")
pl_income = sum(v for r in pl["rows"] if r["type"] == "income" for v in r["amounts"].values())
pl_expense = sum(v for r in pl["rows"] if r["type"] == "expense" for v in r["amounts"].values())
raw_income = sum(-n for c, n in raw.items() if types[c] == "income")
raw_expense = sum(n for c, n in raw.items() if types[c] == "expense")
rec("Reports", "P&L income ties to ledger", pl_income == raw_income, f"{pl_income} vs {raw_income}")
rec("Reports", "P&L expense ties to ledger", pl_expense == raw_expense, f"{pl_expense} vs {raw_expense}")
rec("Reports", "P&L net == Balance Sheet current earnings",
    (pl_income - pl_expense) == next((r["amount"] for r in bs["equity"]["rows"] if r["name"] == "Current earnings"), 0))

# Cash flow vs raw bank ledger
_, cf = req("GET", "/api/reports/cash-flow?from=2026-01-01&to=2026-12-31")
bank_raw = sql("""SELECT COALESCE(SUM(jl.debit),0) i, COALESCE(SUM(jl.credit),0) o FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.org_id = ? AND a.subtype='bank' AND je.date BETWEEN '2026-01-01' AND '2026-12-31'""", ORG)[0]
rec("Reports", "Cash Flow receipts tie to bank debits", cf["receipts"] == bank_raw["i"], f"{cf['receipts']} vs {bank_raw['i']}")
rec("Reports", "Cash Flow payments tie to bank credits", cf["payments"] == bank_raw["o"])
rec("Reports", "Cash Flow closing == opening + net", cf["closingCash"] == cf["openingCash"] + cf["netChange"])
rec("Reports", "Cash Flow closing == bank balance in TB", cf["closingCash"] == sum(n for c, n in raw.items() if types[c]=="asset" and c in ("1000",)))

# General ledger vs raw
_, gl = req("GET", f"/api/reports/general-ledger?accountId={A['1000']}")
gl_sum = gl["openingBalance"] + sum(l["debit"] - l["credit"] for l in gl["lines"])
rec("Reports", "GL closing = opening + sum of movements", gl["closingBalance"] == gl_sum)
rec("Reports", "GL closing ties to raw ledger", gl["closingBalance"] == raw["1000"], f"{gl['closingBalance']} vs {raw['1000']}")
rec("Reports", "GL running balance monotone-consistent",
    all(gl["lines"][i]["balance"] == (gl["openingBalance"] if i == 0 else gl["lines"][i-1]["balance"]) + gl["lines"][i]["debit"] - gl["lines"][i]["credit"] for i in range(len(gl["lines"]))))

# ============ 9. CUSTOMER / VENDOR BALANCES ============
# Add an open invoice + credit note so balances are non-trivial
_, open_inv = req("POST", "/api/invoices", {"customerId":CUST,"date":"2026-03-08","dueDate":"2026-04-08",
    "lines":[{"description":"Open work","quantity":1,"rate":30000,"accountId":A["4000"],"taxRate":0}]})
req("POST", "/api/credit-notes", {"customerId":CUST,"invoiceId":open_inv["id"],"date":"2026-03-09",
    "lines":[{"description":"Adjustment","quantity":1,"rate":5000,"accountId":A["4000"],"taxRate":0}]})
_, sbc = req("GET", "/api/reports/sales-by-customer?from=2026-01-01&to=2026-12-31")
c1 = next(r for r in sbc if r["customer"] == "Client One")
# Client One: invoiced 22000 + 30000 (void excluded), credited 5000, paid 22000 → balance 25000
rec("Customer Balances", "invoiced excludes voided invoices", c1["invoiced"] == 52000, str(c1["invoiced"]))
rec("Customer Balances", "credited reflects credit notes", c1["credited"] == 5000)
rec("Customer Balances", "balance = invoiced - credited - paid", c1["balance"] == 52000 - 5000 - 22000, str(c1["balance"]))
# Sum of all customer balances must equal the A/R control account
total_cust_balance = sum(r["balance"] for r in sbc)
rec("Customer Balances", "Σ customer balances == A/R control account 1100", total_cust_balance == raw_after_ar if False else total_cust_balance == sql(
    """SELECT COALESCE(SUM(jl.debit - jl.credit),0) n FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE a.org_id = ? AND a.code = '1100'""", ORG)[0]["n"],
    f"customers {total_cust_balance}")

# Vendor balances: open bill
_, open_bill = req("POST", "/api/bills", {"vendorId":VEN,"date":"2026-03-12","dueDate":"2026-04-12",
    "lines":[{"description":"Open expense","quantity":1,"rate":12000,"accountId":A["6000"],"taxRate":0}]})
_, ebv = req("GET", "/api/reports/expenses-by-vendor?from=2026-01-01&to=2026-12-31")
v1 = next(r for r in ebv if r["vendor"] == "Vendor One")
rec("Vendor Balances", "billed / paid / balance correct", v1["billed"] == 62000 and v1["paid"] == 50000 and v1["balance"] == 12000, str(v1))
total_vendor_balance = sum(r["balance"] for r in ebv)
ap_control = -sql("""SELECT COALESCE(SUM(jl.debit - jl.credit),0) n FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id WHERE a.org_id = ? AND a.code = '2000'""", ORG)[0]["n"]
rec("Vendor Balances", "Σ vendor balances == A/P control account 2000", total_vendor_balance == ap_control,
    f"vendors {total_vendor_balance} vs A/P {ap_control}")

# AR aging total must tie to open customer balances (base cents)
_, ar = req("GET", "/api/reports/ar-aging?asOf=2026-12-31")
rec("Customer Balances", "AR aging total == open invoice outstanding", sum(r["total"] for r in ar) ==
    sql("SELECT COALESCE(SUM(total - amount_paid),0) n FROM invoices WHERE org_id=? AND status IN ('open','partial')", ORG)[0]["n"])
_, ap = req("GET", "/api/reports/ap-aging?asOf=2026-12-31")
rec("Vendor Balances", "AP aging total == open bill outstanding", sum(r["total"] for r in ap) ==
    sql("SELECT COALESCE(SUM(total - amount_paid),0) n FROM bills WHERE org_id=? AND status IN ('open','partial')", ORG)[0]["n"])

# Final global integrity
tb_balanced("ALL activity")
alljes = sql("""SELECT je.id, SUM(jl.debit) d, SUM(jl.credit) c FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id WHERE je.org_id = ? GROUP BY je.id HAVING d != c""", ORG)
rec("Trial Balance", "EVERY individual journal entry is internally balanced", len(alljes) == 0, f"{len(alljes)} unbalanced")

# ---------------- report ----------------
fails = 0; cur = None
for s, n, ok, d in results:
    if s != cur: print(f"\n== {s} =="); cur = s
    print(f"  {'✅ PASS' if ok else '❌ FAIL'}  {n}" + (f"  [{d}]" if d and not ok else (f"  [{d}]" if d and ok and ('==' in d or 'DR' in d or 'vs' in d or '$' in d) else "")))
    if not ok: fails += 1
print(f"\nCPA VALIDATION: {len(results)-fails}/{len(results)} PASS" + ("" if not fails else f" — {fails} FAILURES"))
sys.exit(1 if fails else 0)
