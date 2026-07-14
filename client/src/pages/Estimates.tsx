// ============================================================================
// ESTIMATES (quotes) — /estimates
// ============================================================================
// List + create (invoice-style line editor) + convert-to-invoice + share link,
// over the existing /api/estimates endpoints. Totals are integer cents from the
// server (subtotalCents/taxCents/totalCents).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, FileCheck2, Link as LinkIcon, Check } from "lucide-react";
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
import { fmtMoney, fmtDate, todayISO } from "@/lib/format";

type Estimate = {
  id: number; number: string; customerId: number; customerName?: string;
  date: string; expiryDate: string; status: string; totalCents: number;
};
interface Line { description: string; quantity: number; rate: number; incomeAccountId: number | null; }

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  invoiced: "default", accepted: "default", sent: "secondary", draft: "secondary",
  declined: "destructive", expired: "outline",
};

export default function Estimates() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: estRaw } = useQuery<any>({
    queryKey: ["/api/estimates"],
    queryFn: async () => (await apiRequest("GET", "/api/estimates?limit=200")).json(),
  });
  const estimates: Estimate[] = Array.isArray(estRaw) ? estRaw : estRaw?.rows ?? [];
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const incomeAccts = accounts.filter((a) => a.type === "income");

  const today = todayISO();
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    customerId: null as number | null, date: today, expiryDate: in30, taxRate: 0,
    lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: null }] as Line[],
  });

  function openCreate() {
    setForm({
      customerId: null, date: today, expiryDate: in30, taxRate: 0,
      lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }],
    });
    setOpen(true);
  }
  useOpenOnCreateParam(openCreate);
  // Fill the default income account once accounts load (open-before-load race).
  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, lines: f.lines.map((l) => ({ ...l, incomeAccountId: l.incomeAccountId ?? incomeAccts[0]?.id ?? null })) }));
  }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        customerId: form.customerId, date: form.date, expiryDate: form.expiryDate, taxRate: form.taxRate,
        lines: form.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, incomeAccountId: l.incomeAccountId ?? undefined })),
      };
      return (await apiRequest("POST", "/api/estimates", body)).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/estimates"] }); setOpen(false); toast({ title: "Estimate created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/estimates/${id}/convert`, {})).json(),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      toast({ title: "Converted to invoice", description: `Invoice ${data.invoice?.number ?? ""} created.` });
    },
    onError: (e: any) => toast({ title: "Convert failed", description: e.message, variant: "destructive" }),
  });

  const shareMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/estimates/${id}/share`, {})).json(),
    onSuccess: (data: any) => { setShareUrl(data.url); toast({ title: "Share link created" }); },
    onError: (e: any) => toast({ title: "Share failed", description: e.message, variant: "destructive" }),
  });

  const subtotal = form.lines.reduce((s, l) => s + Math.round((l.quantity || 0) * (l.rate || 0) * 100), 0);
  const tax = Math.round((subtotal * (form.taxRate || 0)) / 100);
  const total = subtotal + tax;

  return (
    <Layout>
      <PageHeader
        title="Estimates"
        description="Quote customers before you invoice"
        actions={<Button onClick={openCreate} data-testid="button-new-estimate"><Plus className="h-4 w-4 mr-1.5" />New estimate</Button>}
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Expiry</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium w-48"></th>
              </tr>
            </thead>
            <tbody>
              {estimates.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No estimates yet.</td></tr>
              )}
              {estimates.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-estimate-${e.id}`}>
                  <td className="px-4 py-3 font-medium">{e.number}</td>
                  <td className="px-4 py-3">{e.customerName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(e.date)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(e.expiryDate)}</td>
                  <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[e.status] ?? "secondary"} className="capitalize">{e.status}</Badge></td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(e.totalCents)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => shareMut.mutate(e.id)} data-testid={`button-share-estimate-${e.id}`} title="Share link">
                        <LinkIcon className="h-4 w-4" />
                      </Button>
                      {e.status !== "invoiced" && (
                        <Button size="sm" variant="outline" onClick={() => convertMut.mutate(e.id)} disabled={convertMut.isPending} data-testid={`button-convert-estimate-${e.id}`}>
                          <FileCheck2 className="h-3.5 w-3.5 mr-1" />Convert
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

      {shareUrl && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 max-w-xl">
          <p className="text-xs font-medium text-muted-foreground mb-1">Public estimate link</p>
          <div className="flex items-center gap-2">
            <Input readOnly value={shareUrl} className="text-xs" data-testid="input-estimate-share-url" />
            <Button size="sm" variant="outline" onClick={async () => { await navigator.clipboard.writeText(shareUrl).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <Check className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New estimate</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Customer</Label>
                <Select value={form.customerId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, customerId: Number(v) })}>
                  <SelectTrigger data-testid="select-estimate-customer"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{customers.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Date</Label><Input type="date" data-testid="input-estimate-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
              <div><Label>Expiry date</Label><Input type="date" data-testid="input-estimate-expiry" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></div>
            </div>

            <div>
              <Label>Line items</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-left px-3 py-2 font-medium w-40">Income account</th>
                      <th className="text-right px-3 py-2 font-medium w-20">Qty</th>
                      <th className="text-right px-3 py-2 font-medium w-24">Rate</th>
                      <th className="text-right px-3 py-2 font-medium w-28">Amount</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="px-2 py-1"><Input data-testid={`input-estimate-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1">
                          <Select value={l.incomeAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].incomeAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-estimate-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{incomeAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-estimate-line-qty-${idx}`} value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-2 py-1"><Input type="number" step="0.01" className="text-right" data-testid={`input-estimate-line-rate-${idx}`} value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.round(l.quantity * l.rate * 100))}</td>
                        <td className="px-2 py-1">{form.lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })} data-testid={`button-remove-estimate-line-${idx}`}><Trash2 className="h-4 w-4" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }] })} data-testid="button-add-estimate-line">
                <Plus className="h-4 w-4 mr-1" />Add line
              </Button>
            </div>

            <div className="flex justify-end">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground">Tax %</span><Input type="number" step="0.01" className="w-20 h-8 text-right" data-testid="input-estimate-tax" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} /></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.customerId || form.lines.some((l) => !l.description || !l.incomeAccountId) || createMut.isPending}
              onClick={() => createMut.mutate()}
              data-testid="button-save-estimate"
            >
              {createMut.isPending ? "Saving…" : "Create estimate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
