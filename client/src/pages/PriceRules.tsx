// ============================================================================
// PRICE RULES (P3.4) — customer-specific & scoped pricing management
// ============================================================================
// Create/list/toggle/delete rules. Resolution happens server-side at line entry
// (GET /api/pricing/resolve); this page only manages the rules. Rules never
// mutate stored item prices — they adjust the rate on the document.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Tag, Plus, Trash2 } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney } from "@/lib/format";

type Rule = {
  id: number; name: string; itemScope: string; category: string | null; customerScope: string;
  adjustType: string; direction: string; percent: number | null; amountCents: number | null;
  startDate: string | null; endDate: string | null; priority: number; isActive: boolean;
  itemIds: number[]; customerIds: number[];
};
type Item = { id: number; name: string; isActive: boolean };
type Customer = { id: number; name: string };

export default function PriceRules() {
  const { toast } = useToast();
  const { data: rules = [] } = useQuery<Rule[]>({ queryKey: ["/api/price-rules"] });
  const { data: items = [] } = useQuery<Item[]>({ queryKey: ["/api/items"] });
  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });

  const empty = {
    name: "", itemScope: "all", category: "", customerScope: "all", adjustType: "percent",
    direction: "discount", percent: "10", amount: "0", startDate: "", endDate: "", priority: "0",
    itemIds: [] as number[], customerIds: [] as number[],
  };
  const [f, setF] = useState({ ...empty });

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/price-rules", {
      name: f.name.trim(),
      itemScope: f.itemScope,
      category: f.itemScope === "category" ? f.category.trim() : undefined,
      customerScope: f.customerScope,
      adjustType: f.adjustType,
      direction: f.direction,
      percent: f.adjustType === "percent" ? Number(f.percent) : undefined,
      amountCents: f.adjustType === "fixed" ? Math.round(Number(f.amount) * 100) : undefined,
      startDate: f.startDate || undefined,
      endDate: f.endDate || undefined,
      priority: Number(f.priority) || 0,
      itemIds: f.itemScope === "list" ? f.itemIds : [],
      customerIds: f.customerScope === "list" ? f.customerIds : [],
    }),
    onSuccess: async () => { setF({ ...empty }); await queryClient.invalidateQueries({ queryKey: ["/api/price-rules"] }); toast({ title: "Price rule created" }); },
    onError: (e: any) => toast({ title: "Could not create rule", description: e.message, variant: "destructive" }),
  });
  const toggle = useMutation({
    mutationFn: (r: Rule) => apiRequest("PATCH", `/api/price-rules/${r.id}`, { isActive: !r.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/price-rules"] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/price-rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/price-rules"] }),
  });

  const scopeText = (r: Rule) => {
    const it = r.itemScope === "all" ? "all items" : r.itemScope === "category" ? `category "${r.category}"` : `${r.itemIds.length} item(s)`;
    const cu = r.customerScope === "all" ? "all customers" : `${r.customerIds.length} customer(s)`;
    return `${it} · ${cu}`;
  };
  const adjText = (r: Rule) => r.adjustType === "percent"
    ? `${r.direction === "discount" ? "−" : "+"}${r.percent}%`
    : `${r.direction === "discount" ? "−" : "+"}${fmtMoney(r.amountCents ?? 0)}`;

  return (
    <Layout>
      <PageHeader title="Price rules" description="Customer-specific and scoped pricing, applied at invoice/estimate line entry. Rules never change stored item prices." />
      <div className="space-y-4">
        <Card data-testid="card-price-rules-list">
          <CardHeader><CardTitle className="flex items-center gap-2"><Tag className="h-5 w-5" /> Rules ({rules.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {rules.length === 0 && <p className="text-sm text-muted-foreground">No price rules yet.</p>}
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-md border p-2 text-sm" data-testid={`rule-row-${r.id}`}>
                <span className="font-medium">{r.name}</span>
                <Badge variant="secondary">{adjText(r)}</Badge>
                <span className="text-muted-foreground">{scopeText(r)}</span>
                {(r.startDate || r.endDate) && <span className="text-xs text-muted-foreground">{r.startDate ?? "…"} → {r.endDate ?? "…"}</span>}
                <Badge variant="outline">priority {r.priority}</Badge>
                <div className="ml-auto flex items-center gap-2">
                  <button className="text-xs underline text-muted-foreground" onClick={() => toggle.mutate(r)} data-testid={`toggle-rule-${r.id}`}>{r.isActive ? "Disable" : "Enable"}</button>
                  <button className="text-muted-foreground hover:text-destructive" onClick={() => del.mutate(r.id)} data-testid={`delete-rule-${r.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card data-testid="card-price-rule-create">
          <CardHeader><CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5" /> New rule</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Acme contract rate" data-testid="input-rule-name" /></div>
              <div>
                <Label>Adjustment</Label>
                <select className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={f.adjustType} onChange={(e) => setF({ ...f, adjustType: e.target.value })} data-testid="select-rule-adjust">
                  <option value="percent">Percent</option><option value="fixed">Fixed amount</option>
                </select>
              </div>
              <div>
                <Label>Direction</Label>
                <select className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} data-testid="select-rule-direction">
                  <option value="discount">Discount</option><option value="surcharge">Surcharge</option>
                </select>
              </div>
              {f.adjustType === "percent"
                ? <div><Label>Percent (%)</Label><Input type="number" step="0.1" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} data-testid="input-rule-percent" /></div>
                : <div><Label>Amount ($)</Label><Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} data-testid="input-rule-amount" /></div>}
              <div><Label>Priority</Label><Input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} data-testid="input-rule-priority" /></div>
              <div><Label>Start date</Label><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} data-testid="input-rule-start" /></div>
              <div><Label>End date</Label><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} data-testid="input-rule-end" /></div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Applies to items</Label>
                <select className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={f.itemScope} onChange={(e) => setF({ ...f, itemScope: e.target.value })} data-testid="select-rule-item-scope">
                  <option value="all">All items</option><option value="list">Specific items</option><option value="category">Category</option>
                </select>
                {f.itemScope === "category" && <Input className="mt-1" placeholder="category name" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="input-rule-category" />}
                {f.itemScope === "list" && (
                  <select multiple className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm h-24" value={f.itemIds.map(String)}
                    onChange={(e) => setF({ ...f, itemIds: Array.from(e.target.selectedOptions).map((o) => Number(o.value)) })} data-testid="select-rule-items">
                    {items.filter((it) => it.isActive).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <Label>Applies to customers</Label>
                <select className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={f.customerScope} onChange={(e) => setF({ ...f, customerScope: e.target.value })} data-testid="select-rule-cust-scope">
                  <option value="all">All customers</option><option value="list">Specific customers</option>
                </select>
                {f.customerScope === "list" && (
                  <select multiple className="mt-1 block w-full rounded-md border bg-background px-2 py-1 text-sm h-24" value={f.customerIds.map(String)}
                    onChange={(e) => setF({ ...f, customerIds: Array.from(e.target.selectedOptions).map((o) => Number(o.value)) })} data-testid="select-rule-customers">
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </div>
            </div>

            <Button disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate()} data-testid="button-create-rule">
              {create.isPending ? "Creating…" : "Create rule"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
