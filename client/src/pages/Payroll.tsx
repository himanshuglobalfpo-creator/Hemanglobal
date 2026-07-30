// ============================================================================
// PAYROLL — /payroll
// ============================================================================
// Tabs: Employees (CRUD), Pay runs (create → post, per-employee stub), and
// Liabilities (remit accrued payroll taxes/deductions). Over /api/payroll/*.
// Money is entered in dollars and converted to integer cents at the boundary;
// withholding rates are shown as % and stored as fractions (0..1).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, CheckCircle2, FileText, Receipt } from "lucide-react";
import type { Account } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, todayISO, centsToDollars } from "@/lib/format";

type Employee = { id: number; name: string; email?: string | null; payType: string; payRateCents: number; payFrequency: string; federalWithholdingRate: number; stateWithholdingRate: number; status: string };
type Run = { id: number; payDate: string; periodStart: string; periodEnd: string; status: string; totalNetCents: number; totalGrossCents: number };
type Liability = { accountId: number; code: string; name: string; balanceCents: number };

export default function Payroll() {
  const [tab, setTab] = useState("employees");
  return (
    <Layout>
      <PageHeader title="Payroll" description="Employees, pay runs, and tax liabilities" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="employees" data-testid="tab-employees">Employees</TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">Pay runs</TabsTrigger>
          <TabsTrigger value="liabilities" data-testid="tab-liabilities">Liabilities</TabsTrigger>
        </TabsList>
        <TabsContent value="employees" className="mt-4"><EmployeesTab /></TabsContent>
        <TabsContent value="runs" className="mt-4"><RunsTab /></TabsContent>
        <TabsContent value="liabilities" className="mt-4"><LiabilitiesTab /></TabsContent>
      </Tabs>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
function EmployeesTab() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data: employees = [] } = useQuery<Employee[]>({ queryKey: ["/api/payroll/employees"] });
  const [form, setForm] = useState({ name: "", email: "", payType: "salary", rate: "", payFrequency: "biweekly", fed: "10", state: "5" });

  const createMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/payroll/employees", {
      name: form.name.trim(), email: form.email || null, payType: form.payType,
      payRateCents: Math.round(parseFloat(form.rate) * 100), payFrequency: form.payFrequency,
      federalWithholdingRate: (parseFloat(form.fed) || 0) / 100, stateWithholdingRate: (parseFloat(form.state) || 0) / 100,
    })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees"] }); setOpen(false); toast({ title: "Employee added" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const toggleMut = useMutation({
    mutationFn: async (emp: Employee) => apiRequest("PATCH", `/api/payroll/employees/${emp.id}`, { status: emp.status === "active" ? "inactive" : "active" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees"] }),
  });

  return (
    <div>
      <div className="flex justify-end mb-3"><Button onClick={() => { setForm({ name: "", email: "", payType: "salary", rate: "", payFrequency: "biweekly", fed: "10", state: "5" }); setOpen(true); }} data-testid="button-new-employee"><Plus className="h-4 w-4 mr-1.5" />New employee</Button></div>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium text-right">Rate</th><th className="px-4 py-3 font-medium">Frequency</th>
                <th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium w-28"></th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No employees yet.</td></tr>}
              {employees.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-employee-${e.id}`}>
                  <td className="px-4 py-3 font-medium">{e.name}</td>
                  <td className="px-4 py-3 capitalize">{e.payType}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(e.payRateCents)}{e.payType === "hourly" ? "/hr" : "/yr"}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{e.payFrequency}</td>
                  <td className="px-4 py-3"><Badge variant={e.status === "active" ? "default" : "secondary"}>{e.status}</Badge></td>
                  <td className="px-4 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => toggleMut.mutate(e)} data-testid={`button-toggle-employee-${e.id}`}>{e.status === "active" ? "Deactivate" : "Activate"}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New employee</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input data-testid="input-employee-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>Email</Label><Input data-testid="input-employee-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Pay type</Label>
                <Select value={form.payType} onValueChange={(v) => setForm({ ...form, payType: v })}>
                  <SelectTrigger data-testid="select-employee-paytype"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="salary">Salary (annual)</SelectItem><SelectItem value="hourly">Hourly</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>{form.payType === "hourly" ? "Hourly rate" : "Annual salary"}</Label><Input type="number" step="0.01" data-testid="input-employee-rate" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></div>
              <div><Label>Frequency</Label>
                <Select value={form.payFrequency} onValueChange={(v) => setForm({ ...form, payFrequency: v })}>
                  <SelectTrigger data-testid="select-employee-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="weekly">Weekly</SelectItem><SelectItem value="biweekly">Biweekly</SelectItem><SelectItem value="semimonthly">Semimonthly</SelectItem><SelectItem value="monthly">Monthly</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Fed %</Label><Input type="number" step="0.1" data-testid="input-employee-fed" value={form.fed} onChange={(e) => setForm({ ...form, fed: e.target.value })} /></div>
                <div><Label>State %</Label><Input type="number" step="0.1" data-testid="input-employee-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.name.trim() || !(parseFloat(form.rate) > 0) || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-employee">{createMut.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
function RunsTab() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [stub, setStub] = useState<{ runId: number; employeeId: number } | null>(null);
  const { data: runsRaw } = useQuery<any>({ queryKey: ["/api/payroll/runs"], queryFn: async () => (await apiRequest("GET", "/api/payroll/runs?limit=100")).json() });
  const runs: Run[] = Array.isArray(runsRaw) ? runsRaw : runsRaw?.rows ?? [];
  const { data: employees = [] } = useQuery<Employee[]>({ queryKey: ["/api/payroll/employees"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const activeEmps = employees.filter((e) => e.status === "active");

  const [form, setForm] = useState<{ payDate: string; periodStart: string; periodEnd: string; bankAccountId: number | null; hours: Record<number, string> }>({
    payDate: todayISO(), periodStart: todayISO(), periodEnd: todayISO(), bankAccountId: null, hours: {},
  });
  function openCreate() { setForm({ payDate: todayISO(), periodStart: todayISO(), periodEnd: todayISO(), bankAccountId: bankAccts[0]?.id ?? null, hours: {} }); setOpen(true); }
  useEffect(() => { if (open && form.bankAccountId === null && bankAccts[0]) setForm((f) => ({ ...f, bankAccountId: bankAccts[0].id })); }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/payroll/runs", {
      payDate: form.payDate, periodStart: form.periodStart, periodEnd: form.periodEnd, bankAccountId: form.bankAccountId,
      lines: activeEmps.map((e) => ({ employeeId: e.id, ...(e.payType === "hourly" ? { hours: parseFloat(form.hours[e.id] || "0") } : {}) })),
    })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] }); setOpen(false); toast({ title: "Pay run created (draft)" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const postMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/payroll/runs/${id}/post`, {})).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] }); queryClient.invalidateQueries({ queryKey: ["/api/journal"] }); toast({ title: "Pay run posted" }); },
    onError: (e: any) => toast({ title: "Post failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div>
      <div className="flex justify-end mb-3"><Button onClick={openCreate} disabled={activeEmps.length === 0} data-testid="button-new-run"><Plus className="h-4 w-4 mr-1.5" />New pay run</Button></div>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Pay date</th><th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium text-right">Gross</th><th className="px-4 py-3 font-medium text-right">Net</th>
                <th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium w-40"></th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No pay runs yet.</td></tr>}
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-run-${r.id}`}>
                  <td className="px-4 py-3 font-medium">{fmtDate(r.payDate)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(r.totalGrossCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(r.totalNetCents)}</td>
                  <td className="px-4 py-3"><Badge variant={r.status === "posted" ? "default" : "secondary"}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center gap-1 justify-end">
                      {employees[0] && <Button size="sm" variant="ghost" onClick={() => setStub({ runId: r.id, employeeId: employees[0].id })} data-testid={`button-stub-run-${r.id}`}><FileText className="h-3.5 w-3.5 mr-1" />Stub</Button>}
                      {r.status === "draft" && <Button size="sm" variant="outline" onClick={() => postMut.mutate(r.id)} disabled={postMut.isPending} data-testid={`button-post-run-${r.id}`}><CheckCircle2 className="h-3.5 w-3.5 mr-1" />Post</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New pay run</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Pay date</Label><Input type="date" data-testid="input-run-paydate" value={form.payDate} onChange={(e) => setForm({ ...form, payDate: e.target.value })} /></div>
              <div><Label>Period start</Label><Input type="date" data-testid="input-run-start" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></div>
              <div><Label>Period end</Label><Input type="date" data-testid="input-run-end" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></div>
            </div>
            <div>
              <Label>Pay from</Label>
              <Select value={form.bankAccountId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, bankAccountId: Number(v) })}>
                <SelectTrigger data-testid="select-run-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>{bankAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="rounded-md border border-border divide-y">
              {activeEmps.map((e) => (
                <div key={e.id} className="flex items-center justify-between px-3 py-2 text-sm" data-testid={`run-employee-${e.id}`}>
                  <span>{e.name} <span className="text-xs text-muted-foreground capitalize">· {e.payType}</span></span>
                  {e.payType === "hourly" ? (
                    <span className="flex items-center gap-1"><Label className="text-xs text-muted-foreground">Hours</Label><Input type="number" step="0.5" className="h-8 w-24 text-right" data-testid={`input-run-hours-${e.id}`} value={form.hours[e.id] ?? ""} onChange={(ev) => setForm({ ...form, hours: { ...form.hours, [e.id]: ev.target.value } })} /></span>
                  ) : <span className="text-xs text-muted-foreground">salary</span>}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.bankAccountId || activeEmps.length === 0 || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-run">{createMut.isPending ? "Creating…" : "Create pay run"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {stub && <StubDialog runId={stub.runId} employees={employees} initialEmployeeId={stub.employeeId} onClose={() => setStub(null)} />}
    </div>
  );
}

function StubDialog({ runId, employees, initialEmployeeId, onClose }: { runId: number; employees: Employee[]; initialEmployeeId: number; onClose: () => void }) {
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const { data: stub, isError } = useQuery<any>({
    queryKey: ["/api/payroll/runs", runId, "stub", employeeId],
    queryFn: async () => (await apiRequest("GET", `/api/payroll/runs/${runId}/employees/${employeeId}/stub`)).json(),
  });
  const Row = ({ label, cents }: { label: string; cents?: number }) => (
    <div className="flex justify-between text-sm"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{fmtMoney(cents ?? 0)}</span></div>
  );
  const p = stub?.item ?? stub ?? {};
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pay stub</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Select value={String(employeeId)} onValueChange={(v) => setEmployeeId(Number(v))}>
            <SelectTrigger data-testid="select-stub-employee"><SelectValue /></SelectTrigger>
            <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}</SelectContent>
          </Select>
          {isError ? <p className="text-sm text-muted-foreground" data-testid="text-stub-empty">No stub for this employee on this run.</p> : (
            <div className="space-y-1 rounded-md border border-border p-3" data-testid="panel-stub">
              <Row label="Gross" cents={p.grossCents} />
              <Row label="Federal withholding" cents={p.fedWithholdingCents} />
              <Row label="State withholding" cents={p.stateWithholdingCents} />
              <Row label="Social Security" cents={p.ssEmployeeCents} />
              <Row label="Medicare" cents={p.medicareEmployeeCents} />
              <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Net pay</span><span className="tabular-nums" data-testid="text-stub-net">{fmtMoney(p.netCents ?? 0)}</span></div>
            </div>
          )}
        </div>
        <DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function LiabilitiesTab() {
  const { toast } = useToast();
  const { data: liabilities = [] } = useQuery<Liability[]>({ queryKey: ["/api/payroll/liabilities"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const [payDate, setPayDate] = useState(todayISO());
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  useEffect(() => { if (bankAccountId === null && bankAccts[0]) setBankAccountId(bankAccts[0].id); }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const next: Record<number, string> = {};
    for (const l of liabilities) if (l.balanceCents > 0) next[l.accountId] = centsToDollars(l.balanceCents).toString();
    setAmounts(next);
  }, [liabilities.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const payMut = useMutation({
    mutationFn: async () => {
      const lines = liabilities
        .map((l) => ({ accountId: l.accountId, amountCents: Math.round(parseFloat(amounts[l.accountId] || "0") * 100) }))
        .filter((l) => l.amountCents > 0);
      if (lines.length === 0) throw new Error("Enter an amount to remit.");
      return (await apiRequest("POST", "/api/payroll/liabilities/pay", { payDate, bankAccountId, lines })).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/payroll/liabilities"] }); queryClient.invalidateQueries({ queryKey: ["/api/journal"] }); toast({ title: "Liabilities remitted" }); },
    onError: (e: any) => toast({ title: "Remit failed", description: e.message, variant: "destructive" }),
  });

  const anyOwed = liabilities.some((l) => l.balanceCents > 0);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border text-sm font-medium flex items-center gap-2"><Receipt className="h-4 w-4" /> Payroll liabilities</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="text-left px-4 py-2 font-medium">Account</th><th className="text-right px-4 py-2 font-medium">Balance owed</th><th className="text-right px-4 py-2 font-medium w-40">Remit</th></tr>
          </thead>
          <tbody>
            {liabilities.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">No payroll liability accounts.</td></tr>}
            {liabilities.map((l) => (
              <tr key={l.accountId} className="border-t border-border" data-testid={`row-liability-${l.accountId}`}>
                <td className="px-4 py-2">{l.code} {l.name}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(l.balanceCents)}</td>
                <td className="px-4 py-1.5"><Input type="number" step="0.01" className="h-8 text-right" data-testid={`input-liability-amount-${l.accountId}`} value={amounts[l.accountId] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.accountId]: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center gap-3 px-4 py-3 border-t border-border">
          <div><Label className="text-xs text-muted-foreground">Pay date</Label><Input type="date" className="h-8 w-40" data-testid="input-liability-paydate" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></div>
          <div className="flex-1"><Label className="text-xs text-muted-foreground">Pay from</Label>
            <Select value={bankAccountId?.toString() ?? ""} onValueChange={(v) => setBankAccountId(Number(v))}>
              <SelectTrigger className="h-8" data-testid="select-liability-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
              <SelectContent>{bankAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button className="mt-4" disabled={!bankAccountId || !anyOwed || payMut.isPending} onClick={() => payMut.mutate()} data-testid="button-pay-liabilities">{payMut.isPending ? "Remitting…" : "Remit liabilities"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
