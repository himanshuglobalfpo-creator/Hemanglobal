import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Attachments } from "@/pages/Security";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2, DollarSign, FileDown, Paperclip } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { centsToDollars, fmtMoney, fmtDate, todayISO } from "@/lib/format";
import type { Account, Vendor, Bill } from "@shared/schema";

interface NewLine { description: string; quantity: number; rate: number; expenseAccountId: number | null; }

export default function Bills() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [attachFor, setAttachFor] = useState<number | null>(null);

  const { data: bills = [] } = useQuery<(Bill & { vendorName?: string })[]>({ queryKey: ["/api/bills"] });
  const { data: vendors = [] } = useQuery<Vendor[]>({ queryKey: ["/api/vendors"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });

  const expenseAccts = accounts.filter((a) => a.type === "expense");
  const bankAccts = accounts.filter((a) => a.subtype === "bank" || a.subtype === "credit_card");

  const today = todayISO();
  const due30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [form, setForm] = useState({
    number: "",
    vendorId: null as number | null,
    date: today,
    dueDate: due30,
    taxRate: 0,
    notes: "",
    lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: null }] as NewLine[],
  });

  function openCreate() {
    setForm({
      number: `BILL-${Math.floor(1000 + Math.random() * 9000)}`,
      vendorId: null,
      date: today,
      dueDate: due30,
      taxRate: 0,
      notes: "",
      lines: [{ description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }],
    });
    setOpen(true);
  }

  const createMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/bills", {
        number: form.number,
        vendorId: form.vendorId,
        date: form.date,
        dueDate: form.dueDate,
        taxRate: form.taxRate,
        notes: form.notes || undefined,
        lines: form.lines,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      setOpen(false);
      toast({ title: "Bill created" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Live preview in INTEGER CENTS using the exact server formula
  // (Math.round(qty * rate * 100) per line) so preview === stored values.
  const subtotal = form.lines.reduce((s, l) => s + Math.round((l.quantity || 0) * (l.rate || 0) * 100), 0);
  const tax = Math.round((subtotal * (form.taxRate || 0)) / 100);
  const total = subtotal + tax;

  return (
    <Layout>
      <PageHeader
        title="Bills"
        description="Track what you owe vendors"
        actions={<Button onClick={openCreate} data-testid="button-new-bill"><Plus className="h-4 w-4 mr-1.5" />New bill</Button>}
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium text-right">Balance</th>
                <th className="px-4 py-3 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {bills.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">No bills yet.</td></tr>
              )}
              {bills.map((b) => {
                const balance = b.total - b.amountPaid;
                const overdue = b.status === "open" && b.dueDate < today;
                return (
                  <tr key={b.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-bill-${b.id}`}>
                    <td className="px-4 py-3 font-medium">{b.number}</td>
                    <td className="px-4 py-3">{b.vendorName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(b.date)}</td>
                    <td className={`px-4 py-3 ${overdue ? "text-destructive" : "text-muted-foreground"}`}>{fmtDate(b.dueDate)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={b.status === "paid" ? "default" : overdue ? "destructive" : "secondary"}>
                        {overdue ? "overdue" : b.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(b.total)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(balance)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => window.open(`/api/bills/${b.id}/pdf`, "_blank")}
                          data-testid={`button-pdf-bill-${b.id}`}
                          title="Download PDF"
                        >
                          <FileDown className="h-4 w-4" />
                        </Button>
                        {b.status !== "paid" && balance > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setPayOpen(b.id)} data-testid={`button-pay-bill-${b.id}`} title="Record payment">
                            <DollarSign className="h-4 w-4" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setAttachFor(attachFor === b.id ? null : b.id)} title="Attachments">
                          <Paperclip className="h-4 w-4" />
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

      {attachFor !== null && (
        <div className="mt-4 rounded-lg border p-4">
          <div className="text-sm font-medium mb-1">Attachments for bill #{attachFor}</div>
          <Attachments entityType="bill" entityId={attachFor} />
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New bill</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label>Number</Label>
                <Input data-testid="input-bill-number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
              </div>
              <div>
                <Label>Vendor</Label>
                <Select value={form.vendorId?.toString() ?? ""} onValueChange={(v) => setForm({ ...form, vendorId: Number(v) })}>
                  <SelectTrigger data-testid="select-bill-vendor"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => <SelectItem key={v.id} value={v.id.toString()}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Date</Label>
                <Input type="date" data-testid="input-bill-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div>
                <Label>Due date</Label>
                <Input type="date" data-testid="input-bill-due" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
            </div>

            <div>
              <Label>Line items</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-left px-3 py-2 font-medium w-32">Expense account</th>
                      <th className="text-right px-3 py-2 font-medium w-20">Qty</th>
                      <th className="text-right px-3 py-2 font-medium w-24">Rate</th>
                      <th className="text-right px-3 py-2 font-medium w-28">Amount</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="px-2 py-1">
                          <Input data-testid={`input-bill-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-2 py-1">
                          <Select value={l.expenseAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].expenseAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-bill-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              {expenseAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1">
                          <Input type="number" step="0.01" data-testid={`input-bill-line-qty-${idx}`} className="text-right" value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-2 py-1">
                          <Input type="number" step="0.01" data-testid={`input-bill-line-rate-${idx}`} className="text-right" value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.quantity * l.rate)}</td>
                        <td className="px-2 py-1">
                          {form.lines.length > 1 && (
                            <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })} data-testid={`button-bill-remove-line-${idx}`}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, expenseAccountId: expenseAccts[0]?.id ?? null }] })}
                data-testid="button-bill-add-line"
              >
                <Plus className="h-4 w-4 mr-1" />Add line
              </Button>
            </div>

            <div className="flex justify-end">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Tax %</span>
                  <Input type="number" step="0.01" data-testid="input-bill-tax" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} className="w-20 h-8 text-right" />
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{fmtMoney(tax)}</span></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.vendorId || !form.number || form.lines.some((l) => !l.description || !l.expenseAccountId) || createMut.isPending}
              onClick={() => createMut.mutate()}
              data-testid="button-save-bill"
            >
              {createMut.isPending ? "Saving…" : "Create bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {payOpen !== null && (
        <PayBillDialog
          billId={payOpen}
          bill={bills.find((b) => b.id === payOpen)!}
          bankAccts={bankAccts}
          onClose={() => setPayOpen(null)}
        />
      )}
    </Layout>
  );
}

