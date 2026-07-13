// ============================================================================
// PRODUCTS & SERVICES (QBO "Lists → Products and services")
// ============================================================================
// A catalog of the items sold on invoices and bought on bills. Backed by the
// existing /api/items CRUD. Inventory items require an inventory asset account
// (where stock capitalizes); service / non-inventory items don't. Quantity on
// hand and average cost are server-maintained from movements — read-only here.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Package } from "lucide-react";
import type { Account, Item, ItemType } from "@shared/schema";
import { useOpenOnCreateParam } from "@/lib/create-shortcut";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney } from "@/lib/format";

const TYPE_LABEL: Record<ItemType, string> = {
  inventory: "Inventory",
  service: "Service",
  noninventory: "Non-inventory",
};

type FormState = {
  id: number | null;
  sku: string;
  name: string;
  description: string;
  type: ItemType;
  salesAccountId: number | null;
  expenseAccountId: number | null;
  cogsAccountId: number | null;
  inventoryAssetAccountId: number | null;
  isActive: boolean;
};

const blank: FormState = {
  id: null, sku: "", name: "", description: "", type: "service",
  salesAccountId: null, expenseAccountId: null, cogsAccountId: null, inventoryAssetAccountId: null, isActive: true,
};

export default function ProductsServices() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blank);

  const { data: itemsRaw } = useQuery<any>({
    queryKey: ["/api/items"],
    queryFn: async () => (await apiRequest("GET", "/api/items?limit=200")).json(),
  });
  const items: Item[] = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw?.rows ?? [];
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });

  const incomeAccts = accounts.filter((a) => a.type === "income");
  const expenseAccts = accounts.filter((a) => a.type === "expense");
  const assetAccts = accounts.filter((a) => a.type === "asset");

  function openNew() {
    setForm({
      ...blank,
      salesAccountId: incomeAccts[0]?.id ?? null,
      expenseAccountId: expenseAccts[0]?.id ?? null,
      cogsAccountId: expenseAccts[0]?.id ?? null,
    });
    setOpen(true);
  }
  useOpenOnCreateParam(openNew); // global "+ Create → Add product/service"

  // If the dialog opens for a NEW item before accounts finished loading, fill
  // the required account pickers as soon as they arrive (avoids a stuck form).
  useEffect(() => {
    if (!open || form.id !== null) return;
    setForm((f) => ({
      ...f,
      salesAccountId: f.salesAccountId ?? incomeAccts[0]?.id ?? null,
      expenseAccountId: f.expenseAccountId ?? expenseAccts[0]?.id ?? null,
      cogsAccountId: f.cogsAccountId ?? expenseAccts[0]?.id ?? null,
    }));
  }, [open, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  function openEdit(it: Item) {
    setForm({
      id: it.id, sku: it.sku, name: it.name, description: it.description ?? "",
      type: it.type as ItemType,
      salesAccountId: it.salesAccountId, expenseAccountId: it.expenseAccountId,
      cogsAccountId: it.cogsAccountId, inventoryAssetAccountId: it.inventoryAssetAccountId ?? null,
      isActive: it.isActive,
    });
    setOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        sku: form.sku.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        type: form.type,
        salesAccountId: form.salesAccountId,
        expenseAccountId: form.expenseAccountId,
        cogsAccountId: form.cogsAccountId,
        inventoryAssetAccountId: form.type === "inventory" ? form.inventoryAssetAccountId : null,
        isActive: form.isActive,
      };
      const r = form.id
        ? await apiRequest("PATCH", `/api/items/${form.id}`, body)
        : await apiRequest("POST", "/api/items", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/items"] });
      setOpen(false);
      toast({ title: form.id ? "Item updated" : "Item added" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: async (it: Item) => apiRequest("PATCH", `/api/items/${it.id}`, { isActive: !it.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/items"] }),
  });

  const needsInventoryAsset = form.type === "inventory";
  const canSave =
    !!form.sku.trim() && !!form.name.trim() && !!form.salesAccountId && !!form.expenseAccountId &&
    !!form.cogsAccountId && (!needsInventoryAsset || !!form.inventoryAssetAccountId) && !saveMut.isPending;

  return (
    <Layout>
      <PageHeader
        title="Products and services"
        description="The items you sell on invoices and buy on bills"
        actions={<Button onClick={openNew} data-testid="button-new-item"><Plus className="h-4 w-4 mr-1.5" />New item</Button>}
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium text-right">On hand</th>
                <th className="px-4 py-3 font-medium text-right">Avg cost</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-28"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No products or services yet.</td></tr>
              )}
              {items.map((it) => (
                <tr key={it.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-item-${it.id}`}>
                  <td className="px-4 py-3 font-medium">{it.sku}</td>
                  <td className="px-4 py-3">{it.name}</td>
                  <td className="px-4 py-3"><Badge variant="outline">{TYPE_LABEL[it.type as ItemType] ?? it.type}</Badge></td>
                  <td className="px-4 py-3 text-right tabular-nums">{it.type === "inventory" ? it.quantityOnHand : "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{it.type === "inventory" ? fmtMoney(it.avgCostCents) : "—"}</td>
                  <td className="px-4 py-3">
                    <Badge variant={it.isActive ? "default" : "secondary"}>{it.isActive ? "Active" : "Inactive"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(it)} data-testid={`button-edit-item-${it.id}`}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleMut.mutate(it)} data-testid={`button-toggle-item-${it.id}`}>
                        {it.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Package className="h-5 w-5" />{form.id ? "Edit item" : "New item"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>SKU</Label>
                <Input data-testid="input-item-sku" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </div>
              <div>
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as ItemType })}>
                  <SelectTrigger data-testid="select-item-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="noninventory">Non-inventory</SelectItem>
                    <SelectItem value="inventory">Inventory</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Name</Label>
              <Input data-testid="input-item-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea data-testid="input-item-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <AccountPick label="Income account" testId="select-item-sales" accts={incomeAccts} value={form.salesAccountId} onChange={(v) => setForm({ ...form, salesAccountId: v })} />
              <AccountPick label="Expense account" testId="select-item-expense" accts={expenseAccts} value={form.expenseAccountId} onChange={(v) => setForm({ ...form, expenseAccountId: v })} />
              <AccountPick label="COGS account" testId="select-item-cogs" accts={expenseAccts} value={form.cogsAccountId} onChange={(v) => setForm({ ...form, cogsAccountId: v })} />
              {needsInventoryAsset && (
                <AccountPick label="Inventory asset account" testId="select-item-asset" accts={assetAccts} value={form.inventoryAssetAccountId} onChange={(v) => setForm({ ...form, inventoryAssetAccountId: v })} />
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} data-testid="checkbox-item-active" />
              Active
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!canSave} onClick={() => saveMut.mutate()} data-testid="button-save-item">
              {saveMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

function AccountPick({ label, testId, accts, value, onChange }: {
  label: string; testId: string; accts: Account[]; value: number | null; onChange: (v: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value?.toString() ?? ""} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="—" /></SelectTrigger>
        <SelectContent>
          {accts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
