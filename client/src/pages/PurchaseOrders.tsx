// ============================================================================
// PURCHASE ORDERS — /purchase-orders
// ============================================================================
// List + create (line editor) + receive (per-line whole-unit quantities, which
// posts a bill) over /api/purchase-orders. Money is integer cents on lines
// (amountCents); rate is entered in dollars.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, PackageCheck } from "lucide-react";
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

type PO = { id: number; number: string; vendorId: number; vendorName?: string; date: string; expectedDate?: string | null; status: string };
interface Line { description: string; quantity: number; rate: number; expenseAccountId: number | null; }

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  received: "default", partial: "secondary", open: "secondary", closed: "outline", cancelled: "destructive",
};

export default function PurchaseOrders() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [receiveId, setReceiveId] = useState<number | null>(null);

  const { data: poRaw } = useQuery<any>({ queryKey: ["/api/purchase-orders"], queryFn: async () => (await apiRequest("GET", "/api/purchase-orders?limit=200")).json() });
  const pos: PO[] = Array.isArray(poRaw) ? poRaw : poRaw?.rows ?? [];
  const { data: vendors = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/vendors"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const expenseAccts = accounts.filter((a) => a.type === "expense");

  const [form, setForm] = useState({
    vendorId: null as number | null, date: todayISO(), expectedDate: "",
    lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: null }] as Line[],
  });

  function openCreate() {
    setForm({ vendorId: null, date: todayISO(), expectedDate: "", lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }] });
    setOpen(true);
  }
  useOpenOnCreateParam(openCreate);
  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, lines: f.lines.map((l) => ({ ...l, expenseAccountId: l.expenseAccountId ?? expenseAccts[0]?.id ?? null })) }));
  }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        vendorId: form.vendorId, date: form.date,
        expectedDate: form.expectedDate || undefined,
        lines: form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, expenseAccountId: l.expenseAccountId })),
      };
      return (await apiRequest("POST", "/api/purchase-orders", body)).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] }); setOpen(false); toast({ title: "Purchase order created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const subtotal = form.lines.reduce((s, l) => s + Math.round((l.quantity || 0) * (l.rate || 0) * 100), 0);

  return (
    <Layout>
      <PageHeader
        title="Purchase orders"
        description="Order from vendors, then receive against the PO to create a bill"
        actions={<Button onClick={openCreate} data-testid="button-new-po"><Plus className="h-4 w-4 mr-1.5" />New purchase order</Button>}
      />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th><th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Expected</th>
                <th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody>
              {pos.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No purchase orders yet.</td></tr>}
              {pos.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-po-${p.id}`}>
                  <td className="px-4 py-3 font-medium">{p.number}</td>
                  <td className="px-4 py-3">{p.vendorName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(p.date)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.expectedDate ? fmtDate(p.expectedDate) : "—"}</td>
                  <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[p.status] ?? "secondary"} className="capitalize">{p.status}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    {(p.status === "open" || p.status === "partial") && (
                      <Button size="sm" variant="outline" onClick={() => setReceiveId(p.id)} data-testid={`button-receive-po-${p.id}`}>
                        <PackageCheck className="h-3.5 w-3.5 mr-1" />Receive
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Vendor</Label>
                <Select value={form.vendorId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, vendorId: Number(v) })}>
                  <SelectTrigger data-testid="select-po-vendor"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{vendors.map((v) => <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Date</Label><Input type="date" data-testid="input-po-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
              <div><Label>Expected date</Label><Input type="date" data-testid="input-po-expected" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} /></div>
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
                        <td className="px-2 py-1"><Input data-testid={`input-po-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1">
                          <Select value={l.expenseAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].expenseAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-po-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{expenseAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1"><Input type="number" step="1" className="text-right" data-testid={`input-po-line-qty-${idx}`} value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-po-line-rate-${idx}`} value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.round(l.quantity * l.rate * 100))}</td>
                        <td className="px-2 py-1">{form.lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })}><Trash2 className="h-4 w-4" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-2">
                <Button variant="outline" size="sm" onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }] })} data-testid="button-add-po-line"><Plus className="h-4 w-4 mr-1" />Add line</Button>
                <span className="text-sm">Total <span className="font-semibold tabular-nums">{fmtMoney(subtotal)}</span></span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.vendorId || form.lines.some((l) => !l.description || !l.expenseAccountId) || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-po">
              {createMut.isPending ? "Saving…" : "Create purchase order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {receiveId !== null && <ReceiveDialog poId={receiveId} onClose={() => setReceiveId(null)} />}
    </Layout>
  );
}

// Receive whole-unit quantities per PO line → posts a bill for this receipt.
function ReceiveDialog({ poId, onClose }: { poId: number; onClose: () => void }) {
  const { toast } = useToast();
  const { data: po } = useQuery<any>({ queryKey: ["/api/purchase-orders", poId], queryFn: async () => (await apiRequest("GET", `/api/purchase-orders/${poId}`)).json() });
  const [date, setDate] = useState(todayISO());
  const [qtys, setQtys] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!po) return;
    const next: Record<number, string> = {};
    for (const l of po.lines) next[l.id] = String(Math.max(0, l.quantity - l.qtyReceived)); // default to remaining
    setQtys(next);
  }, [po?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const receiveMut = useMutation({
    mutationFn: async () => {
      const lines = (po?.lines ?? [])
        .map((l: any) => ({ poLineId: l.id, quantity: parseInt(qtys[l.id] || "0", 10) }))
        .filter((l: any) => l.quantity > 0);
      if (lines.length === 0) throw new Error("Enter a quantity to receive on at least one line.");
      return (await apiRequest("POST", `/api/purchase-orders/${poId}/receive`, { date, lines })).json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      toast({ title: "Received", description: `Bill ${data.bill?.number ?? ""} created for this receipt.` });
      onClose();
    },
    onError: (e: any) => toast({ title: "Receive failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Receive — {po?.number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="w-48"><Label>Receipt date</Label><Input type="date" data-testid="input-receive-date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <table className="w-full text-sm border border-border rounded-md overflow-hidden">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="text-left px-3 py-2 font-medium">Item</th><th className="text-right px-3 py-2 font-medium w-20">Ordered</th><th className="text-right px-3 py-2 font-medium w-20">Received</th><th className="text-right px-3 py-2 font-medium w-28">Receive now</th></tr>
            </thead>
            <tbody>
              {(po?.lines ?? []).map((l: any) => (
                <tr key={l.id} className="border-t border-border" data-testid={`row-receive-line-${l.id}`}>
                  <td className="px-3 py-2">{l.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.qtyReceived}</td>
                  <td className="px-2 py-1">
                    <Input type="number" step="1" min="0" max={l.quantity - l.qtyReceived} className="text-right h-8" data-testid={`input-receive-qty-${l.id}`}
                      value={qtys[l.id] ?? ""} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => receiveMut.mutate()} disabled={receiveMut.isPending} data-testid="button-confirm-receive">
            {receiveMut.isPending ? "Receiving…" : "Receive & create bill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