function PayBillDialog({ billId, bill, bankAccts, onClose }: { billId: number; bill: Bill; bankAccts: Account[]; onClose: () => void; }) {
  const { toast } = useToast();
  const balance = bill.total - bill.amountPaid;
  // balance is integer cents from the API; the amount INPUT is dollars
  const [amount, setAmount] = useState(centsToDollars(balance));
  const [date, setDate] = useState(todayISO());
  const [bankAccountId, setBankAccountId] = useState<number | null>(bankAccts[0]?.id ?? null);

  const payMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/bills/${billId}/pay`, { date, amount, bankAccountId, memo: `Payment for ${bill.number}` });
      return r.json();
    },
    onSuccess: () => { queryClient.invalidateQueries(); toast({ title: "Payment recorded" }); onClose(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pay bill {bill.number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">Outstanding: <span className="font-medium text-foreground tabular-nums">{fmtMoney(balance)}</span></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input type="date" data-testid="input-bill-payment-date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label>Amount</Label>
              <Input type="number" step="0.01" data-testid="input-bill-payment-amount" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </div>
          </div>
          <div>
            <Label>Pay from</Label>
            <Select value={bankAccountId?.toString() ?? ""} onValueChange={(v) => setBankAccountId(Number(v))}>
              <SelectTrigger data-testid="select-bill-payment-bank"><SelectValue /></SelectTrigger>
              <SelectContent>
                {bankAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!bankAccountId || amount <= 0 || payMut.isPending} onClick={() => payMut.mutate()} data-testid="button-record-bill-payment">
            {payMut.isPending ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
