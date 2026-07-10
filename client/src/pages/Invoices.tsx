import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, DollarSign, FileDown, Send, Link as LinkIcon, Check, Paperclip } from "lucide-react";
import type { Account, Customer, Invoice } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Attachments } from "@/pages/Security";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { centsToDollars, fmtMoney, fmtDate, todayISO } from "@/lib/format";

interface NewLine { description: string; quantity: number; rate: number; incomeAccountId: number | null; }

export default function Invoices() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [attachFor, setAttachFor] = useState<number | null>(null);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [sendOpen, setSendOpen] = useState<number | null>(null);

  const { data: invoices = [] } = useQuery<(Invoice & { customerName?: string })[]>({ queryKey: ["/api/invoices"] });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: taxCodes = [] } = useQuery<{ id: number; name: string; rate: number; isActive: boolean }[]>({
    queryKey: ["/api/tax-codes"],
  });

  const incomeAccts = accounts.filter((a) => a.type === "income");
  const bankAccts = accounts.filter((a) => a.subtype === "bank");

  const today = todayISO();
  const due30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [form, setForm] = useState({
    number: "",
    customerId: null as number | null,
    date: today,
    dueDate: due30,
    taxRate: 0,
    notes: "",
    lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: null }] as NewLine[],
  });

  function resetForm() {
    setForm({
      number: `INV-${Math.floor(1000 + Math.random() * 9000)}`,
      customerId: null,
      date: today,
      dueDate: due30,
      taxRate: 0,
      notes: "",
      lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }],
    });
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        number: form.number,
        customerId: form.customerId,
        date: form.date,
        dueDate: form.dueDate,
        taxRate: form.taxRate,
        notes: form.notes || undefined,
        lines: form.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          incomeAccountId: l.incomeAccountId,
        })),
      };
      const r = await apiRequest("POST", "/api/invoices", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      setOpen(false);
      toast({ title: "Invoice created" });
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
        title="Invoices"
        description="Bill customers for goods and services"
        actions={
          <Button onClick={openCreate} data-testid="button-new-invoice"><Plus className="h-4 w-4 mr-1.5" />New invoice</Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Due</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium text-right">Balance</th>
                <th className="px-4 py-3 font-medium w-28"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">No invoices yet.</td></tr>
              )}
              {invoices.map((i) => {
                const balance = i.total - i.amountPaid;
                const overdue = i.status === "open" && i.dueDate < today;
                return (
                  <tr key={i.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-invoice-${i.id}`}>
                    <td className="px-4 py-3 font-medium">{i.number}</td>
                    <td className="px-4 py-3">{i.customerName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(i.date)}</td>
                    <td className={`px-4 py-3 ${overdue ? "text-destructive" : "text-muted-foreground"}`}>{fmtDate(i.dueDate)}</td>
                    <td className="px-4 py-3">
                      <Badge variant={i.status === "paid" ? "default" : overdue ? "destructive" : "secondary"}>
                        {overdue ? "overdue" : i.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(i.total)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(balance)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => window.open(`/api/invoices/${i.id}/pdf`, "_blank")}
                          data-testid={`button-pdf-invoice-${i.id}`}
                          title="Download PDF"
                        >
                          <FileDown className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSendOpen(i.id)}
                          data-testid={`button-send-invoice-${i.id}`}
                          title="Send to customer"
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                        {i.status !== "paid" && balance > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setPayOpen(i.id)} data-testid={`button-pay-invoice-${i.id}`} title="Record payment">
                            <DollarSign className="h-4 w-4" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setAttachFor(attachFor === i.id ? null : i.id)} title="Attachments">
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
          <div className="text-sm font-medium mb-1">Attachments for invoice #{attachFor}</div>
          <Attachments entityType="invoice" entityId={attachFor} />
        </div>
      )}
      {/* Create Invoice Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New invoice</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label>Number</Label>
                <Input data-testid="input-invoice-number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
              </div>
              <div>
                <Label>Customer</Label>
                <Select
                  value={form.customerId?.toString() ?? ""}
                  onValueChange={(v) => setForm({ ...form, customerId: Number(v) })}
                >
                  <SelectTrigger data-testid="select-invoice-customer"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Date</Label>
                <Input type="date" data-testid="input-invoice-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div>
                <Label>Due date</Label>
                <Input type="date" data-testid="input-invoice-due" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
            </div>

            <div>
              <Label>Line items</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-left px-3 py-2 font-medium w-32">Income account</th>
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
                          <Input data-testid={`input-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-2 py-1">
                          <Select value={l.incomeAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].incomeAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              {incomeAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1">
                          <Input type="number" step="0.01" data-testid={`input-line-qty-${idx}`} className="text-right" value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-2 py-1">
                          <Input type="number" step="0.01" data-testid={`input-line-rate-${idx}`} className="text-right" value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.quantity * l.rate)}</td>
                        <td className="px-2 py-1">
                          {form.lines.length > 1 && (
                            <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })} data-testid={`button-remove-line-${idx}`}>
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
                onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }] })}
                data-testid="button-add-line"
              >
                <Plus className="h-4 w-4 mr-1" />Add line
              </Button>
            </div>

            <div className="flex justify-end">
              <div className="w-64 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{fmtMoney(subtotal)}</span></div>
                {taxCodes.filter((t) => t.isActive).length > 0 && (
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-muted-foreground text-xs">Tax code</span>
                    <Select
                      value={"manual"}
                      onValueChange={(v) => {
                        if (v === "none") setForm({ ...form, taxRate: 0 });
                        else if (v !== "manual") {
                          const tc = taxCodes.find((c) => String(c.id) === v);
                          if (tc) setForm({ ...form, taxRate: tc.rate });
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 w-40" data-testid="select-invoice-tax-code">
                        <SelectValue placeholder="Manual" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="none">No tax</SelectItem>
                        {taxCodes.filter((t) => t.isActive).map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Tax %</span>
                  <Input type="number" step="0.01" data-testid="input-invoice-tax" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} className="w-20 h-8 text-right" />
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{fmtMoney(tax)}</span></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.customerId || !form.number || form.lines.some((l) => !l.description || !l.incomeAccountId) || createMut.isPending}
              onClick={() => createMut.mutate()}
              data-testid="button-save-invoice"
            >
              {createMut.isPending ? "Saving…" : "Create invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Dialog */}
      {sendOpen !== null && (
        <SendInvoiceDialog
          invoice={invoices.find((x) => x.id === sendOpen)!}
          customer={customers.find((c) => c.id === invoices.find((x) => x.id === sendOpen)?.customerId)}
          open={sendOpen !== null}
          onClose={() => setSendOpen(null)}
        />
      )}

      {/* Pay Dialog */}
      {payOpen !== null && (
        <PayInvoiceDialog
          invoiceId={payOpen}
          invoice={invoices.find((i) => i.id === payOpen)!}
          bankAccts={bankAccts}
          onClose={() => setPayOpen(null)}
        />
      )}
    </Layout>
  );
}

function PayInvoiceDialog({
  invoiceId,
  invoice,
  bankAccts,
  onClose,
}: {
  invoiceId: number;
  invoice: Invoice;
  bankAccts: Account[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const balance = invoice.total - invoice.amountPaid;
  // balance is integer cents from the API; the amount INPUT is dollars
  const [amount, setAmount] = useState(centsToDollars(balance));
  const [date, setDate] = useState(todayISO());
  const [bankAccountId, setBankAccountId] = useState<number | null>(bankAccts[0]?.id ?? null);

  const payMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/invoices/${invoiceId}/pay`, {
        date, amount, bankAccountId, memo: `Payment for ${invoice.number}`,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast({ title: "Payment recorded" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Receive payment for {invoice.number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">Outstanding: <span className="font-medium text-foreground tabular-nums">{fmtMoney(balance)}</span></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input type="date" data-testid="input-payment-date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label>Amount</Label>
              <Input type="number" step="0.01" data-testid="input-payment-amount" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            </div>
          </div>
          <div>
            <Label>Deposit to</Label>
            <Select value={bankAccountId?.toString() ?? ""} onValueChange={(v) => setBankAccountId(Number(v))}>
              <SelectTrigger data-testid="select-payment-bank"><SelectValue /></SelectTrigger>
              <SelectContent>
                {bankAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!bankAccountId || amount <= 0 || payMut.isPending} onClick={() => payMut.mutate()} data-testid="button-record-payment">
            {payMut.isPending ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendInvoiceDialog({
  invoice,
  customer,
  open,
  onClose,
}: {
  invoice: Invoice & { customerName?: string };
  customer?: Customer;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [to, setTo] = useState(customer?.email || "");
  const [subject, setSubject] = useState(`Invoice ${invoice.number} from LedgerLite`);
  const balance = invoice.total - (invoice.amountPaid || 0);
  const [body, setBody] = useState(
    `Hi ${customer?.name || "there"},\n\nPlease find your invoice ${invoice.number} below.\n\n  Amount due: ${fmtMoney(balance)}\n  Due date:   ${fmtDate(invoice.dueDate)}\n\nThanks,\nLedgerLite`
  );
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sendMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/invoices/${invoice.id}/send`, { to, subject, body });
      return r.json();
    },
    onSuccess: (data: any) => {
      setShareUrl(data.url);
      const mode = data.sendResult?.mode;
      toast({
        title: mode === "dev" ? "Share link created" : "Invoice sent",
        description:
          mode === "dev"
            ? "SMTP is not configured — share the link below with your customer."
            : `Email delivered to ${to}.`,
      });
    },
    onError: (e: any) =>
      toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const linkOnlyMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/invoices/${invoice.id}/share`, { email: to || null });
      return r.json();
    },
    onSuccess: (data: any) => {
      setShareUrl(data.url);
      toast({ title: "Share link created" });
    },
  });

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send invoice {invoice.number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="customer@example.com"
              data-testid="input-send-to"
            />
            {!customer?.email && (
              <p className="text-xs text-muted-foreground mt-1">
                No email on file for this customer — type one in.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="input-send-subject"
            />
          </div>
          <div>
            <Label htmlFor="body">Message</Label>
            <Textarea
              id="body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-testid="textarea-send-body"
            />
          </div>
          {shareUrl && (
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Public share link</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={shareUrl} className="text-xs" data-testid="input-share-url" />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyLink}
                  data-testid="button-copy-share"
                >
                  {copied ? <Check className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => linkOnlyMut.mutate()}
            disabled={linkOnlyMut.isPending}
            data-testid="button-share-link-only"
          >
            <LinkIcon className="h-4 w-4 mr-1.5" />
            Get link only
          </Button>
          <Button
            onClick={() => sendMut.mutate()}
            disabled={!to || sendMut.isPending}
            data-testid="button-send-email"
          >
            <Send className="h-4 w-4 mr-1.5" />
            {sendMut.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
