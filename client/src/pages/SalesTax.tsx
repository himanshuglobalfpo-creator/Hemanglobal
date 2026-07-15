import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Percent } from "lucide-react";
import type { Account } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, todayISO } from "@/lib/format";

type TaxCode = {
  id: number;
  name: string;
  rate: number;
  agency: string | null;
  liabilityAccountId: number;
  isActive: boolean;
};

type TaxLiabilityRow = {
  taxCodeId: number;
  name: string;
  rate: number;
  agency: string | null;
  collected: number;
};

export default function SalesTax() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState(todayISO());
  const [form, setForm] = useState({
    name: "",
    rate: "",
    agency: "",
    liabilityAccountId: "",
    isActive: true,
  });

  const { data: codes = [] } = useQuery<TaxCode[]>({ queryKey: ["/api/tax-codes"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const liabilityAccounts = accounts.filter((a) => a.type === "liability");

  const { data: report } = useQuery<{ asOfDate: string; rows: TaxLiabilityRow[] }>({
    queryKey: ["/api/reports/tax-liability", asOf],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/reports/tax-liability?asOf=${asOf}`);
      return r.json();
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        rate: parseFloat(form.rate),
        agency: form.agency || null,
        liabilityAccountId: parseInt(form.liabilityAccountId),
        isActive: form.isActive,
      };
      const r = await apiRequest("POST", "/api/tax-codes", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tax-codes"] });
      setOpen(false);
      setForm({ name: "", rate: "", agency: "", liabilityAccountId: "", isActive: true });
      toast({ title: "Tax code created" });
    },
    onError: (e: any) =>
      toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: async (c: TaxCode) =>
      apiRequest("PATCH", `/api/tax-codes/${c.id}`, { isActive: !c.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/tax-codes"] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/tax-codes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tax-codes"] });
      toast({ title: "Tax code deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Cannot delete", description: e.message, variant: "destructive" }),
  });

  return (
    <Layout>
      <PageHeader
        title="Sales Tax"
        description="Manage tax codes and view collected liability"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-tax-code">
                <Plus className="h-4 w-4 mr-1.5" />
                New tax code
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New tax code</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    data-testid="input-tax-name"
                    placeholder="NY State 8.875%"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="rate">Rate (%)</Label>
                    <Input
                      id="rate"
                      type="number"
                      step="0.001"
                      data-testid="input-tax-rate"
                      placeholder="8.875"
                      value={form.rate}
                      onChange={(e) => setForm({ ...form, rate: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="agency">Agency</Label>
                    <Input
                      id="agency"
                      data-testid="input-tax-agency"
                      placeholder="NY DOT"
                      value={form.agency}
                      onChange={(e) => setForm({ ...form, agency: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>Liability account</Label>
                  <Select
                    value={form.liabilityAccountId}
                    onValueChange={(v) => setForm({ ...form, liabilityAccountId: v })}
                  >
                    <SelectTrigger data-testid="select-tax-liability">
                      <SelectValue placeholder="Choose liability account" />
                    </SelectTrigger>
                    <SelectContent>
                      {liabilityAccounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="active">Active</Label>
                  <Switch
                    id="active"
                    checked={form.isActive}
                    onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                    data-testid="switch-tax-active"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => createMut.mutate()}
                  disabled={!form.name || !form.rate || !form.liabilityAccountId || createMut.isPending}
                  data-testid="button-save-tax-code"
                >
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <Tabs defaultValue="codes">
        <TabsList>
          <TabsTrigger value="codes" data-testid="tab-codes">
            Tax codes
          </TabsTrigger>
          <TabsTrigger value="report" data-testid="tab-report">
            Liability report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="codes" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead>Agency</TableHead>
                    <TableHead>Liability account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {codes.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        <Percent className="h-8 w-8 mx-auto mb-2 opacity-30" />
                        No tax codes yet. Create one to charge sales tax on invoices.
                      </TableCell>
                    </TableRow>
                  )}
                  {codes.map((c) => {
                    const acct = accounts.find((a) => a.id === c.liabilityAccountId);
                    return (
                      <TableRow key={c.id} data-testid={`row-tax-code-${c.id}`}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Number(c.rate).toFixed(3)}%
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.agency || "—"}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {acct ? `${acct.code} — ${acct.name}` : "—"}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={c.isActive}
                            onCheckedChange={() => toggleMut.mutate(c)}
                            data-testid={`switch-active-${c.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm(`Delete ${c.name}?`)) deleteMut.mutate(c.id);
                            }}
                            data-testid={`button-delete-tax-${c.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="report" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <CardTitle className="text-base">Tax liability</CardTitle>
              <div className="flex items-center gap-2">
                <Label htmlFor="asof" className="text-xs text-muted-foreground">
                  As of
                </Label>
                <Input
                  id="asof"
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="w-40"
                  data-testid="input-tax-asof"
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tax code</TableHead>
                    <TableHead>Agency</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!report || report.rows.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                        Nothing collected as of {asOf}.
                      </TableCell>
                    </TableRow>
                  )}
                  {report?.rows.map((r) => (
                    <TableRow key={r.taxCodeId} data-testid={`row-tax-liability-${r.taxCodeId}`}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.agency || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(r.rate).toFixed(3)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmtMoney(r.collected)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <div className="mt-6"><FilingPeriods /></div>
    </Layout>
  );
}

// P3.8 — sales-tax filing periods: open → file → pay.
function FilingPeriods() {
  const { toast } = useToast();
  const { data: periods = [] } = useQuery<any[]>({ queryKey: ["/api/tax-filings"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const banks = accounts.filter((a: any) => a.subtype === "bank");
  const [f, setF] = useState({ stateCode: "", cadence: "quarterly", periodStart: "", periodEnd: "" });
  const inv = () => queryClient.invalidateQueries({ queryKey: ["/api/tax-filings"] });

  const create = useMutation({ mutationFn: () => apiRequest("POST", "/api/tax-filings", f), onSuccess: () => { setF({ ...f, stateCode: "" }); inv(); toast({ title: "Filing period opened" }); }, onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }) });
  const file = useMutation({ mutationFn: (id: number) => { const c = window.prompt("Confirmation number?") || ""; if (!c) throw new Error("cancelled"); return apiRequest("POST", `/api/tax-filings/${id}/file`, { confirmationNumber: c }); }, onSuccess: () => { inv(); toast({ title: "Filing recorded" }); }, onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "Failed", description: e.message, variant: "destructive" }); } });
  const pay = useMutation({ mutationFn: ({ id, bankId }: { id: number; bankId: number }) => apiRequest("POST", `/api/tax-filings/${id}/pay`, { bankAccountId: bankId }), onSuccess: () => { inv(); toast({ title: "Payment posted" }); }, onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }) });

  return (
    <Card data-testid="card-tax-filings">
      <CardHeader><CardTitle>Sales-tax filings</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div><Label className="text-xs">State</Label><Input className="w-20" placeholder="CA" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value.toUpperCase().slice(0, 2) })} data-testid="input-filing-state" /></div>
          <div><Label className="text-xs">Cadence</Label>
            <select className="block rounded-md border bg-background px-2 py-1.5 text-sm" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select>
          </div>
          <div><Label className="text-xs">Period start</Label><Input type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} data-testid="input-filing-start" /></div>
          <div><Label className="text-xs">Period end</Label><Input type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} data-testid="input-filing-end" /></div>
          <Button disabled={!f.stateCode || !f.periodStart || !f.periodEnd || create.isPending} onClick={() => create.mutate()} data-testid="button-open-filing">Open period</Button>
        </div>
        <div className="space-y-1">
          {periods.length === 0 && <p className="text-sm text-muted-foreground">No filing periods yet.</p>}
          {periods.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm" data-testid={`filing-row-${p.id}`}>
              <span className="font-medium">{p.stateCode}</span>
              <span className="text-muted-foreground">{p.periodStart} → {p.periodEnd} · due {p.dueDate}</span>
              <span>{fmtMoney(p.status === "open" ? p.liveLiability : p.liabilityCents)}</span>
              <span className={`rounded px-1.5 py-0.5 text-xs ${p.status === "paid" ? "bg-green-100 text-green-800" : p.status === "filed" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"}`}>{p.status}</span>
              <div className="ml-auto flex items-center gap-2">
                {p.status !== "paid" && <button className="text-xs underline" onClick={() => file.mutate(p.id)} data-testid={`button-file-${p.id}`}>Record filing</button>}
                {p.status !== "paid" && banks[0] && <button className="text-xs underline" onClick={() => pay.mutate({ id: p.id, bankId: banks[0].id })} data-testid={`button-pay-${p.id}`}>Record payment</button>}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
