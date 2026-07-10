import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Repeat, Play, RefreshCw } from "lucide-react";
import type { Account, Customer, Vendor, RecurringTemplate } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Kind = "invoice" | "bill" | "journal";
type Freq = "daily" | "weekly" | "monthly" | "yearly";

type Line = { description: string; quantity: string; rate: string; accountId: string };
type JLine = { accountId: string; debit: string; credit: string; description: string };

type Form = {
  name: string;
  kind: Kind;
  frequency: Freq;
  intervalCount: string;
  startDate: string;
  endDate: string;
  maxOccurrences: string;
  // Invoice/Bill payload
  partyId: string; // customerId or vendorId
  dueDateOffsetDays: string;
  taxRate: string;
  lines: Line[];
  // Journal payload
  journalMemo: string;
  journalLines: JLine[];
};

const today = () => new Date().toISOString().slice(0, 10);

const blankForm: Form = {
  name: "",
  kind: "bill",
  frequency: "monthly",
  intervalCount: "1",
  startDate: today(),
  endDate: "",
  maxOccurrences: "",
  partyId: "",
  dueDateOffsetDays: "30",
  taxRate: "0",
  lines: [{ description: "", quantity: "1", rate: "", accountId: "" }],
  journalMemo: "",
  journalLines: [
    { accountId: "", debit: "", credit: "0", description: "" },
    { accountId: "", debit: "0", credit: "", description: "" },
  ],
};

