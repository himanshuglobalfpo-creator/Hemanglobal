import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Account } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtMoney, fmtDate, todayISO, startOfYearISO } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";

// ────────────────────────────────────────────────────────────────────────────
// Dimension (class/location/project) filtering — shared by P&L and Balance Sheet
// ────────────────────────────────────────────────────────────────────────────
type Dim = { id: number; name: string; isActive: boolean };

function useDimensionOptions() {
  const { data: classes = [] } = useQuery<Dim[]>({ queryKey: ["/api/classes"] });
  const { data: locations = [] } = useQuery<Dim[]>({ queryKey: ["/api/locations"] });
  const { data: projects = [] } = useQuery<Dim[]>({ queryKey: ["/api/projects"] });
  return { classes, locations, projects };
}

function DimensionSelect({ label, items, value, onChange, testid }: {
  label: string; items: Dim[]; value?: number; onChange: (v?: number) => void; testid: string;
}) {
  // Hidden entirely when the org uses no dimensions of this kind — keeps the
  // report toolbar clean for the common case.
  if (items.length === 0) return null;
  return (
    <div>
      <Label>{label}</Label>
      <select
        className="flex h-9 w-40 rounded-md border border-input bg-background px-2 text-sm"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        data-testid={testid}
      >
        <option value="">All</option>
        {items.filter((i) => i.isActive || i.id === value).map((i) => (
          <option key={i.id} value={i.id}>{i.name}</option>
        ))}
      </select>
    </div>
  );
}

function dimQuery(classId?: number, locationId?: number, projectId?: number): string {
  return `${classId ? `&classId=${classId}` : ""}${locationId ? `&locationId=${locationId}` : ""}${projectId ? `&projectId=${projectId}` : ""}`;
}

export default function Reports() {
  return (
    <Layout>
      <PageHeader title="Reports" description="Standard financial statements & detail reports" />
      <Tabs defaultValue="pl">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="pl" data-testid="tab-pl">Profit & Loss</TabsTrigger>
          <TabsTrigger value="ppl" data-testid="tab-ppl">P&L by Project</TabsTrigger>
          <TabsTrigger value="bs" data-testid="tab-bs">Balance Sheet</TabsTrigger>
          <TabsTrigger value="cf" data-testid="tab-cf">Cash Flow</TabsTrigger>
          <TabsTrigger value="tb" data-testid="tab-tb">Trial Balance</TabsTrigger>
          <TabsTrigger value="gl" data-testid="tab-gl">General Ledger</TabsTrigger>
          <TabsTrigger value="ar" data-testid="tab-ar">A/R Aging</TabsTrigger>
          <TabsTrigger value="ap" data-testid="tab-ap">A/P Aging</TabsTrigger>
          <TabsTrigger value="inv" data-testid="tab-inv">Inventory</TabsTrigger>
        </TabsList>
        <TabsContent value="pl" className="mt-4"><ProfitLoss /></TabsContent>
        <TabsContent value="ppl" className="mt-4"><ProjectPL /></TabsContent>
        <TabsContent value="bs" className="mt-4"><BalanceSheet /></TabsContent>
        <TabsContent value="cf" className="mt-4"><CashFlow /></TabsContent>
        <TabsContent value="tb" className="mt-4"><TrialBalance /></TabsContent>
        <TabsContent value="gl" className="mt-4"><GeneralLedger /></TabsContent>
        <TabsContent value="ar" className="mt-4"><ARAging /></TabsContent>
        <TabsContent value="ap" className="mt-4"><APAging /></TabsContent>
        <TabsContent value="inv" className="mt-4"><InventoryReport /></TabsContent>
      </Tabs>
    </Layout>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Profit & Loss
// ────────────────────────────────────────────────────────────────────────────
function ProfitLoss() {
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());
  const { classes, locations, projects } = useDimensionOptions();
  const [classId, setClassId] = useState<number | undefined>();
  const [locationId, setLocationId] = useState<number | undefined>();
  const [projectId, setProjectId] = useState<number | undefined>();
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/profit-loss", from, to, classId, locationId, projectId],
    queryFn: async () => (await apiRequest("GET", `/api/reports/profit-loss?from=${from}&to=${to}${dimQuery(classId, locationId, projectId)}`)).json(),
  });

  if (!data) return <Loader />;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div><Label>From</Label><Input type="date" data-testid="input-pl-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-pl-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <DimensionSelect label="Class" items={classes} value={classId} onChange={setClassId} testid="select-pl-class" />
          <DimensionSelect label="Location" items={locations} value={locationId} onChange={setLocationId} testid="select-pl-location" />
          <DimensionSelect label="Project" items={projects} value={projectId} onChange={setProjectId} testid="select-pl-project" />
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">Profit & Loss</h2>
          <p className="text-xs text-muted-foreground">{fmtDate(from)} — {fmtDate(to)}</p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-border"><td colSpan={2} className="px-3 py-2 font-semibold uppercase tracking-wide text-xs text-muted-foreground">Income</td></tr>
            {data.income.map((r: any) => (
              <tr key={r.accountId} className="border-b border-border/40"><td className="px-3 py-1.5 pl-6">{r.code} {r.name}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.amount)}</td></tr>
            ))}
            <tr className="border-b border-border bg-muted/30 font-medium"><td className="px-3 py-2">Total Income</td><td className="px-3 py-2 text-right tabular-nums" data-testid="text-pl-total-income">{fmtMoney(data.totalIncome)}</td></tr>
            <tr><td colSpan={2} className="h-3"></td></tr>
            <tr className="border-b border-border"><td colSpan={2} className="px-3 py-2 font-semibold uppercase tracking-wide text-xs text-muted-foreground">Expenses</td></tr>
            {data.expenses.map((r: any) => (
              <tr key={r.accountId} className="border-b border-border/40"><td className="px-3 py-1.5 pl-6">{r.code} {r.name}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.amount)}</td></tr>
            ))}
            <tr className="border-b border-border bg-muted/30 font-medium"><td className="px-3 py-2">Total Expenses</td><td className="px-3 py-2 text-right tabular-nums" data-testid="text-pl-total-expenses">{fmtMoney(data.totalExpenses)}</td></tr>
            <tr><td colSpan={2} className="h-3"></td></tr>
            <tr className="border-t-2 border-foreground font-semibold"><td className="px-3 py-3">Net Income</td><td className={`px-3 py-3 text-right tabular-nums ${data.netIncome >= 0 ? "text-primary" : "text-destructive"}`} data-testid="text-pl-net-income">{fmtMoney(data.netIncome)}</td></tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Profit & Loss BY PROJECT (per-job rollup)
