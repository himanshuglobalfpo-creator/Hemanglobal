import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Wallet,
  ArrowDownToLine,
  ArrowUpFromLine,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import { Link } from "wouter";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { Invoice, Bill } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layout, PageHeader } from "@/components/Layout";
import { fmtMoney, startOfYearISO, todayISO } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

interface DashboardStats {
  cashOnHand: number;
  arOutstanding: number;
  apOutstanding: number;
  overdueInvoices: number;
  overdueBills: number;
  revenueThisMonth: number;
  expensesThisMonth: number;
  netIncomeThisMonth: number;
}

interface PLData {
  income: { name: string; amount: number }[];
  expenses: { name: string; amount: number }[];
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
}

function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  testId,
}: {
  label: string;
  value: string;
  icon: any;
  hint?: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
            <p className="text-xl font-semibold mt-2 tabular-nums" data-testid={testId}>
              {value}
            </p>
            {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
          </div>
          <div className="bg-accent rounded-md p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading: loadingStats } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard"],
  });
  const { data: pl } = useQuery<PLData>({
    queryKey: ["/api/reports/profit-loss", startOfYearISO(), todayISO()],
    queryFn: async () => {
      const r = await fetch(`/api/reports/profit-loss?from=${startOfYearISO()}&to=${todayISO()}`);
      return r.json();
    },
  });
  const { data: invoices } = useQuery<(Invoice & { customerName?: string })[]>({
    queryKey: ["/api/invoices"],
  });
  const { data: bills } = useQuery<(Bill & { vendorName?: string })[]>({ queryKey: ["/api/bills"] });

  const recentInvoices = (invoices || []).slice(0, 5);
  const recentBills = (bills || []).slice(0, 5);

  const chartData = pl
    ? [
        { name: "Income", value: pl.totalIncome, fill: "hsl(var(--chart-1))" },
        { name: "Expenses", value: pl.totalExpenses, fill: "hsl(var(--chart-5))" },
        { name: "Net", value: pl.netIncome, fill: "hsl(var(--chart-2))" },
      ]
    : [];

  return (
    <Layout>
      <PageHeader title="Dashboard" description="Snapshot of your business finances" />

      {loadingStats ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Cash on Hand"
            value={fmtMoney(stats.cashOnHand)}
            icon={Wallet}
            testId="stat-cash"
          />
          <StatCard
            label="Receivable"
            value={fmtMoney(stats.arOutstanding)}
            icon={ArrowDownToLine}
            hint={stats.overdueInvoices > 0 ? `${stats.overdueInvoices} overdue` : "All current"}
            testId="stat-ar"
          />
          <StatCard
            label="Payable"
            value={fmtMoney(stats.apOutstanding)}
            icon={ArrowUpFromLine}
            hint={stats.overdueBills > 0 ? `${stats.overdueBills} overdue` : "All current"}
            testId="stat-ap"
          />
          <StatCard
            label="Net Income (MTD)"
            value={fmtMoney(stats.netIncomeThisMonth)}
            icon={TrendingUp}
            hint={`Rev ${fmtMoney(stats.revenueThisMonth)} · Exp ${fmtMoney(stats.expensesThisMonth)}`}
            testId="stat-net-income"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Year-to-date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(v: any) => fmtMoney(Number(v))}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href="/invoices" className="block px-3 py-2 rounded-md hover-elevate text-sm" data-testid="quick-invoices">
              Create invoice →
            </Link>
            <Link href="/bills" className="block px-3 py-2 rounded-md hover-elevate text-sm" data-testid="quick-bills">
              Enter bill →
            </Link>
            <Link href="/journal" className="block px-3 py-2 rounded-md hover-elevate text-sm" data-testid="quick-journal">
              Manual journal entry →
            </Link>
            <Link href="/reports" className="block px-3 py-2 rounded-md hover-elevate text-sm" data-testid="quick-reports">
              View reports →
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Recent invoices</span>
              <Link href="/invoices" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentInvoices.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No invoices yet.</p>
            ) : (
              <div className="space-y-1">
                {recentInvoices.map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center justify-between py-2 px-2 rounded hover-elevate text-sm"
                    data-testid={`row-recent-invoice-${i.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{i.number} · {i.customerName}</p>
                      <p className="text-xs text-muted-foreground">{i.date} · {i.status}</p>
                    </div>
                    <p className="tabular-nums font-medium">{fmtMoney(i.total)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Recent bills</span>
              <Link href="/bills" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentBills.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No bills yet.</p>
            ) : (
              <div className="space-y-1">
                {recentBills.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between py-2 px-2 rounded hover-elevate text-sm"
                    data-testid={`row-recent-bill-${b.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{b.number} · {b.vendorName}</p>
                      <p className="text-xs text-muted-foreground">{b.date} · {b.status}</p>
                    </div>
                    <p className="tabular-nums font-medium">{fmtMoney(b.total)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(stats?.overdueInvoices ?? 0) + (stats?.overdueBills ?? 0) > 0 && (
        <Card className="mt-6 border-destructive/50">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm">
              You have {stats?.overdueInvoices ?? 0} overdue invoice(s) and {stats?.overdueBills ?? 0} overdue bill(s).
            </p>
          </CardContent>
        </Card>
      )}
      <ActivationChecklist />
      <LowStockCard />
    </Layout>
  );
}

// P3.9 — low-stock reorder suggestions (respects open PO quantity).
type ReorderRow = { itemId: number; sku: string; name: string; onHand: number; onOrder: number; reorderPoint: number; reorderQty: number; preferredVendorName: string | null };
function LowStockCard() {
  const { data = [] } = useQuery<ReorderRow[]>({ queryKey: ["/api/inventory/reorder-suggestions"] });
  if (data.length === 0) return null;
  return (
    <Card className="mt-6" data-testid="card-low-stock">
      <CardHeader><CardTitle className="text-base">Low stock — reorder suggestions ({data.length})</CardTitle></CardHeader>
      <CardContent className="space-y-1">
        {data.map((r) => (
          <div key={r.itemId} className="flex flex-wrap items-center gap-2 border-b py-1 text-sm last:border-0" data-testid={`low-stock-${r.itemId}`}>
            <span className="font-medium">{r.name}</span>
            <span className="text-muted-foreground">on hand {r.onHand} · on order {r.onOrder} · reorder at {r.reorderPoint}</span>
            <span className="ml-auto text-muted-foreground">{r.preferredVendorName ? `→ ${r.preferredVendorName}` : "no preferred vendor"} · suggest {r.reorderQty}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// P4.2 — activation checklist + demo-mode banner.
function ActivationChecklist() {
  const { data } = useQuery<{ tasks: Array<{ step: string; done: boolean }>; complete: boolean }>({ queryKey: ["/api/onboarding"] });
  const { data: demo } = useQuery<{ isDemo: boolean }>({ queryKey: ["/api/demo/status"] });
  const clear = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/demo/clear", {})).json(), onSuccess: () => queryClient.invalidateQueries() });
  const LABELS: Record<string, string> = { profile: "Set up your business profile", bank: "Connect a bank account", import: "Import or start fresh", invite: "Invite your team", first_invoice: "Create your first invoice" };
  return (
    <>
      {demo?.isDemo && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" data-testid="banner-demo">
          <span>You're viewing <strong>demo data</strong>.</span>
          <button className="ml-auto rounded border bg-white px-2 py-1 text-xs" onClick={() => { if (window.confirm("Clear all demo data and start fresh?")) clear.mutate(); }} data-testid="button-clear-demo">Clear demo data</button>
        </div>
      )}
      {data && !data.complete && (
        <Card className="mt-6" data-testid="card-activation">
          <CardHeader><CardTitle className="text-base">Get started ({data.tasks.filter((t) => t.done).length}/{data.tasks.length})</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {data.tasks.map((t) => (
              <div key={t.step} className="flex items-center gap-2 text-sm" data-testid={`activation-${t.step}`}>
                <span className={t.done ? "text-green-600" : "text-muted-foreground"}>{t.done ? "✓" : "○"}</span>
                <span className={t.done ? "text-muted-foreground line-through" : ""}>{LABELS[t.step] ?? t.step}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
