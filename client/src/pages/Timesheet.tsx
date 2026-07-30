// ============================================================================
// TIMESHEET (P3.3) — weekly grid + single-entry dialog + project budget
// ============================================================================
// Log billable/non-billable time against projects. The week grid shows entries
// day-by-day with daily and weekly totals; the entry dialog adds one row. A
// project selector reveals actual-vs-budget (from the GL) and unbilled time —
// the same numbers the "Add unbilled time to invoice" action bills against.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Plus, Trash2, ChevronLeft, ChevronRight, Target } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, todayISO } from "@/lib/format";

type Project = { id: number; name: string; isActive: boolean };
type TimeEntry = { id: number; projectId: number; projectName: string; userName: string; serviceDate: string; description: string; minutes: number; billable: boolean; rateCents: number; invoicedLineId: number | null };
type Budget = { project: { name: string }; actualIncome: number; actualCost: number; actualNet: number; budgetIncome: number; budgetCost: number; budgetNet: number; unbilledMinutes: number; unbilledAmount: number };

// Monday-based week start for a given ISO date.
function weekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hrs = (m: number) => (m / 60).toFixed(2);
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function Timesheet() {
  const { toast } = useToast();
  const [weekOf, setWeekOf] = useState(() => weekStart(todayISO()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [budgetProjectId, setBudgetProjectId] = useState<number | null>(null);

  const weekEnd = addDays(weekOf, 6);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekOf, i)), [weekOf]);

  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const { data: entries = [] } = useQuery<TimeEntry[]>({
    queryKey: ["/api/time-entries", weekOf, weekEnd],
    queryFn: async () => (await apiRequest("GET", `/api/time-entries?from=${weekOf}&to=${weekEnd}`)).json(),
  });
  const { data: budget } = useQuery<Budget>({
    queryKey: ["/api/projects/budget", budgetProjectId],
    queryFn: async () => (await apiRequest("GET", `/api/projects/${budgetProjectId}/budget`)).json(),
    enabled: !!budgetProjectId,
  });

  const delMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/time-entries/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] }),
    onError: (e: any) => toast({ title: "Cannot delete", description: e.message, variant: "destructive" }),
  });

  const byDay = (iso: string) => entries.filter((e) => e.serviceDate === iso);
  const dayTotal = (iso: string) => byDay(iso).reduce((s, e) => s + e.minutes, 0);
  const weekTotal = entries.reduce((s, e) => s + e.minutes, 0);
  const billableTotal = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);

  return (
    <Layout>
      <PageHeader title="Timesheet" description="Log time against projects, then bill it on an invoice." />
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekOf(addDays(weekOf, -7))} data-testid="button-prev-week"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium">Week of {weekOf} → {weekEnd}</span>
          <Button variant="outline" size="sm" onClick={() => setWeekOf(addDays(weekOf, 7))} data-testid="button-next-week"><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setWeekOf(weekStart(todayISO()))}>This week</Button>
          <div className="flex-1" />
          <Button onClick={() => setDialogOpen(true)} disabled={projects.length === 0} data-testid="button-add-time"><Plus className="h-4 w-4 mr-1" /> Log time</Button>
        </div>

        <Card data-testid="card-timesheet-grid">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Clock className="h-4 w-4" /> {hrs(weekTotal)}h this week · {hrs(billableTotal)}h billable</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {projects.length === 0 && <p className="text-sm text-muted-foreground">Create a project first (Settings → Projects) to log time against it.</p>}
            {days.map((d, i) => {
              const rows = byDay(d);
              return (
                <div key={d} className="border-b pb-2 last:border-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="w-28">{DOW[i]} {d.slice(5)}</span>
                    <span className="text-muted-foreground">{hrs(dayTotal(d))}h</span>
                  </div>
                  {rows.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 py-0.5 pl-28 text-sm" data-testid={`time-row-${e.id}`}>
                      <span className="w-40 truncate">{e.projectName}</span>
                      <span className="flex-1 truncate text-muted-foreground">{e.description || "—"}</span>
                      <span>{hrs(e.minutes)}h</span>
                      {e.billable ? <Badge variant="secondary">{fmtMoney(Math.round((e.minutes / 60) * e.rateCents))}</Badge> : <Badge variant="outline">non-billable</Badge>}
                      {e.invoicedLineId ? <Badge className="bg-green-100 text-green-800">invoiced</Badge> : (
                        <button className="text-muted-foreground hover:text-destructive" onClick={() => delMut.mutate(e.id)} data-testid={`button-del-time-${e.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card data-testid="card-project-budget">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Target className="h-4 w-4" /> Project actual vs budget</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={budgetProjectId ?? ""} onChange={(e) => setBudgetProjectId(e.target.value ? Number(e.target.value) : null)} data-testid="select-budget-project">
              <option value="">Select a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {budget && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Actual income" value={fmtMoney(budget.actualIncome)} />
                <Metric label="Budget income" value={budget.budgetIncome ? fmtMoney(budget.budgetIncome) : "—"} />
                <Metric label="Actual cost" value={fmtMoney(budget.actualCost)} />
                <Metric label="Budget cost" value={budget.budgetCost ? fmtMoney(budget.budgetCost) : "—"} />
                <Metric label="Actual net" value={fmtMoney(budget.actualNet)} tone={budget.actualNet >= 0 ? "ok" : "warn"} />
                <Metric label="Budget net" value={budget.budgetNet ? fmtMoney(budget.budgetNet) : "—"} />
                <Metric label="Unbilled time" value={`${hrs(budget.unbilledMinutes)}h`} tone={budget.unbilledMinutes > 0 ? "warn" : "muted"} />
                <Metric label="Unbilled value" value={fmtMoney(budget.unbilledAmount)} tone={budget.unbilledAmount > 0 ? "warn" : "muted"} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {dialogOpen && <EntryDialog projects={projects} onClose={() => setDialogOpen(false)} />}
    </Layout>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "muted" }) {
  const color = tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-green-600" : "";
  return <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{label}</div><div className={`text-sm font-medium ${color}`}>{value}</div></div>;
}

function EntryDialog({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.id ?? null);
  const [serviceDate, setServiceDate] = useState(todayISO());
  const [hours, setHours] = useState("1");
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(true);
  const [rate, setRate] = useState("0");

  const save = useMutation({
    mutationFn: () => apiRequest("POST", "/api/time-entries", {
      projectId,
      serviceDate,
      minutes: Math.round(parseFloat(hours || "0") * 60),
      description,
      billable,
      rateCents: Math.round(parseFloat(rate || "0") * 100),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/time-entries"] }); toast({ title: "Time logged" }); onClose(); },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const valid = !!projectId && parseFloat(hours || "0") > 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Log time</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Project</Label>
            <select className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))} data-testid="select-time-project">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Date</Label><Input type="date" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} data-testid="input-time-date" /></div>
            <div><Label>Hours</Label><Input type="number" step="0.25" min="0" value={hours} onChange={(e) => setHours(e.target.value)} data-testid="input-time-hours" /></div>
          </div>
          <div><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" data-testid="input-time-desc" /></div>
          <div className="grid grid-cols-2 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} data-testid="check-time-billable" /> Billable</label>
            <div><Label>Rate ($/hr)</Label><Input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!billable} data-testid="input-time-rate" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending} data-testid="button-save-time">{save.isPending ? "Saving…" : "Log time"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
