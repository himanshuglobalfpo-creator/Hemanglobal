// ============================================================================
// FIXED ASSETS — /fixed-assets
// ============================================================================
// Register capitalized assets, post monthly depreciation, and dispose (sell /
// scrap) over /api/fixed-assets. Cost/salvage/proceeds are entered in dollars
// and converted to integer cents at the API boundary.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, TrendingDown, Banknote } from "lucide-react";
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

type FixedAsset = { id: number; name: string; acquisitionDate: string; costCents: number; salvageCents: number; usefulLifeMonths: number; method: string; status: string };

const METHOD_LABEL: Record<string, string> = { straight_line: "Straight line", double_declining: "Double declining" };
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default", disposed: "destructive", fully_depreciated: "outline",
};
const thisMonth = () => todayISO().slice(0, 7);

export default function FixedAssets() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [disposeId, setDisposeId] = useState<number | null>(null);
  const [period, setPeriod] = useState(thisMonth());

  const { data: raw } = useQuery<any>({ queryKey: ["/api/fixed-assets"], queryFn: async () => (await apiRequest("GET", "/api/fixed-assets?limit=200")).json() });
  const assets: FixedAsset[] = Array.isArray(raw) ? raw : raw?.rows ?? [];
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const assetAccts = accounts.filter((a) => a.type === "asset");
  const expenseAccts = accounts.filter((a) => a.type === "expense");

  const [form, setForm] = useState({
    name: "", acquisitionDate: todayISO(), cost: "", salvage: "0", usefulLifeMonths: 60, method: "straight_line",
    assetAccountId: null as number | null, accumDepAccountId: null as number | null, depreciationExpenseAccountId: null as number | null,
  });

  function openCreate() {
    setForm({ name: "", acquisitionDate: todayISO(), cost: "", salvage: "0", usefulLifeMonths: 60, method: "straight_line",
      assetAccountId: assetAccts[0]?.id ?? null, accumDepAccountId: assetAccts[0]?.id ?? null, depreciationExpenseAccountId: expenseAccts[0]?.id ?? null });
    setOpen(true);
  }
  useOpenOnCreateParam(openCreate);

  const createMut = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(), acquisitionDate: form.acquisitionDate,
        costCents: Math.round(parseFloat(form.cost) * 100), salvageCents: Math.round(parseFloat(form.salvage || "0") * 100),
        usefulLifeMonths: form.usefulLifeMonths, method: form.method,
        assetAccountId: form.assetAccountId, accumDepAccountId: form.accumDepAccountId, depreciationExpenseAccountId: form.depreciationExpenseAccountId,
      };
      return (await apiRequest("POST", "/api/fixed-assets", body)).json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/fixed-assets"] }); setOpen(false); toast({ title: "Asset registered" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const depMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/fixed-assets/${id}/post-depreciation?period=${period}`, {})).json(),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/fixed-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      toast({ title: data.posted ? "Depreciation posted" : "Nothing to depreciate", description: `${period}: ${fmtMoney(data.amountCents ?? 0)}` });
    },
    onError: (e: any) => toast({ title: "Post failed", description: e.message, variant: "destructive" }),
  });

  const canSave = !!form.name.trim() && parseFloat(form.cost) > 0 && !!form.assetAccountId && !!form.accumDepAccountId && !!form.depreciationExpenseAccountId && !createMut.isPending;

  return (
    <Layout>
      <PageHeader
        title="Fixed assets"
        description="Capitalize assets, post depreciation, and record disposals"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5"><Label className="text-xs text-muted-foreground">Period</Label><Input type="month" className="h-9 w-36" data-testid="input-dep-period" value={period} onChange={(e) => setPeriod(e.target.value)} /></div>
            <Button onClick={openCreate} data-testid="button-new-asset"><Plus className="h-4 w-4 mr-1.5" />Register asset</Button>
          </div>
        }
      />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Acquired</th>
                <th className="px-4 py-3 font-medium text-right">Cost</th><th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Life</th><th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-56"></th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No fixed assets yet.</td></tr>}
              {assets.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-asset-${a.id}`}>
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(a.acquisitionDate)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(a.costCents)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{METHOD_LABEL[a.method] ?? a.method}</td>
                  <td className="px-4 py-3 text-muted-foreground">{a.usefulLifeMonths} mo</td>
                  <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[a.status] ?? "secondary"} className="capitalize">{a.status.replace(/_/g, " ")}</Badge></td>
                  <td className="px-4 py-3 text-right">
                    {a.status === "active" && (
                      <div className="flex items-center gap-1 justify-end">
                        <Button size="sm" variant="outline" onClick={() => depMut.mutate(a.id)} disabled={depMut.isPending} data-testid={`button-depreciate-asset-${a.id}`}><TrendingDown className="h-3.5 w-3.5 mr-1" />Depreciate</Button>
                        <Button size="sm" variant="ghost" onClick={() => setDisposeId(a.id)} data-testid={`button-dispose-asset-${a.id}`}><Banknote className="h-3.5 w-3.5 mr-1" />Dispose</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Register fixed asset</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input data-testid="input-asset-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Acquisition date</Label><Input type="date" data-testid="input-asset-date" value={form.acquisitionDate} onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })} /></div>
              <div><Label>Method</Label>
                <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })}>
                  <SelectTrigger data-testid="select-asset-method"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="straight_line">Straight line</SelectItem><SelectItem value="double_declining">Double declining</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>Cost</Label><Input type="number" step="0.01" data-testid="input-asset-cost" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></div>
              <div><Label>Salvage value</Label><Input type="number" step="0.01" data-testid="input-asset-salvage" value={form.salvage} onChange={(e) => setForm({ ...form, salvage: e.target.value })} /></div>
              <div><Label>Useful life (months)</Label><Input type="number" step="1" data-testid="input-asset-life" value={form.usefulLifeMonths} onChange={(e) => setForm({ ...form, usefulLifeMonths: Number(e.target.value) })} /></div>
            </div>
            <AccountPick label="Asset account" testId="select-asset-account" accts={assetAccts} value={form.assetAccountId} onChange={(v) => setForm({ ...form, assetAccountId: v })} />
            <AccountPick label="Accumulated depreciation account" testId="select-accum-dep-account" accts={assetAccts} value={form.accumDepAccountId} onChange={(v) => setForm({ ...form, accumDepAccountId: v })} />
            <AccountPick label="Depreciation expense account" testId="select-dep-expense-account" accts={expenseAccts} value={form.depreciationExpenseAccountId} onChange={(v) => setForm({ ...form, depreciationExpenseAccountId: v })} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!canSave} onClick={() => createMut.mutate()} data-testid="button-save-asset">{createMut.isPending ? "Saving…" : "Register asset"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {disposeId !== null && <DisposeDialog assetId={disposeId} accounts={accounts} onClose={() => setDisposeId(null)} />}
    </Layout>
  );
}

function AccountPick({ label, testId, accts, value, onChange }: { label: string; testId: string; accts: Account[]; value: number | null; onChange: (v: number) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value?.toString() ?? ""} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger data-testid={testId}><SelectValue placeholder="—" /></SelectTrigger>
        <SelectContent>{accts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

function DisposeDialog({ assetId, accounts, onClose }: { assetId: number; accounts: Account[]; onClose: () => void }) {
  const { toast } = useToast();
  const [date, setDate] = useState(todayISO());
  const [proceeds, setProceeds] = useState("0");
  const [proceedsAccountId, setProceedsAccountId] = useState<number | null>(null);
  const [gainLossAccountId, setGainLossAccountId] = useState<number | null>(null);
  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const glAccts = accounts.filter((a) => a.type === "income" || a.type === "expense");

  const disposeMut = useMutation({
    mutationFn: async () => {
      const proceedsCents = Math.round(parseFloat(proceeds || "0") * 100);
      const body: any = { date, proceedsCents, gainLossAccountId };
      if (proceedsCents > 0) body.proceedsAccountId = proceedsAccountId;
      return (await apiRequest("POST", `/api/fixed-assets/${assetId}/dispose`, body)).json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/fixed-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      toast({ title: "Asset disposed", description: `Gain/loss ${fmtMoney(data.gainLossCents ?? 0)} on disposal.` });
      onClose();
    },
    onError: (e: any) => toast({ title: "Dispose failed", description: e.message, variant: "destructive" }),
  });

  const proceedsCents = Math.round(parseFloat(proceeds || "0") * 100);
  const canDispose = !!date && !!gainLossAccountId && (proceedsCents === 0 || !!proceedsAccountId) && !disposeMut.isPending;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Dispose asset</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Disposal date</Label><Input type="date" data-testid="input-dispose-date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><Label>Proceeds</Label><Input type="number" step="0.01" data-testid="input-dispose-proceeds" value={proceeds} onChange={(e) => setProceeds(e.target.value)} /></div>
          </div>
          {proceedsCents > 0 && (
            <div>
              <Label>Proceeds deposited to</Label>
              <Select value={proceedsAccountId?.toString() ?? ""} onValueChange={(v) => setProceedsAccountId(Number(v))}>
                <SelectTrigger data-testid="select-dispose-proceeds-account"><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>{bankAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Gain/loss account</Label>
            <Select value={gainLossAccountId?.toString() ?? ""} onValueChange={(v) => setGainLossAccountId(Number(v))}>
              <SelectTrigger data-testid="select-dispose-gainloss-account"><SelectValue placeholder="Income or expense account" /></SelectTrigger>
              <SelectContent>{glAccts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!canDispose} onClick={() => disposeMut.mutate()} data-testid="button-confirm-dispose">{disposeMut.isPending ? "Disposing…" : "Dispose asset"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
