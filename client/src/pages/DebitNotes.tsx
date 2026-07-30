// ============================================================================
// DEBIT NOTES (AP) — /debit-notes  (mirror of credit notes, under Bills)
// ============================================================================
// List + create against a vendor + apply/unapply to open bills + void, over
// /api/debit-notes. Money is integer cents from the server; the apply amount is
// entered in dollars (server converts).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Ban, Layers } from "lucide-react";
import type { Account } from "@shared/schema";
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
import { fmtMoney, fmtDate, todayISO } from "@/lib/format";

type DebitNote = { id: number; number: string; vendorId: number; vendorName?: string; date: string; status: string; total: number; appliedAmount: number; remainingDebit: number };
type Bill = { id: number; number: string; vendorId: number; total: number; amountPaid: number; status: string };
interface Line { description: string; quantity: number; rate: number; expenseAccountId: number | null; }

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  accepted: "default", sent: "secondary", draft: "secondary", void: "destructive",
};

export default function DebitNotes() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [manageId, setManageId] = useState<number | null>(null);

  const { data: notes = [] } = useQuery<DebitNote[]>({ queryKey: ["/api/debit-notes"] });
  const { data: vendors = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/vendors"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const expenseAccts = accounts.filter((a) => a.type === "expense");

  const [form, setForm] = useState({
    vendorId: null as number | null, date: todayISO(), reason: "", taxRate: 0,
    lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: null }] as Line[],
  });

  function openCreate() {
    setForm({ vendorId: null, date: todayISO(), reason: "", taxRate: 0, lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }] });
    setOpen(true);
  }
  useOpenOnCreateParam(openCreate);
  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, lines: f.lines.map((l) => ({ ...l, expenseAccountId: l.expenseAccountId ?? expenseAccts[0]?.id ?? null })) }));
  }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        vendorId: form.vendorId, date: form.date, reason: form.reason, taxRate: form.taxRate,
        lines: form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, expenseAccountId: l.expenseAccountId })),
      };
      return (await apiRequest("POST", "/api/debit-notes", body)).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/debit-notes"] }); setOpen(false); toast({ title: "Debit note created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const voidMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/debit-notes/${id}/void`, { reason: "Voided from UI" })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/debit-notes"] }); toast({ title: "Debit note voided" }); },
    onError: (e: any) => toast({ title: "Void failed", description: e.message, variant: "destructive" }),
  });

  const subtotal = form.lines.reduce((s, l) => s + Math.round((l.quantity || 0) * (l.rate || 0) * 100), 0);
  const total = subtotal + Math.round((subtotal * (form.taxRate || 0)) / 100);

  return (
    <Layout>
      <PageHeader
        title="Debit notes"
        description="Record vendor debits and apply them to open bills"
        actions={<Button onClick={openCreate} data-testid="button-new-debit-note"><Plus className="h-4 w-4 mr-1.5" />New debit note</Button>}
      />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th><th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Total</th><th className="px-4 py-3 font-medium text-right">Remaining</th>
                <th className="px-4 py-3 font-medium w-44"></th>
              </tr>
            </thead>
            <tbody>
              {notes.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No debit notes yet.</td></tr>}
              {notes.map((n) => (
                <tr key={n.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-debit-note-${n.id}`}>
                  <td className="px-4 py-3 font-medium">{n.number}</td>
                  <td className="px-4 py-3">{n.vendorName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(n.date)}</td>
                  <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[n.status] ?? "secondary"} className="capitalize">{n.status}</Badge></td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(n.total)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(n.remainingDebit)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {n.status !== "void" && <Button size="sm" variant="outline" onClick={() => setManageId(n.id)} data-testid={`button-manage-debit-note-${n.id}`}><Layers className="h-3.5 w-3.5 mr-1" />Apply</Button>}
                      {n.status !== "void" && n.appliedAmount === 0 && <Button size="sm" variant="ghost" onClick={() => voidMut.mutate(n.id)} data-testid={`button-void-debit-note-${n.id}`} title="Void"><Ban className="h-4 w-4" /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New debit note</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Vendor</Label>
                <Select value={form.vendorId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, vendorId: Number(v) })}>
                  <SelectTrigger data-testid="select-debit-note-vendor"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{vendors.map((v) => <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Date</Label><Input type="date" data-testid="input-debit-note-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
              <div><Label>Reason</Label><Input data-testid="input-debit-note-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Returned stock" /></div>
            </div>
            <div>
              <Label>Line items</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr><th className="text-left px-3 py-2 font-medium">Description</th><th className="text-left px-3 py-2 font-medium w-40">Expense account</th><th className="text-right px-3 py-2 font-medium w-20">Qty</th><th className="text-right px-3 py-2 font-medium w-24">Rate</th><th className="text-right px-3 py-2 font-medium w-28">Amount</th><th className="w-10"></th></tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="px-2 py-1"><Input data-testid={`input-debit-note-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1">
                          <Select value={l.expenseAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].expenseAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-debit-note-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{expenseAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-debit-note-line-qty-${idx}`} value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-debit-note-line-rate-${idx}`} value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.round(l.quantity * l.rate * 100))}</td>
                        <td className="px-2 py-1">{form.lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })}><Trash2 className="h-4 w-4" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }] })} data-testid="button-add-debit-note-line">
                <Plus className="h-4 w-4 mr-1" />Add line
              </Button>
            </div>
            <div className="flex justify-end">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground">Tax %</span><Input type="number" step="0.01" className="w-20 h-8 text-right" data-testid="input-debit-note-tax" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} /></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.vendorId || !form.reason || form.lines.some((l) => !l.description || !l.expenseAccountId) || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-debit-note">
              {createMut.isPending ? "Saving…" : "Create debit note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {manageId !== null && <ApplyDebitDialog noteId={manageId} onClose={() => setManageId(null)} />}
    </Layout>
  );
}

function ApplyDebitDialog({ noteId, onClose }: { noteId: number; onClose: () => void }) {
  const { toast } = useToast();
  const { data: note } = useQuery<any>({ queryKey: ["/api/debit-notes", noteId], queryFn: async () => (await apiRequest("GET", `/api/debit-notes/${noteId}`)).json() });
  const { data: billRaw } = useQuery<any>({ queryKey: ["/api/bills"], queryFn: async () => (await apiRequest("GET", "/api/bills")).json() });
  const bills: Bill[] = Array.isArray(billRaw) ? billRaw : billRaw?.rows ?? [];
  const [billId, setBillId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const openBills = bills.filter((b) => b.vendorId === note?.vendorId && b.status !== "void" && b.total - b.amountPaid > 0);

  const applyMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/debit-notes/${noteId}/apply`, { billId, amountToApply: parseFloat(amount) })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/debit-notes"] }); queryClient.invalidateQueries({ queryKey: ["/api/bills"] }); setAmount(""); toast({ title: "Debit applied" }); },
    onError: (e: any) => toast({ title: "Apply failed", description: e.message, variant: "destructive" }),
  });
  const unapplyMut = useMutation({
    mutationFn: async (applicationId: number) => (await apiRequest("POST", `/api/debit-notes/${noteId}/unapply`, { applicationId })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/debit-notes"] }); queryClient.invalidateQueries({ queryKey: ["/api/bills"] }); toast({ title: "Application reversed" }); },
    onError: (e: any) => toast({ title: "Unapply failed", description: e.message, variant: "destructive" }),
  });
  useEffect(() => { if (billId === null && openBills.length > 0) setBillId(openBills[0].id); }, [openBills, billId]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Apply debit — {note?.number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">Remaining on this note: <span className="font-medium text-foreground tabular-nums" data-testid="text-debit-remaining">{fmtMoney(note?.remainingDebit ?? 0)}</span></div>
          {note?.applications?.length > 0 && (
            <div className="rounded-md border border-border">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground border-b border-border">Applied to</div>
              {note.applications.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between px-3 py-1.5 text-sm border-b border-border last:border-0" data-testid={`row-debit-application-${a.id}`}>
                  <span>{a.billNumber}</span>
                  <span className="flex items-center gap-2"><span className="tabular-nums">{fmtMoney(a.amountApplied ?? a.amount ?? 0)}</span>
                    <Button size="sm" variant="ghost" onClick={() => unapplyMut.mutate(a.id)} data-testid={`button-debit-unapply-${a.id}`}>Unapply</Button></span>
                </div>
              ))}
            </div>
          )}
          {note?.remainingDebit > 0 && (
            <>
              <div>
                <Label>Open bill</Label>
                {openBills.length === 0 ? <p className="text-sm text-muted-foreground">No open bills for this vendor.</p> : (
                  <Select value={billId?.toString() ?? ""} onValueChange={(v) => setBillId(Number(v))}>
                    <SelectTrigger data-testid="select-apply-bill"><SelectValue /></SelectTrigger>
                    <SelectContent>{openBills.map((b) => <SelectItem key={b.id} value={b.id.toString()}>{b.number} · bal {fmtMoney(b.total - b.amountPaid)}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
              <div><Label>Amount to apply</Label><Input type="number" step="0.01" data-testid="input-apply-debit-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {note?.remainingDebit > 0 && <Button disabled={!billId || !(parseFloat(amount) > 0) || applyMut.isPending} onClick={() => applyMut.mutate()} data-testid="button-apply-debit">{applyMut.isPending ? "Applying…" : "Apply debit"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
