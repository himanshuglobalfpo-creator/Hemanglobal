// ============================================================================
// CREDIT NOTES (AR) — /credit-notes
// ============================================================================
// List + create against a customer + apply/unapply to open invoices + void,
// with the customer's live credit balance. Over /api/credit-notes and
// /api/customers/:id/credit-balance. Money is integer cents from the server;
// the apply amount is entered in dollars (server converts).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Ban, Layers } from "lucide-react";
import type { Account, Customer } from "@shared/schema";
import { useOpenOnCreateParam } from "@/lib/create-shortcut";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, todayISO, centsToDollars } from "@/lib/format";

type CreditNote = {
  id: number; number: string; customerId: number; customerName?: string;
  date: string; status: string; total: number; appliedAmount: number; remainingCredit: number; reason: string;
};
type Invoice = { id: number; number: string; customerId: number; total: number; amountPaid: number; status: string };
interface Line { description: string; quantity: number; rate: number; revenueAccountId: number | null; }

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  applied: "default", issued: "secondary", draft: "secondary", void: "destructive",
};

export default function CreditNotes() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [manageId, setManageId] = useState<number | null>(null);

  const { data: notes = [] } = useQuery<CreditNote[]>({ queryKey: ["/api/credit-notes"] });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const incomeAccts = accounts.filter((a) => a.type === "income");

  const [form, setForm] = useState({
    customerId: null as number | null, date: todayISO(), reason: "", taxRate: 0,
    lines: [{ description: "", quantity: 1, rate: 0, revenueAccountId: null }] as Line[],
  });

  function openCreate() {
    setForm({ customerId: null, date: todayISO(), reason: "", taxRate: 0, lines: [{ description: "", quantity: 1, rate: 0, revenueAccountId: incomeAccts[0]?.id ?? null }] });
    setOpen(true);
  }
  useOpenOnCreateParam(openCreate);
  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, lines: f.lines.map((l) => ({ ...l, revenueAccountId: l.revenueAccountId ?? incomeAccts[0]?.id ?? null })) }));
  }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        customerId: form.customerId, date: form.date, reason: form.reason, taxRate: form.taxRate,
        lines: form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, revenueAccountId: l.revenueAccountId })),
      };
      return (await apiRequest("POST", "/api/credit-notes", body)).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/credit-notes"] }); setOpen(false); toast({ title: "Credit note created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const voidMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/credit-notes/${id}/void`, { reason: "Voided from UI" })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/credit-notes"] }); toast({ title: "Credit note voided" }); },
    onError: (e: any) => toast({ title: "Void failed", description: e.message, variant: "destructive" }),
  });

  const subtotal = form.lines.reduce((s, l) => s + Math.round((l.quantity || 0) * (l.rate || 0) * 100), 0);
  const total = subtotal + Math.round((subtotal * (form.taxRate || 0)) / 100);

  return (
    <Layout>
      <PageHeader
        title="Credit notes"
        description="Issue customer credit and apply it to open invoices"
        actions={<Button onClick={openCreate} data-testid="button-new-credit-note"><Plus className="h-4 w-4 mr-1.5" />New credit note</Button>}
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium text-right">Remaining</th>
                <th className="px-4 py-3 font-medium w-44"></th>
              </tr>
            </thead>
            <tbody>
              {notes.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No credit notes yet.</td></tr>}
              {notes.map((n) => (
                <tr key={n.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-credit-note-${n.id}`}>
                  <td className="px-4 py-3 font-medium">{n.number}</td>
                  <td className="px-4 py-3">{n.customerName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(n.date)}</td>
                  <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[n.status] ?? "secondary"} className="capitalize">{n.status}</Badge></td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(n.total)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(n.remainingCredit)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {n.status !== "void" && (
                        <Button size="sm" variant="outline" onClick={() => setManageId(n.id)} data-testid={`button-manage-credit-note-${n.id}`}>
                          <Layers className="h-3.5 w-3.5 mr-1" />Apply
                        </Button>
                      )}
                      {n.status !== "void" && n.appliedAmount === 0 && (
                        <Button size="sm" variant="ghost" onClick={() => voidMut.mutate(n.id)} data-testid={`button-void-credit-note-${n.id}`} title="Void">
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New credit note</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Customer</Label>
                <Select value={form.customerId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, customerId: Number(v) })}>
                  <SelectTrigger data-testid="select-credit-note-customer"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{customers.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Date</Label><Input type="date" data-testid="input-credit-note-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
              <div><Label>Reason</Label><Input data-testid="input-credit-note-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Returned goods" /></div>
            </div>
            <div>
              <Label>Line items</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-left px-3 py-2 font-medium w-40">Revenue account</th>
                      <th className="text-right px-3 py-2 font-medium w-20">Qty</th>
                      <th className="text-right px-3 py-2 font-medium w-24">Rate</th>
                      <th className="text-right px-3 py-2 font-medium w-28">Amount</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="px-2 py-1"><Input data-testid={`input-credit-note-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1">
                          <Select value={l.revenueAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].revenueAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-credit-note-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{incomeAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-credit-note-line-qty-${idx}`} value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-credit-note-line-rate-${idx}`} value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.round(l.quantity * l.rate * 100))}</td>
                        <td className="px-2 py-1">{form.lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })}><Trash2 className="h-4 w-4" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, revenueAccountId: incomeAccts[0]?.id ?? null }] })} data-testid="button-add-credit-note-line">
                <Plus className="h-4 w-4 mr-1" />Add line
              </Button>
            </div>
            <div className="flex justify-end">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground">Tax %</span><Input type="number" step="0.01" className="w-20 h-8 text-right" data-testid="input-credit-note-tax" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} /></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.customerId || !form.reason || form.lines.some((l) => !l.description || !l.revenueAccountId) || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-credit-note">
              {createMut.isPending ? "Saving…" : "Create credit note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {manageId !== null && (
        <ApplyCreditDialog noteId={manageId} onClose={() => setManageId(null)} />
      )}
    </Layout>
  );
}

// Apply / unapply a credit note against the customer's open invoices.
function ApplyCreditDialog({ noteId, onClose }: { noteId: number; onClose: () => void }) {
  const { toast } = useToast();
  const { data: note } = useQuery<any>({ queryKey: ["/api/credit-notes", noteId], queryFn: async () => (await apiRequest("GET", `/api/credit-notes/${noteId}`)).json() });
  const { data: invRaw } = useQuery<any>({ queryKey: ["/api/invoices"], queryFn: async () => (await apiRequest("GET", "/api/invoices")).json() });
  const invoices: Invoice[] = Array.isArray(invRaw) ? invRaw : invRaw?.rows ?? [];
  const { data: balance } = useQuery<any>({
    queryKey: ["/api/customers", note?.customerId, "credit-balance"],
    queryFn: async () => (await apiRequest("GET", `/api/customers/${note.customerId}/credit-balance`)).json(),
    enabled: !!note?.customerId,
  });

  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");

  const openInvoices = invoices.filter((i) => i.customerId === note?.customerId && i.status !== "void" && i.total - i.amountPaid > 0);

  const applyMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/credit-notes/${noteId}/apply`, { invoiceId, amountToApply: parseFloat(amount) })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/credit-notes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      setAmount(""); toast({ title: "Credit applied" });
    },
    onError: (e: any) => toast({ title: "Apply failed", description: e.message, variant: "destructive" }),
  });
  const unapplyMut = useMutation({
    mutationFn: async (applicationId: number) => (await apiRequest("POST", `/api/credit-notes/${noteId}/unapply`, { applicationId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/credit-notes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      toast({ title: "Application reversed" });
    },
    onError: (e: any) => toast({ title: "Unapply failed", description: e.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (invoiceId === null && openInvoices.length > 0) setInvoiceId(openInvoices[0].id);
  }, [openInvoices, invoiceId]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Apply credit — {note?.number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Remaining credit on this note: <span className="font-medium text-foreground tabular-nums" data-testid="text-note-remaining">{fmtMoney(note?.remainingCredit ?? 0)}</span>
            {balance && <> · Customer credit balance: <span className="tabular-nums" data-testid="text-customer-credit-balance">{fmtMoney(balance.creditBalance)}</span></>}
          </div>

          {note?.applications?.length > 0 && (
            <div className="rounded-md border border-border">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground border-b border-border">Applied to</div>
              {note.applications.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between px-3 py-1.5 text-sm border-b border-border last:border-0" data-testid={`row-application-${a.id}`}>
                  <span>{a.invoiceNumber}</span>
                  <span className="flex items-center gap-2"><span className="tabular-nums">{fmtMoney(a.amountApplied ?? a.amount ?? 0)}</span>
                    <Button size="sm" variant="ghost" onClick={() => unapplyMut.mutate(a.id)} data-testid={`button-unapply-${a.id}`}>Unapply</Button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {note?.remainingCredit > 0 && (
            <>
              <div>
                <Label>Open invoice</Label>
                {openInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open invoices for this customer.</p>
                ) : (
                  <Select value={invoiceId?.toString() ?? ""} onValueChange={(v) => setInvoiceId(Number(v))}>
                    <SelectTrigger data-testid="select-apply-invoice"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {openInvoices.map((i) => <SelectItem key={i.id} value={i.id.toString()}>{i.number} · bal {fmtMoney(i.total - i.amountPaid)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <Label>Amount to apply</Label>
                <Input type="number" step="0.01" data-testid="input-apply-amount" value={amount} onChange={(e) => setAmount(e.target.value)}
                  placeholder={note ? centsToDollars(Math.min(note.remainingCredit, (openInvoices.find((i) => i.id === invoiceId)?.total ?? 0) - (openInvoices.find((i) => i.id === invoiceId)?.amountPaid ?? 0))).toString() : ""} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {note?.remainingCredit > 0 && (
            <Button disabled={!invoiceId || !(parseFloat(amount) > 0) || applyMut.isPending} onClick={() => applyMut.mutate()} data-testid="button-apply-credit">
              {applyMut.isPending ? "Applying…" : "Apply credit"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