export default function Recurring() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(blankForm);

  const { data: templates = [] } = useQuery<RecurringTemplate[]>({ queryKey: ["/api/recurring"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: vendors = [] } = useQuery<Vendor[]>({ queryKey: ["/api/vendors"] });

  const incomeAccts = accounts.filter((a) => a.type === "income");
  const expenseAccts = accounts.filter((a) => a.type === "expense");
  const allAccts = accounts;

  function reset() {
    setForm(blankForm);
  }

  const createMut = useMutation({
    mutationFn: async (f: Form) => {
      let payload: any = {};
      if (f.kind === "invoice") {
        payload = {
          customerId: Number(f.partyId),
          dueDateOffsetDays: Number(f.dueDateOffsetDays) || 30,
          taxRate: Number(f.taxRate) || 0,
          lines: f.lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity) || 1,
            rate: Number(l.rate) || 0,
            incomeAccountId: Number(l.accountId),
          })),
        };
      } else if (f.kind === "bill") {
        payload = {
          vendorId: Number(f.partyId),
          dueDateOffsetDays: Number(f.dueDateOffsetDays) || 30,
          taxRate: Number(f.taxRate) || 0,
          lines: f.lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity) || 1,
            rate: Number(l.rate) || 0,
            expenseAccountId: Number(l.accountId),
          })),
        };
      } else {
        payload = {
          memo: f.journalMemo || f.name,
          lines: f.journalLines.map((l) => ({
            accountId: Number(l.accountId),
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
            description: l.description,
          })),
        };
      }
      const body = {
        name: f.name,
        kind: f.kind,
        frequency: f.frequency,
        intervalCount: Number(f.intervalCount) || 1,
        startDate: f.startDate,
        endDate: f.endDate || undefined,
        maxOccurrences: f.maxOccurrences ? Number(f.maxOccurrences) : undefined,
        payload,
      };
      const r = await apiRequest("POST", "/api/recurring", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring"] });
      setOpen(false);
      reset();
      toast({ title: "Template created" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/recurring/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/recurring"] }),
  });

  const runOneMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("POST", `/api/recurring/${id}/run`, {});
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      toast({ title: "Posted occurrence" });
    },
    onError: (e: any) => toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  const catchupMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/recurring/run-catchup", {});
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      const total = Array.isArray(data) ? data.reduce((s: number, r: any) => s + r.posted, 0) : 0;
      toast({
        title: "Catch-up done",
        description: total > 0 ? `Posted ${total} occurrence(s).` : "Nothing was due.",
      });
    },
  });

  const dueCount = templates.filter(
    (t) => t.isActive && t.nextRunDate <= today()
  ).length;

  const acctName = (id: number | undefined | null) => {
    if (!id) return "—";
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : `#${id}`;
  };

  function setLine(idx: number, patch: Partial<Line>) {
    const next = [...form.lines];
    next[idx] = { ...next[idx], ...patch };
    setForm({ ...form, lines: next });
  }
  function setJLine(idx: number, patch: Partial<JLine>) {
    const next = [...form.journalLines];
    next[idx] = { ...next[idx], ...patch };
    setForm({ ...form, journalLines: next });
  }

  const lineAccts = form.kind === "invoice" ? incomeAccts : form.kind === "bill" ? expenseAccts : allAccts;

  return (
    <Layout>
      <PageHeader
        title="Recurring transactions"
        description="Set up templates that auto-post on a schedule. Catch-up runs on app load."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => catchupMut.mutate()}
              disabled={catchupMut.isPending}
              data-testid="button-catchup"
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              {catchupMut.isPending ? "Catching up…" : `Catch up due${dueCount > 0 ? ` (${dueCount})` : ""}`}
            </Button>
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
              <DialogTrigger asChild>
                <Button data-testid="button-new-recurring">
                  <Plus className="h-4 w-4 mr-1.5" />
                  New template
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>New recurring template</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <Label>Template name</Label>
                      <Input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="e.g. WeWork monthly rent"
                        data-testid="input-rec-name"
                      />
                    </div>
                    <div>
                      <Label>Kind</Label>
                      <Select value={form.kind} onValueChange={(v: Kind) => setForm({ ...form, kind: v })}>
                        <SelectTrigger data-testid="select-rec-kind"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="invoice">Invoice (A/R)</SelectItem>
                          <SelectItem value="bill">Bill (A/P)</SelectItem>
                          <SelectItem value="journal">Journal entry</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <Label>Frequency</Label>
                      <Select value={form.frequency} onValueChange={(v: Freq) => setForm({ ...form, frequency: v })}>
                        <SelectTrigger data-testid="select-rec-freq"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                          <SelectItem value="yearly">Yearly</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Every</Label>
                      <Input
                        type="number"
                        min="1"
                        value={form.intervalCount}
                        onChange={(e) => setForm({ ...form, intervalCount: e.target.value })}
                        data-testid="input-rec-interval"
                      />
                    </div>
                    <div>
                      <Label>Start date</Label>
                      <Input
                        type="date"
                        value={form.startDate}
                        onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                        data-testid="input-rec-start"
                      />
                    </div>
                    <div>
                      <Label>End date (opt)</Label>
                      <Input
                        type="date"
                        value={form.endDate}
                        onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                        data-testid="input-rec-end"
                      />
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    {form.kind === "invoice" && (
                      <>
                        <div className="grid grid-cols-3 gap-3 mb-3">
                          <div>
                            <Label>Customer</Label>
                            <Select
                              value={form.partyId}
                              onValueChange={(v) => setForm({ ...form, partyId: v })}
                            >
                              <SelectTrigger data-testid="select-rec-customer"><SelectValue placeholder="Pick" /></SelectTrigger>
                              <SelectContent>
                                {customers.map((c) => (
                                  <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label>Due in (days)</Label>
                            <Input type="number" value={form.dueDateOffsetDays} onChange={(e) => setForm({ ...form, dueDateOffsetDays: e.target.value })} />
                          </div>
                          <div>
                            <Label>Tax %</Label>
                            <Input type="number" step="0.01" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
                          </div>
                        </div>
                      </>
                    )}
                    {form.kind === "bill" && (
                      <>
                        <div className="grid grid-cols-3 gap-3 mb-3">
                          <div>
                            <Label>Vendor</Label>
                            <Select
                              value={form.partyId}
                              onValueChange={(v) => setForm({ ...form, partyId: v })}
                            >
                              <SelectTrigger data-testid="select-rec-vendor"><SelectValue placeholder="Pick" /></SelectTrigger>
                              <SelectContent>
                                {vendors.map((c) => (
                                  <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label>Due in (days)</Label>
                            <Input type="number" value={form.dueDateOffsetDays} onChange={(e) => setForm({ ...form, dueDateOffsetDays: e.target.value })} />
                          </div>
                          <div>
                            <Label>Tax %</Label>
                            <Input type="number" step="0.01" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
                          </div>
                        </div>
                      </>
                    )}

                    {(form.kind === "invoice" || form.kind === "bill") && (
                      <>
                        <Label>Line items</Label>
                        <div className="space-y-2 mt-1">
                          {form.lines.map((l, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
                              <Input
                                className="col-span-4"
                                placeholder="Description"
                                value={l.description}
                                onChange={(e) => setLine(idx, { description: e.target.value })}
                              />
                              <Input
                                className="col-span-1"
                                placeholder="Qty"
                                type="number"
                                step="0.01"
                                value={l.quantity}
                                onChange={(e) => setLine(idx, { quantity: e.target.value })}
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Rate"
                                type="number"
                                step="0.01"
                                value={l.rate}
                                onChange={(e) => setLine(idx, { rate: e.target.value })}
                              />
                              <div className="col-span-4">
                                <Select value={l.accountId} onValueChange={(v) => setLine(idx, { accountId: v })}>
                                  <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
                                  <SelectContent>
                                    {lineAccts.map((a) => (
                                      <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="col-span-1"
                                onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })}
                                disabled={form.lines.length === 1}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() =>
                            setForm({
                              ...form,
                              lines: [...form.lines, { description: "", quantity: "1", rate: "", accountId: "" }],
                            })
                          }
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" /> Add line
                        </Button>
                      </>
                    )}

                    {form.kind === "journal" && (
                      <>
                        <Label>Memo</Label>
                        <Input
                          value={form.journalMemo}
                          onChange={(e) => setForm({ ...form, journalMemo: e.target.value })}
                          placeholder="Journal memo"
                          className="mb-3"
                        />
                        <Label>Lines (debits = credits)</Label>
                        <div className="space-y-2 mt-1">
                          {form.journalLines.map((l, idx) => (
                            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
                              <div className="col-span-5">
                                <Select value={l.accountId} onValueChange={(v) => setJLine(idx, { accountId: v })}>
                                  <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
                                  <SelectContent>
                                    {allAccts.map((a) => (
                                      <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <Input
                                className="col-span-2"
                                placeholder="Debit"
                                type="number"
                                step="0.01"
                                value={l.debit}
                                onChange={(e) => setJLine(idx, { debit: e.target.value })}
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Credit"
                                type="number"
                                step="0.01"
                                value={l.credit}
                                onChange={(e) => setJLine(idx, { credit: e.target.value })}
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Memo"
                                value={l.description}
                                onChange={(e) => setJLine(idx, { description: e.target.value })}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="col-span-1"
                                onClick={() => setForm({ ...form, journalLines: form.journalLines.filter((_, i) => i !== idx) })}
                                disabled={form.journalLines.length <= 2}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() =>
                            setForm({
                              ...form,
                              journalLines: [...form.journalLines, { accountId: "", debit: "0", credit: "0", description: "" }],
                            })
                          }
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" /> Add line
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <DialogFooter>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button
                    disabled={!form.name || createMut.isPending}
                    onClick={() => createMut.mutate(form)}
                    data-testid="button-save-recurring"
                  >
                    {createMut.isPending ? "Saving…" : "Create template"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Schedule</th>
                <th className="px-4 py-3 font-medium">Next run</th>
                <th className="px-4 py-3 font-medium text-right">Posted</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <Repeat className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No recurring templates yet.
                  </td>
                </tr>
              )}
              {templates.map((t) => {
                const due = t.isActive && t.nextRunDate <= today();
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-recurring-${t.id}`}>
                    <td className="px-4 py-3 font-medium">{t.name}</td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{t.kind}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      Every {t.intervalCount > 1 ? t.intervalCount : ""} {t.frequency}
                    </td>
                    <td className={"px-4 py-3 tabular-nums " + (due ? "text-amber-700 dark:text-amber-400 font-medium" : "")}>
                      {t.nextRunDate}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {t.occurrencesPosted}
                      {t.maxOccurrences ? ` / ${t.maxOccurrences}` : ""}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          t.isActive
                            ? "text-xs px-2 py-0.5 rounded bg-primary/15 text-primary"
                            : "text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                        }
                      >
                        {t.isActive ? "Active" : "Stopped"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        {t.isActive && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => runOneMut.mutate(t.id)}
                            data-testid={`button-run-${t.id}`}
                            title="Run once now"
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(`Delete template "${t.name}"?`)) delMut.mutate(t.id);
                          }}
                          data-testid={`button-delete-recurring-${t.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </Layout>
  );
}