// ────────────────────────────────────────────────────────────────────────────
function ProjectPL() {
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/project-pl", from, to],
    queryFn: async () => (await apiRequest("GET", `/api/reports/project-pl?from=${from}&to=${to}`)).json(),
  });
  if (!data) return <Loader />;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div><Label>From</Label><Input type="date" data-testid="input-ppl-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-ppl-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">Profit &amp; Loss by Project</h2>
          <p className="text-xs text-muted-foreground">{fmtDate(from)} — {fmtDate(to)}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left">Project</th>
                <th className="px-3 py-2 text-right">Income</th>
                <th className="px-3 py-2 text-right">Expenses</th>
                <th className="px-3 py-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No project activity in this range.</td></tr>
              )}
              {data.rows.map((r: any) => (
                <tr key={r.projectId ?? "unassigned"} className="border-b border-border/40" data-testid={`row-project-${r.projectId ?? "unassigned"}`}>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.income)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.expenses)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.net >= 0 ? "text-primary" : "text-destructive"}`}>{fmtMoney(r.net)}</td>
                </tr>
              ))}
              {data.rows.length > 0 && (
                <tr className="border-t-2 border-foreground font-semibold">
                  <td className="px-3 py-3">Total</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totalIncome)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totalExpenses)}</td>
                  <td className={`px-3 py-3 text-right tabular-nums ${data.netIncome >= 0 ? "text-primary" : "text-destructive"}`} data-testid="text-ppl-net">{fmtMoney(data.netIncome)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Balance Sheet
// ────────────────────────────────────────────────────────────────────────────
function BalanceSheet() {
  const [asOf, setAsOf] = useState(todayISO());
  const { classes, locations, projects } = useDimensionOptions();
  const [classId, setClassId] = useState<number | undefined>();
  const [locationId, setLocationId] = useState<number | undefined>();
  const [projectId, setProjectId] = useState<number | undefined>();
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/balance-sheet", asOf, classId, locationId, projectId],
    queryFn: async () => (await apiRequest("GET", `/api/reports/balance-sheet?asOf=${asOf}${dimQuery(classId, locationId, projectId)}`)).json(),
  });
  if (!data) return <Loader />;

  const Section = ({ title, rows, total, totalLabel }: { title: string; rows: any[]; total: number; totalLabel: string }) => (
    <>
      <tr className="border-b border-border"><td colSpan={2} className="px-3 py-2 font-semibold uppercase tracking-wide text-xs text-muted-foreground">{title}</td></tr>
      {rows.map((r: any) => (
        <tr key={`${title}-${r.accountId}`} className="border-b border-border/40"><td className="px-3 py-1.5 pl-6">{r.code} {r.name}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.balance)}</td></tr>
      ))}
      <tr className="border-b border-border bg-muted/30 font-medium"><td className="px-3 py-2">{totalLabel}</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(total)}</td></tr>
      <tr><td colSpan={2} className="h-3"></td></tr>
    </>
  );

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div><Label>As of</Label><Input type="date" data-testid="input-bs-asof" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
          <DimensionSelect label="Class" items={classes} value={classId} onChange={setClassId} testid="select-bs-class" />
          <DimensionSelect label="Location" items={locations} value={locationId} onChange={setLocationId} testid="select-bs-location" />
          <DimensionSelect label="Project" items={projects} value={projectId} onChange={setProjectId} testid="select-bs-project" />
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">Balance Sheet</h2>
          <p className="text-xs text-muted-foreground">As of {fmtDate(asOf)}</p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            <Section title="Assets" rows={data.assets} total={data.totalAssets} totalLabel="Total Assets" />
            <Section title="Liabilities" rows={data.liabilities} total={data.totalLiabilities} totalLabel="Total Liabilities" />
            <Section title="Equity" rows={data.equity} total={data.totalEquity} totalLabel="Total Equity" />
            <tr className="border-t-2 border-foreground font-semibold"><td className="px-3 py-3">Liabilities + Equity</td><td className="px-3 py-3 text-right tabular-nums" data-testid="text-bs-total">{fmtMoney(data.liabilitiesAndEquity)}</td></tr>
          </tbody>
        </table>
        {Math.abs(data.totalAssets - data.liabilitiesAndEquity) > 0.01 && (
          <p className="text-xs text-destructive mt-4 text-center">Warning: Assets do not equal Liabilities + Equity. Check your entries.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Trial Balance
// ────────────────────────────────────────────────────────────────────────────
function TrialBalance() {
  const [asOf, setAsOf] = useState(todayISO());
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/trial-balance", asOf],
    queryFn: async () => (await apiRequest("GET", `/api/reports/trial-balance?asOf=${asOf}`)).json(),
  });
  if (!data) return <Loader />;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6">
          <div><Label>As of</Label><Input type="date" data-testid="input-tb-asof" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">Trial Balance</h2>
          <p className="text-xs text-muted-foreground">As of {fmtDate(asOf)}</p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">Code</th>
              <th className="text-left px-3 py-2 font-medium">Account</th>
              <th className="text-right px-3 py-2 font-medium w-28">Debit</th>
              <th className="text-right px-3 py-2 font-medium w-28">Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={r.accountId} className="border-b border-border/40">
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.code}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.debit ? fmtMoney(r.debit) : ""}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.credit ? fmtMoney(r.credit) : ""}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-foreground font-semibold">
              <td colSpan={2} className="px-3 py-3">Totals</td>
              <td className="px-3 py-3 text-right tabular-nums" data-testid="text-tb-total-debit">{fmtMoney(data.totalDebit)}</td>
              <td className="px-3 py-3 text-right tabular-nums" data-testid="text-tb-total-credit">{fmtMoney(data.totalCredit)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// General Ledger (per-account drill-down with running balance)
// ────────────────────────────────────────────────────────────────────────────
function GeneralLedger() {
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const [accountId, setAccountId] = useState<number | null>(null);
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());

  // Default to first account once they load
  if (accountId == null && accounts.length > 0) {
    setAccountId(accounts[0].id);
  }

  const { data } = useQuery<any>({
    queryKey: ["/api/reports/general-ledger", accountId, from, to],
    enabled: accountId != null,
    queryFn: async () =>
      (await apiRequest("GET", `/api/reports/general-ledger?accountId=${accountId}&from=${from}&to=${to}`)).json(),
  });

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6 flex-wrap">
          <div className="min-w-[240px]">
            <Label>Account</Label>
            <Select value={accountId?.toString() ?? ""} onValueChange={(v) => setAccountId(Number(v))}>
              <SelectTrigger data-testid="select-gl-account"><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id.toString()}>
                    {a.code} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>From</Label><Input type="date" data-testid="input-gl-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-gl-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>

        {!data ? <Loader inline /> : (
          <>
            <div className="text-center mb-6">
              <h2 className="text-base font-semibold">{data.account.code} — {data.account.name}</h2>
              <p className="text-xs text-muted-foreground">{fmtDate(from)} — {fmtDate(to)}</p>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium w-28">Date</th>
                  <th className="text-left px-3 py-2 font-medium w-24">Ref</th>
                  <th className="text-left px-3 py-2 font-medium">Memo</th>
                  <th className="text-right px-3 py-2 font-medium w-28">Debit</th>
                  <th className="text-right px-3 py-2 font-medium w-28">Credit</th>
                  <th className="text-right px-3 py-2 font-medium w-32">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border bg-muted/30">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(from)}</td>
                  <td colSpan={4} className="px-3 py-2 italic text-muted-foreground">Opening balance</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium" data-testid="text-gl-opening">{fmtMoney(data.openingBalance)}</td>
                </tr>
                {data.lines.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-12 text-center text-muted-foreground">No activity in this period.</td></tr>
                )}
                {data.lines.map((l: any, idx: number) => (
                  <tr key={idx} className="border-b border-border/40">
                    <td className="px-3 py-1.5 text-muted-foreground">{fmtDate(l.date)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{l.reference || "—"}</td>
                    <td className="px-3 py-1.5">{l.memo}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.debit ? fmtMoney(l.debit) : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.credit ? fmtMoney(l.credit) : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(l.balance)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-foreground font-semibold">
                  <td colSpan={3} className="px-3 py-3">Totals / Closing</td>
                  <td className="px-3 py-3 text-right tabular-nums" data-testid="text-gl-total-debit">{fmtMoney(data.totalDebit)}</td>
                  <td className="px-3 py-3 text-right tabular-nums" data-testid="text-gl-total-credit">{fmtMoney(data.totalCredit)}</td>
                  <td className="px-3 py-3 text-right tabular-nums" data-testid="text-gl-closing">{fmtMoney(data.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// A/R Aging
// ────────────────────────────────────────────────────────────────────────────
function ARAging() {
  return <AgingTable kind="ar" />;
}
function APAging() {
  return <AgingTable kind="ap" />;
}

function AgingTable({ kind }: { kind: "ar" | "ap" }) {
  const [asOf, setAsOf] = useState(todayISO());
  const endpoint = kind === "ar" ? "/api/reports/ar-aging" : "/api/reports/ap-aging";
  const { data } = useQuery<any>({
    queryKey: [endpoint, asOf],
    queryFn: async () => (await apiRequest("GET", `${endpoint}?asOf=${asOf}`)).json(),
  });
  if (!data) return <Loader />;

  const partyLabel = kind === "ar" ? "Customer" : "Vendor";
  const docLabel = kind === "ar" ? "Open Invoices" : "Open Bills";

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6">
          <div><Label>As of</Label><Input type="date" data-testid={`input-${kind}-asof`} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">{kind === "ar" ? "Accounts Receivable Aging" : "Accounts Payable Aging"}</h2>
          <p className="text-xs text-muted-foreground">As of {fmtDate(asOf)}</p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium">{partyLabel}</th>
              <th className="text-right px-3 py-2 font-medium w-24">Current</th>
              <th className="text-right px-3 py-2 font-medium w-24">1–30</th>
              <th className="text-right px-3 py-2 font-medium w-24">31–60</th>
              <th className="text-right px-3 py-2 font-medium w-24">61–90</th>
              <th className="text-right px-3 py-2 font-medium w-24">90+</th>
              <th className="text-right px-3 py-2 font-medium w-28">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-12 text-center text-muted-foreground">No outstanding balances. {docLabel} are all settled.</td></tr>
            )}
            {data.rows.map((r: any) => {
              const id = kind === "ar" ? r.customerId : r.vendorId;
              const name = kind === "ar" ? r.customerName : r.vendorName;
              return (
                <tr key={id} className="border-b border-border/40 hover-elevate" data-testid={`row-${kind}-aging-${id}`}>
                  <td className="px-3 py-2 font-medium">{name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.current ? fmtMoney(r.current) : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.d1_30 ? fmtMoney(r.d1_30) : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.d31_60 ? fmtMoney(r.d31_60) : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.d61_90 ? fmtMoney(r.d61_90) : ""}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.d90_plus ? "text-destructive font-medium" : ""}`}>{r.d90_plus ? fmtMoney(r.d90_plus) : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtMoney(r.total)}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-foreground font-semibold bg-muted/40">
              <td className="px-3 py-3">Totals</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totals.current)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totals.d1_30)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totals.d31_60)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totals.d61_90)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(data.totals.d90_plus)}</td>
              <td className="px-3 py-3 text-right tabular-nums" data-testid={`text-${kind}-total`}>{fmtMoney(data.totals.total)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Cash Flow Statement (indirect-method-lite)
// ────────────────────────────────────────────────────────────────────────────
function CashFlow() {
  const [from, setFrom] = useState(startOfYearISO());
  const [to, setTo] = useState(todayISO());
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/cash-flow", from, to],
    queryFn: async () => (await apiRequest("GET", `/api/reports/cash-flow?from=${from}&to=${to}`)).json(),
  });
  if (!data) return <Loader />;

  const Section = ({ title, items, total }: { title: string; items: { label: string; amount: number }[]; total: number }) => (
    <>
      <tr className="border-b border-border"><td colSpan={2} className="px-3 py-2 font-semibold uppercase tracking-wide text-xs text-muted-foreground">{title}</td></tr>
      {items.length === 0 && (
        <tr><td colSpan={2} className="px-3 py-1.5 pl-6 text-muted-foreground text-xs italic">No activity</td></tr>
      )}
      {items.map((r, idx) => (
        <tr key={`${title}-${idx}`} className="border-b border-border/40">
          <td className="px-3 py-1.5 pl-6">{r.label}</td>
          <td className={`px-3 py-1.5 text-right tabular-nums ${r.amount < 0 ? "text-destructive" : ""}`}>{fmtMoney(r.amount)}</td>
        </tr>
      ))}
      <tr className="border-b border-border bg-muted/30 font-medium">
        <td className="px-3 py-2">Net Cash from {title}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${total < 0 ? "text-destructive" : ""}`}>{fmtMoney(total)}</td>
      </tr>
      <tr><td colSpan={2} className="h-3"></td></tr>
    </>
  );

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-end gap-3 mb-6">
          <div><Label>From</Label><Input type="date" data-testid="input-cf-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" data-testid="input-cf-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="text-center mb-6">
          <h2 className="text-base font-semibold">Cash Flow Statement</h2>
          <p className="text-xs text-muted-foreground">{fmtDate(from)} — {fmtDate(to)} · Indirect method</p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            <Section title="Operating Activities" items={data.operating.items} total={data.operating.total} />
            <Section title="Investing Activities" items={data.investing.items} total={data.investing.total} />
            <Section title="Financing Activities" items={data.financing.items} total={data.financing.total} />
            <tr className="border-t-2 border-foreground font-semibold">
              <td className="px-3 py-3">Net change in cash</td>
              <td className={`px-3 py-3 text-right tabular-nums ${data.netCashChange < 0 ? "text-destructive" : "text-primary"}`} data-testid="text-cf-net-change">{fmtMoney(data.netCashChange)}</td>
            </tr>
            <tr className="border-b border-border/40"><td className="px-3 py-1.5 text-muted-foreground">Cash at start of period</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(data.cashStart)}</td></tr>
            <tr className="border-b border-border bg-muted/30 font-medium"><td className="px-3 py-2">Cash at end of period</td><td className="px-3 py-2 text-right tabular-nums" data-testid="text-cf-cash-end">{fmtMoney(data.cashEnd)}</td></tr>
          </tbody>
        </table>
        {!data.reconciles && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <p className="font-semibold text-destructive">Reconciliation gap: {fmtMoney(data.reconciliationGap ?? 0)}</p>
            <p className="mt-1 text-muted-foreground">
              The three sections do not sum to the change in bank-account balances. On a balanced ledger this gap should always be zero.
              The most common causes are: (1) accounts created without a subtype, (2) custom equity or long-term-liability accounts the engine doesn't recognize,
              or (3) depreciation posted to an account that isn't named "Accumulated Depreciation/Amortization" and lacks the appropriate subtype.
              Check the warnings below and the Chart of Accounts to fix the classification.
            </p>
          </div>
        )}
        {Array.isArray(data.warnings) && data.warnings.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="font-semibold text-amber-700 dark:text-amber-400">Classification warnings</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground space-y-0.5">
              {data.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Loader
// ────────────────────────────────────────────────────────────────────────────
function Loader({ inline = false }: { inline?: boolean }) {
  const inner = (
    <div className="p-12 text-center text-muted-foreground text-sm">Loading…</div>
  );
  if (inline) return inner;
  return <Card><CardContent className="p-0">{inner}</CardContent></Card>;
}

// ────────────────────────────────────────────────────────────────────────────
// Inventory valuation — surfaces the org's costing method + per-item value,
// with expandable FIFO/LIFO cost layers.
// ────────────────────────────────────────────────────────────────────────────
const METHOD_LABEL: Record<string, string> = { average: "Weighted average", fifo: "FIFO", lifo: "LIFO" };

function ItemCostLayers({ itemId }: { itemId: number }) {
  const { data } = useQuery<any>({
    queryKey: ["/api/items", itemId, "cost-layers"],
    queryFn: async () => (await apiRequest("GET", `/api/items/${itemId}/cost-layers`)).json(),
  });
  if (!data) return <div className="px-6 py-2 text-xs text-muted-foreground">Loading layers…</div>;
  if (!data.layers.length) return <div className="px-6 py-2 text-xs text-muted-foreground">No open cost layers.</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground">
        <tr><th className="px-6 py-1 text-left font-medium">Acquired</th><th className="px-3 py-1 text-right font-medium">Qty left</th><th className="px-3 py-1 text-right font-medium">Unit cost</th><th className="px-3 py-1 text-right font-medium">Value</th></tr>
      </thead>
      <tbody>
        {data.layers.map((l: any) => (
          <tr key={l.id} className="border-t border-border/40">
            <td className="px-6 py-1">{fmtDate(l.date)}</td>
            <td className="px-3 py-1 text-right tabular-nums">{l.qtyRemaining}</td>
            <td className="px-3 py-1 text-right tabular-nums">{fmtMoney(l.unitCostCents)}</td>
            <td className="px-3 py-1 text-right tabular-nums">{fmtMoney(l.costRemainingCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InventoryReport() {
  const [expanded, setExpanded] = useState<number | null>(null);
  const { data } = useQuery<any>({
    queryKey: ["/api/reports/inventory-valuation"],
    queryFn: async () => (await apiRequest("GET", "/api/reports/inventory-valuation")).json(),
  });
  if (!data) return <Loader />;
  const method: string = data.costingMethod || "average";
  const layered = method !== "average";

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
          <div>
            <h2 className="text-base font-semibold">Inventory valuation</h2>
            <p className="text-xs text-muted-foreground">As of {fmtDate(data.asOfDate)}</p>
          </div>
          <span className="rounded-full border px-3 py-1 text-xs font-medium bg-muted/50" data-testid="badge-costing-method">
            Costing method: {METHOD_LABEL[method] ?? method}
          </span>
        </div>
        {data.warning && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">{data.warning}</div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-right">On hand</th>
                <th className="px-3 py-2 text-right">Unit cost</th>
                <th className="px-3 py-2 text-right">Value</th>
                {layered && <th className="w-8"></th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr><td colSpan={layered ? 6 : 5} className="px-3 py-8 text-center text-muted-foreground">No inventory items.</td></tr>
              )}
              {data.rows.map((r: any) => (
                <Fragment key={r.id}>
                  <tr className="border-b border-border/40" data-testid={`row-inv-item-${r.id}`}>
                    <td className="px-3 py-1.5 font-medium">{r.sku}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.quantityOnHand}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.avgCostCents)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.valuationCents)}</td>
                    {layered && (
                      <td className="px-3 py-1.5 text-right">
                        <button className="text-xs underline text-muted-foreground hover:text-foreground" data-testid={`button-layers-${r.id}`} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          {expanded === r.id ? "Hide" : "Layers"}
                        </button>
                      </td>
                    )}
                  </tr>
                  {layered && expanded === r.id && (
                    <tr className="bg-muted/20"><td colSpan={6} className="p-0"><ItemCostLayers itemId={r.id} /></td></tr>
                  )}
                </Fragment>
              ))}
              {data.rows.length > 0 && (
                <tr className="border-t-2 border-foreground font-semibold">
                  <td className="px-3 py-3" colSpan={4}>Total inventory value</td>
                  <td className="px-3 py-3 text-right tabular-nums" data-testid="text-inv-total">{fmtMoney(data.totalValuationCents)}</td>
                  {layered && <td></td>}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
