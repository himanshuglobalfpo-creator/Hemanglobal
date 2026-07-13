// ============================================================================
// BUDGETING (QBO "Tools → Budgeting")
// ============================================================================
// Backed by the existing /api/budgets CRUD + /api/reports/budget-vs-actual.
// The underlying model is monthly (budget_lines per account per month). This
// editor takes ONE monthly amount per income/expense account and writes it to
// all 12 months of the budget's fiscal year — a clear, honest MVP over the
// month-by-month grid. Budget vs actual then compares against real P&L activity
// for the selected range. All money is integer cents at the API boundary.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, PiggyBank } from "lucide-react";
import type { Account } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, centsToDollars } from "@/lib/format";

type Budget = { id: number; name: string; fiscalYear: number };
type BudgetLine = { accountId: number; code: string; accountName: string; month: number; amount: number };
type BudgetDetail = Budget & { lines: BudgetLine[] };
type BvaRow = { accountId: number; code: string; name: string; type: string; budget: number; actual: number; variance: number; variancePct: number | null };
type Bva = { budget: Budget; from: string; to: string; rows: BvaRow[] };

export default function Budgeting() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newYear, setNewYear] = useState(new Date().getFullYear());
  // Per-account monthly dollar amounts, keyed by accountId.
  const [amounts, setAmounts] = useState<Record<number, string>>({});

  const { data: budgets = [] } = useQuery<Budget[]>({ queryKey: ["/api/budgets"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const plAccts = accounts.filter((a) => a.type === "income" || a.type === "expense");

  // Auto-select the newest budget.
  useEffect(() => {
    if (selectedId === null && budgets.length > 0) setSelectedId(budgets[0].id);
  }, [budgets, selectedId]);

  const { data: detail } = useQuery<BudgetDetail>({
    queryKey: ["/api/budgets", selectedId],
    queryFn: async () => (await apiRequest("GET", `/api/budgets/${selectedId}`)).json(),
    enabled: selectedId !== null,
  });

  // Seed the editor from the loaded budget: month-1 amount stands in for the
  // (uniform) monthly figure — matching how this editor writes them.
  useEffect(() => {
    if (!detail) return;
    const next: Record<number, string> = {};
    for (const l of detail.lines) {
      if (l.month === 1) next[l.accountId] = centsToDollars(l.amount).toString();
    }
    setAmounts(next);
  }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fy = detail?.fiscalYear ?? newYear;
  const { data: bva } = useQuery<Bva>({
    queryKey: ["/api/reports/budget-vs-actual", selectedId, fy],
    queryFn: async () =>
      (await apiRequest("GET", `/api/reports/budget-vs-actual?budgetId=${selectedId}&from=${fy}-01-01&to=${fy}-12-31`)).json(),
    enabled: selectedId !== null && !!detail,
  });

  const createMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/budgets", { name: newName.trim(), fiscalYear: newYear })).json(),
    onSuccess: (b: Budget) => {
      queryClient.invalidateQueries({ queryKey: ["/api/budgets"] });
      setSelectedId(b.id);
      setCreateOpen(false);
      setNewName("");
      toast({ title: "Budget created" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const saveLinesMut = useMutation({
    mutationFn: async () => {
      // Expand each per-account monthly amount into 12 monthly lines (integer cents).
      const lines: Array<{ accountId: number; month: number; amount: number }> = [];
      for (const a of plAccts) {
        const raw = amounts[a.id];
        if (raw === undefined || raw === "") continue;
        const cents = Math.round(parseFloat(raw) * 100);
        if (!Number.isFinite(cents)) continue;
        for (let m = 1; m <= 12; m++) lines.push({ accountId: a.id, month: m, amount: cents });
      }
      if (lines.length === 0) throw new Error("Enter at least one monthly amount.");
      return (await apiRequest("PUT", `/api/budgets/${selectedId}/lines`, { lines })).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/budgets", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/budget-vs-actual"] });
      toast({ title: "Budget saved" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/budgets/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/budgets"] }); setSelectedId(null); },
  });

  return (
    <Layout>
      <PageHeader
        title="Budgeting"
        description="Plan income and expenses, then track budget vs. actual"
        actions={<Button onClick={() => setCreateOpen(true)} data-testid="button-new-budget"><Plus className="h-4 w-4 mr-1.5" />New budget</Button>}
      />

      {budgets.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">No budgets yet. Create one to get started.</CardContent></Card>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Label className="shrink-0">Budget</Label>
            <Select value={selectedId ? String(selectedId) : ""} onValueChange={(v) => setSelectedId(Number(v))}>
              <SelectTrigger className="w-72" data-testid="select-budget"><SelectValue placeholder="Pick a budget" /></SelectTrigger>
              <SelectContent>
                {budgets.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} · FY{b.fiscalYear}</SelectItem>)}
              </SelectContent>
            </Select>
            {selectedId && (
              <Button variant="ghost" size="sm" onClick={() => delMut.mutate(selectedId)} data-testid="button-delete-budget">
                <Trash2 className="h-4 w-4 mr-1" />Delete
              </Button>
            )}
          </div>

          {/* Editor: one monthly amount per P&L account, applied to all 12 months. */}
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border text-sm font-medium flex items-center gap-2">
                <PiggyBank className="h-4 w-4" /> Monthly amounts {detail && <span className="text-muted-foreground font-normal">· applied to each month of FY{detail.fiscalYear}</span>}
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Account</th>
                    <th className="text-left px-4 py-2 font-medium w-24">Type</th>
                    <th className="text-right px-4 py-2 font-medium w-40">Monthly amount</th>
                    <th className="text-right px-4 py-2 font-medium w-32">Annual</th>
                  </tr>
                </thead>
                <tbody>
                  {plAccts.map((a) => {
                    const monthly = parseFloat(amounts[a.id] || "0") || 0;
                    return (
                      <tr key={a.id} className="border-t border-border" data-testid={`row-budget-account-${a.id}`}>
                        <td className="px-4 py-1.5">{a.code} {a.name}</td>
                        <td className="px-4 py-1.5 capitalize text-muted-foreground">{a.type}</td>
                        <td className="px-4 py-1.5">
                          <Input
                            type="number" step="0.01" className="h-8 text-right"
                            data-testid={`input-budget-amount-${a.id}`}
                            value={amounts[a.id] ?? ""}
                            onChange={(e) => setAmounts({ ...amounts, [a.id]: e.target.value })}
                          />
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{fmtMoney(Math.round(monthly * 12 * 100))}</td>
                      </tr>
                    );
                  })}
                  {plAccts.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No income or expense accounts to budget.</td></tr>
                  )}
                </tbody>
              </table>
              <div className="px-4 py-3 border-t border-border">
                <Button onClick={() => saveLinesMut.mutate()} disabled={!selectedId || saveLinesMut.isPending} data-testid="button-save-budget">
                  {saveLinesMut.isPending ? "Saving…" : "Save budget"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Budget vs actual for the fiscal year. */}
          {bva && (
            <Card>
              <CardContent className="p-0">
                <div className="px-4 py-3 border-b border-border text-sm font-medium">Budget vs actual · FY{detail?.fiscalYear}</div>
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Account</th>
                      <th className="text-right px-4 py-2 font-medium">Budget</th>
                      <th className="text-right px-4 py-2 font-medium">Actual</th>
                      <th className="text-right px-4 py-2 font-medium">Variance</th>
                      <th className="text-right px-4 py-2 font-medium w-20">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bva.rows.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No budget or actual activity in this range.</td></tr>
                    )}
                    {bva.rows.map((r) => (
                      <tr key={r.accountId} className="border-t border-border" data-testid={`row-bva-${r.accountId}`}>
                        <td className="px-4 py-1.5">{r.code} {r.name}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtMoney(r.budget)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtMoney(r.actual)}</td>
                        <td className={`px-4 py-1.5 text-right tabular-nums ${r.variance < 0 ? "text-destructive" : "text-primary"}`}>{fmtMoney(r.variance)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{r.variancePct == null ? "—" : `${r.variancePct}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New budget</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input data-testid="input-budget-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. FY Operating Budget" />
            </div>
            <div>
              <Label>Fiscal year</Label>
              <Input type="number" data-testid="input-budget-year" value={newYear} onChange={(e) => setNewYear(Number(e.target.value))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button disabled={!newName.trim() || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-create-budget">
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
