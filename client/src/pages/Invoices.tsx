import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, DollarSign, FileDown, Send, Link as LinkIcon, Check, Paperclip, Settings2, ChevronDown } from "lucide-react";
import type { Account, Customer, Invoice, Item, InvoiceSettings } from "@shared/schema";
import { defaultInvoiceSettings } from "@shared/schema";
import type { Me } from "@/App";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Attachments } from "@/pages/Security";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { centsToDollars, fmtMoney, fmtDate, todayISO } from "@/lib/format";

interface NewLine {
  description: string; quantity: number; rate: number;
  incomeAccountId: number | null; projectId?: number | null;
  itemId?: number | null; serviceDate?: string;
}

// Payment terms (QBO-style). "Net N" computes the due date from the invoice date.
const TERMS_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "Due on receipt", days: 0 },
  { label: "Net 15", days: 15 },
  { label: "Net 30", days: 30 },
  { label: "Net 60", days: 60 },
];
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const termsForDays = (days: number) =>
  TERMS_OPTIONS.find((t) => t.days === days)?.label ?? `Net ${days}`;

export default function Invoices() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [attachFor, setAttachFor] = useState<number | null>(null);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [sendOpen, setSendOpen] = useState<number | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  const { data: invoices = [] } = useQuery<(Invoice & { customerName?: string })[]>({ queryKey: ["/api/invoices"] });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: items = [] } = useQuery<Item[]>({ queryKey: ["/api/items"] });
  const { data: taxCodes = [] } = useQuery<{ id: number; name: string; rate: number; isActive: boolean }[]>({
    queryKey: ["/api/tax-codes"],
  });
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });

  // Per-org invoice-form preferences (the Manage panel). The server serves the
  // FULL defaulted object; the fallback only covers the first unloaded render.
  const settings: InvoiceSettings = me?.org?.invoiceSettings ?? defaultInvoiceSettings;
  const cz = settings.customization;
  const cols = settings.tableColumns;
  const canEditSettings = me?.role === "owner" || me?.role === "admin";

  const { data: projects = [] } = useQuery<{ id: number; name: string; isActive: boolean }[]>({ queryKey: ["/api/projects"] });
  const incomeAccts = accounts.filter((a) => a.type === "income");
  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const showProject = projects.length > 0;

  const today = todayISO();
  const defaultTermsDays = settings.scheduling.defaultTermsDays;

  const [form, setForm] = useState({
    number: "",
    customerId: null as number | null,
    date: today,
    dueDate: addDays(today, defaultTermsDays),
    terms: termsForDays(defaultTermsDays),
    shipTo: "",
    customFieldValues: {} as Record<string, string>,
    taxRate: 0,
    notes: "",
    lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: null }] as NewLine[],
  });

  function resetForm() {
    setForm({
      number: `INV-${Math.floor(1000 + Math.random() * 9000)}`,
      customerId: null,
      date: today,
      dueDate: addDays(today, defaultTermsDays),
      terms: termsForDays(defaultTermsDays),
      shipTo: "",
      customFieldValues: {},
      taxRate: 0,
      notes: "",
      lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }],
    });
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  const selectedCustomer = customers.find((c) => c.id === form.customerId);

  const createMut = useMutation({
    mutationFn: async () => {
      const customFields: Record<string, string> = {};
      for (const f of settings.customFields.filter((f) => f.active)) {
        const v = (form.customFieldValues[f.name] || "").trim();
        if (v) customFields[f.name] = v;
      }
      const body = {
        number: form.number,
        customerId: form.customerId,
        date: form.date,
        dueDate: form.dueDate,
        terms: cz.terms && form.terms ? form.terms : undefined,
        shipTo: cz.shipTo && form.shipTo.trim() ? form.shipTo.trim() : undefined,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        taxRate: form.taxRate,
        notes: form.notes || undefined,
        lines: form.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          incomeAccountId: l.incomeAccountId ?? undefined,
          itemId: l.itemId ?? undefined,
          serviceDate: cols.serviceDate.show && l.serviceDate ? l.serviceDate : undefined,
          projectId: l.projectId ?? undefined,
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
      {/* Create Invoice Dialog — QBO-style form + Manage side panel */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-6xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between pr-8">
              <DialogTitle>New invoice</DialogTitle>
              <Button variant="outline" size="sm" onClick={() => setManageOpen((v) => !v)} data-testid="button-manage-invoice">
                <Settings2 className="h-4 w-4 mr-1.5" />
                Manage
              </Button>
            </div>
          </DialogHeader>
          <div className="flex gap-6 items-start">
          <div className="flex-1 min-w-0 space-y-4 rounded-md" style={{ borderTop: `3px solid ${settings.design.accentColor}`, paddingTop: 12 }}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {cz.invoiceNo && (
                <div>
                  <Label>Invoice no.</Label>
                  <Input data-testid="input-invoice-number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
                </div>
              )}
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
              {cz.invoiceDate && (
                <div>
                  <Label>Invoice date</Label>
                  <Input
                    type="date"
                    data-testid="input-invoice-date"
                    value={form.date}
                    onChange={(e) => {
                      // Changing the date re-derives the due date from the terms.
                      const t = TERMS_OPTIONS.find((o) => o.label === form.terms);
                      setForm({ ...form, date: e.target.value, dueDate: t ? addDays(e.target.value, t.days) : form.dueDate });
                    }}
                  />
                </div>
              )}
              {cz.terms && (
                <div>
                  <Label>Terms</Label>
                  <Select
                    value={form.terms}
                    onValueChange={(v) => {
                      const t = TERMS_OPTIONS.find((o) => o.label === v);
                      setForm({ ...form, terms: v, dueDate: t ? addDays(form.date, t.days) : form.dueDate });
                    }}
                  >
                    <SelectTrigger data-testid="select-invoice-terms"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TERMS_OPTIONS.map((t) => <SelectItem key={t.label} value={t.label}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {cz.dueDate && (
                <div>
                  <Label>Due date</Label>
                  <Input type="date" data-testid="input-invoice-due" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </div>
              )}
            </div>

            {(cz.customerEmail || cz.customerContactInfo || cz.shipTo) && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {cz.customerEmail && (
                  <div>
                    <Label>Customer email</Label>
                    <Input readOnly value={selectedCustomer?.email ?? ""} placeholder="From the customer record" data-testid="text-customer-email" />
                  </div>
                )}
                {cz.customerContactInfo && (
                  <div>
                    <Label>Customer contact info</Label>
                    <Input readOnly value={[selectedCustomer?.phone, selectedCustomer?.address].filter(Boolean).join(" · ")} placeholder="From the customer record" data-testid="text-customer-contact" />
                  </div>
                )}
                {cz.shipTo && (
                  <div>
                    <Label>Ship to</Label>
                    <Input data-testid="input-ship-to" placeholder="Shipping address" value={form.shipTo} onChange={(e) => setForm({ ...form, shipTo: e.target.value })} />
                  </div>
                )}
              </div>
            )}

            {settings.customFields.filter((f) => f.active).length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {settings.customFields.filter((f) => f.active).map((f) => (
                  <div key={f.name}>
                    <Label>{f.name}</Label>
                    <Input
                      data-testid={`input-custom-field-${f.name}`}
                      value={form.customFieldValues[f.name] ?? ""}
                      onChange={(e) => setForm({ ...form, customFieldValues: { ...form.customFieldValues, [f.name]: e.target.value } })}
                    />
                  </div>
                ))}
              </div>
            )}

            <div>
              <Label>Product or service</Label>
              <div className="border border-border rounded-md overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      {cols.rowNumber.show && <th className="text-left px-3 py-2 font-medium w-8">{cols.rowNumber.label}</th>}
                      {cols.serviceDate.show && <th className="text-left px-3 py-2 font-medium w-36">{cols.serviceDate.label}</th>}
                      {cols.productService.show && <th className="text-left px-3 py-2 font-medium w-40">{cols.productService.label}</th>}
                      {cols.sku.show && <th className="text-left px-3 py-2 font-medium w-24">{cols.sku.label}</th>}
                      {cols.description.show && <th className="text-left px-3 py-2 font-medium">{cols.description.label}</th>}
                      <th className="text-left px-3 py-2 font-medium w-32">Income account</th>
                      {showProject && <th className="text-left px-3 py-2 font-medium w-32">Project</th>}
                      {cols.qty.show && <th className="text-right px-3 py-2 font-medium w-20">{cols.qty.label}</th>}
                      {cols.rate.show && <th className="text-right px-3 py-2 font-medium w-24">{cols.rate.label}</th>}
                      {cols.amount.show && <th className="text-right px-3 py-2 font-medium w-28">{cols.amount.label}</th>}
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-border">
                        {cols.rowNumber.show && <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>}
                        {cols.serviceDate.show && (
                          <td className="px-2 py-1">
                            <Input type="date" data-testid={`input-line-service-date-${idx}`} value={l.serviceDate ?? ""} onChange={(e) => { const lines = [...form.lines]; lines[idx].serviceDate = e.target.value || undefined; setForm({ ...form, lines }); }} />
                          </td>
                        )}
                        {cols.productService.show && (
                          <td className="px-2 py-1">
                            <select
                              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              data-testid={`select-line-item-${idx}`}
                              value={l.itemId?.toString() ?? ""}
                              onChange={(e) => {
                                const lines = [...form.lines];
                                const it = items.find((x) => x.id === Number(e.target.value));
                                lines[idx].itemId = it?.id ?? null;
                                // Choosing an item derives the income account and
                                // seeds an empty description — same as the server.
                                if (it) {
                                  lines[idx].incomeAccountId = it.salesAccountId;
                                  if (!lines[idx].description) lines[idx].description = it.name;
                                }
                                setForm({ ...form, lines });
                              }}
                            >
                              <option value="">—</option>
                              {items.filter((it) => it.isActive || it.id === l.itemId).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                            </select>
                          </td>
                        )}
                        {cols.sku.show && (
                          <td className="px-3 py-2 text-muted-foreground" data-testid={`text-line-sku-${idx}`}>
                            {items.find((x) => x.id === l.itemId)?.sku ?? ""}
                          </td>
                        )}
                        {cols.description.show && (
                          <td className="px-2 py-1">
                            <Input data-testid={`input-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} />
                          </td>
                        )}
                        <td className="px-2 py-1">
                          <Select value={l.incomeAccountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].incomeAccountId = Number(v); setForm({ ...form, lines }); }}>
                            <SelectTrigger data-testid={`select-line-account-${idx}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              {incomeAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        {showProject && (
                          <td className="px-2 py-1">
                            <select
                              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              data-testid={`select-line-project-${idx}`}
                              value={l.projectId?.toString() ?? ""}
                              onChange={(e) => { const lines = [...form.lines]; lines[idx].projectId = e.target.value ? Number(e.target.value) : null; setForm({ ...form, lines }); }}
                            >
                              <option value="">—</option>
                              {projects.filter((p) => p.isActive || p.id === l.projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                        )}
                        {cols.qty.show && (
                          <td className="px-2 py-1">
                            <Input type="number" step="0.01" data-testid={`input-line-qty-${idx}`} className="text-right" value={l.quantity} onChange={(e) => { const lines = [...form.lines]; lines[idx].quantity = Number(e.target.value); setForm({ ...form, lines }); }} />
                          </td>
                        )}
                        {cols.rate.show && (
                          <td className="px-2 py-1">
                            <Input type="number" step="0.01" data-testid={`input-line-rate-${idx}`} className="text-right" value={l.rate} onChange={(e) => { const lines = [...form.lines]; lines[idx].rate = Number(e.target.value); setForm({ ...form, lines }); }} />
                          </td>
                        )}
                        {cols.amount.show && <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.quantity * l.rate)}</td>}
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
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setForm({ ...form, lines: [...form.lines, { description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }] })}
                  data-testid="button-add-line"
                >
                  <Plus className="h-4 w-4 mr-1" />Add product or service
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setForm({ ...form, lines: [{ description: "", quantity: 1, rate: 0, incomeAccountId: incomeAccts[0]?.id ?? null }] })}
                  data-testid="button-clear-lines"
                >
                  Clear all lines
                </Button>
              </div>
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
                {settings.paymentOptions.invoiceTotal && (
                  <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
                    <span>Invoice total</span>
                    <span className="tabular-nums" style={{ color: settings.design.accentColor }}>{fmtMoney(total)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Online payment methods the org offers (shown on the customer
                payment page when Stripe is configured — display here mirrors QBO). */}
            {(settings.paymentMethods.cards || settings.paymentMethods.bankTransfer || settings.paymentMethods.paypalVenmo || settings.paymentMethods.buyNowPayLater) && (
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground" data-testid="row-payment-methods">
                <span className="font-medium text-foreground">Online payments:</span>
                {settings.paymentMethods.cards && <Badge variant="outline">Cards</Badge>}
                {settings.paymentMethods.bankTransfer && <Badge variant="outline">Bank transfer</Badge>}
                {settings.paymentMethods.paypalVenmo && <Badge variant="outline">PayPal &amp; Venmo</Badge>}
                {settings.paymentMethods.buyNowPayLater && <Badge variant="outline">Buy now, pay later</Badge>}
                <span>· shown on the customer payment page when Stripe is configured</span>
              </div>
            )}
          </div>

          {manageOpen && (
            <ManageInvoicePanel
              settings={settings}
              canEdit={canEditSettings}
              orgId={me?.org?.id ?? null}
              onClose={() => setManageOpen(false)}
            />
          )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.customerId || !form.number || form.lines.some((l) => !l.description || (!l.incomeAccountId && !l.itemId)) || createMut.isPending}
              onClick={() => createMut.mutate()}
              data-testid="button-save-invoice"
            >
              {createMut.isPending ? "Saving…" : "Save and close"}
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

// ============================================================
// Manage panel (QBO gear) — per-org invoice form preferences.
// Sections: Customization, Table content, Custom fields, Payment
// methods, Payment options, Design, Scheduling. Saved to
// organizations.invoice_settings via PATCH /api/orgs/:id.
// ============================================================
const TABLE_COLUMN_KEYS = [
  "rowNumber", "serviceDate", "productService", "sku", "description", "qty", "rate", "amount",
] as const;

function ManageInvoicePanel({ settings, canEdit, orgId, onClose }: {
  settings: InvoiceSettings;
  canEdit: boolean;
  orgId: number | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // Draft copy — edits stay local until "Save settings".
  const [draft, setDraft] = useState<InvoiceSettings>(() => JSON.parse(JSON.stringify(settings)));
  useEffect(() => { setDraft(JSON.parse(JSON.stringify(settings))); }, [settings]);
  const [sections, setSections] = useState<Record<string, boolean>>({ customization: true });
  const [newFieldName, setNewFieldName] = useState("");

  const saveMut = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/orgs/${orgId}`, { invoiceSettings: draft })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Saved", description: "Invoice form settings updated for your company." });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="border-b border-border pb-2">
      <button
        type="button"
        className="w-full flex items-center justify-between py-2 text-sm font-semibold"
        onClick={() => setSections((s) => ({ ...s, [id]: !s[id] }))}
        data-testid={`section-${id}`}
      >
        {title}
        <ChevronDown className={`h-4 w-4 transition-transform ${sections[id] ? "rotate-180" : ""}`} />
      </button>
      {sections[id] && <div className="space-y-2 pb-1">{children}</div>}
    </div>
  );

  const ToggleRow = ({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) => (
    <div className="flex items-center justify-between text-sm">
      <span>{label}</span>
      <Switch checked={checked} disabled={!canEdit} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );

  const czDraft = draft.customization;
  const setCz = (k: keyof InvoiceSettings["customization"], v: boolean) =>
    setDraft({ ...draft, customization: { ...czDraft, [k]: v } });

  const columnTitle: Record<(typeof TABLE_COLUMN_KEYS)[number], string> = {
    rowNumber: "#", serviceDate: "Service date", productService: "Product/service",
    sku: "SKU", description: "Description", qty: "Qty", rate: "Rate", amount: "Amount",
  };

  return (
    <aside className="w-80 shrink-0 border-l border-border pl-4 max-h-[70vh] overflow-y-auto" data-testid="panel-manage-invoice">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold">Manage</h3>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-manage">Close</Button>
      </div>
      {!canEdit && (
        <p className="text-xs text-muted-foreground mb-2">Only owners and admins can change these settings.</p>
      )}

      <Section id="customization" title="Customization">
        <ToggleRow label="Ship to" checked={czDraft.shipTo} onChange={(v) => setCz("shipTo", v)} testId="switch-cz-shipTo" />
        <ToggleRow label="Invoice no." checked={czDraft.invoiceNo} onChange={(v) => setCz("invoiceNo", v)} testId="switch-cz-invoiceNo" />
        <ToggleRow label="Invoice date" checked={czDraft.invoiceDate} onChange={(v) => setCz("invoiceDate", v)} testId="switch-cz-invoiceDate" />
        <ToggleRow label="Due date" checked={czDraft.dueDate} onChange={(v) => setCz("dueDate", v)} testId="switch-cz-dueDate" />
        <ToggleRow label="Terms" checked={czDraft.terms} onChange={(v) => setCz("terms", v)} testId="switch-cz-terms" />
        <ToggleRow label="Customer email" checked={czDraft.customerEmail} onChange={(v) => setCz("customerEmail", v)} testId="switch-cz-customerEmail" />
        <ToggleRow label="Customer contact info" checked={czDraft.customerContactInfo} onChange={(v) => setCz("customerContactInfo", v)} testId="switch-cz-customerContactInfo" />
      </Section>

      <Section id="table" title="Table content · Edit labels">
        {TABLE_COLUMN_KEYS.map((k) => (
          <div key={k} className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.tableColumns[k].show}
              disabled={!canEdit}
              onCheckedChange={(v) => setDraft({ ...draft, tableColumns: { ...draft.tableColumns, [k]: { ...draft.tableColumns[k], show: v } } })}
              data-testid={`switch-col-${k}`}
            />
            <Input
              className="h-8"
              value={draft.tableColumns[k].label}
              disabled={!canEdit}
              maxLength={30}
              onChange={(e) => setDraft({ ...draft, tableColumns: { ...draft.tableColumns, [k]: { ...draft.tableColumns[k], label: e.target.value } } })}
              data-testid={`input-col-label-${k}`}
            />
            <span className="text-xs text-muted-foreground w-24 truncate">{columnTitle[k]}</span>
          </div>
        ))}
      </Section>

      <Section id="customFields" title="Custom fields · Manage">
        {draft.customFields.length === 0 && <p className="text-xs text-muted-foreground">No custom fields yet (up to 3).</p>}
        {draft.customFields.map((f, i) => (
          <div key={f.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{f.name}</span>
            <div className="flex items-center gap-2">
              <Switch
                checked={f.active}
                disabled={!canEdit}
                onCheckedChange={(v) => setDraft({ ...draft, customFields: draft.customFields.map((x, j) => j === i ? { ...x, active: v } : x) })}
                data-testid={`switch-custom-field-${f.name}`}
              />
              {canEdit && (
                <Button variant="ghost" size="icon" onClick={() => setDraft({ ...draft, customFields: draft.customFields.filter((_, j) => j !== i) })} data-testid={`button-remove-custom-field-${f.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        ))}
        {canEdit && draft.customFields.length < 3 && (
          <div className="flex gap-2">
            <Input
              className="h-8"
              placeholder="Field name"
              value={newFieldName}
              maxLength={30}
              onChange={(e) => setNewFieldName(e.target.value)}
              data-testid="input-new-custom-field"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newFieldName.trim() || draft.customFields.some((f) => f.name === newFieldName.trim())}
              onClick={() => { setDraft({ ...draft, customFields: [...draft.customFields, { name: newFieldName.trim(), active: true }] }); setNewFieldName(""); }}
              data-testid="button-add-custom-field"
            >
              Add
            </Button>
          </div>
        )}
      </Section>

      <Section id="paymentMethods" title="Payment methods">
        <ToggleRow label="Cards" checked={draft.paymentMethods.cards} onChange={(v) => setDraft({ ...draft, paymentMethods: { ...draft.paymentMethods, cards: v } })} testId="switch-pm-cards" />
        <ToggleRow label="Bank transfer" checked={draft.paymentMethods.bankTransfer} onChange={(v) => setDraft({ ...draft, paymentMethods: { ...draft.paymentMethods, bankTransfer: v } })} testId="switch-pm-bankTransfer" />
        <ToggleRow label="PayPal and Venmo" checked={draft.paymentMethods.paypalVenmo} onChange={(v) => setDraft({ ...draft, paymentMethods: { ...draft.paymentMethods, paypalVenmo: v } })} testId="switch-pm-paypalVenmo" />
        <ToggleRow label="Buy now, pay later" checked={draft.paymentMethods.buyNowPayLater} onChange={(v) => setDraft({ ...draft, paymentMethods: { ...draft.paymentMethods, buyNowPayLater: v } })} testId="switch-pm-bnpl" />
        <p className="text-xs text-muted-foreground">Shown to customers on the payment page; actual availability requires Stripe to be configured in Settings.</p>
      </Section>

      <Section id="paymentOptions" title="Payment options">
        <ToggleRow label="Tips" checked={draft.paymentOptions.tips} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, tips: v } })} testId="switch-po-tips" />
        <ToggleRow label="Invoice total" checked={draft.paymentOptions.invoiceTotal} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, invoiceTotal: v } })} testId="switch-po-invoiceTotal" />
        <ToggleRow label="Deposit" checked={draft.paymentOptions.deposit} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, deposit: v } })} testId="switch-po-deposit" />
        <ToggleRow label="Discount" checked={draft.paymentOptions.discount} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, discount: v } })} testId="switch-po-discount" />
        <ToggleRow label="Shipping fee" checked={draft.paymentOptions.shippingFee} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, shippingFee: v } })} testId="switch-po-shippingFee" />
        <ToggleRow label="Late fees" checked={draft.paymentOptions.lateFees} onChange={(v) => setDraft({ ...draft, paymentOptions: { ...draft.paymentOptions, lateFees: v } })} testId="switch-po-lateFees" />
        <p className="text-xs text-muted-foreground">
          Preferences are saved with your company. Tips, deposit, discount, shipping and late
          fees don't change invoice math yet — "Invoice total" controls the total shown on this form.
        </p>
      </Section>

      <Section id="design" title="Design">
        <div className="flex items-center justify-between text-sm">
          <span>Accent color</span>
          <input
            type="color"
            className="h-8 w-16 rounded border border-border bg-background"
            value={draft.design.accentColor}
            disabled={!canEdit}
            onChange={(e) => setDraft({ ...draft, design: { ...draft.design, accentColor: e.target.value } })}
            data-testid="input-accent-color"
          />
        </div>
        <p className="text-xs text-muted-foreground">Used on the form header strip and the invoice total.</p>
      </Section>

      <Section id="scheduling" title="Scheduling">
        <div className="flex items-center justify-between text-sm">
          <span>Default terms</span>
          <Select
            value={String(draft.scheduling.defaultTermsDays)}
            onValueChange={(v) => setDraft({ ...draft, scheduling: { ...draft.scheduling, defaultTermsDays: Number(v) } })}
          >
            <SelectTrigger className="h-8 w-36" data-testid="select-default-terms"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TERMS_OPTIONS.map((t) => <SelectItem key={t.days} value={String(t.days)}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Applied to new invoices. For repeating invoices, use "Make recurring" on the Recurring page.
        </p>
      </Section>

      {canEdit && (
        <Button
          className="w-full mt-3"
          onClick={() => saveMut.mutate()}
          disabled={!orgId || saveMut.isPending}
          data-testid="button-save-invoice-settings"
        >
          {saveMut.isPending ? "Saving…" : "Save settings"}
        </Button>
      )}
    </aside>
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
