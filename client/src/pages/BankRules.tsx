import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Filter, Pencil, Zap } from "lucide-react";
import type { Account, BankRule } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fmtMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

type RuleForm = {
  name: string;
  priority: number;
  isActive: boolean;
  bankAccountId: string; // "" = any
  descriptionContains: string;
  amountComparator: string; // "" | comparator
  amountMin: string;
  amountMax: string;
  direction: string; // "" | "in" | "out"
  actionType: "categorize" | "transfer" | "ignore";
  categoryAccountId: string;
  transferAccountId: string;
  payeeVendorId: string;
  autoPost: boolean;
};

const blankForm: RuleForm = {
  name: "",
  priority: 100,
  isActive: true,
  bankAccountId: "",
  descriptionContains: "",
  amountComparator: "",
  amountMin: "",
  amountMax: "",
  direction: "",
  actionType: "categorize",
  categoryAccountId: "",
  transferAccountId: "",
  payeeVendorId: "",
  autoPost: true,
};

export default function BankRules() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleForm>(blankForm);

  const { data: rules = [] } = useQuery<BankRule[]>({ queryKey: ["/api/bank-rules"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: vendors = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/vendors"] });

  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const categoryAccts = accounts.filter((a) =>
    ["income", "expense", "asset", "liability", "equity"].includes(a.type)
  );

  function openNew() {
    setEditingId(null);
    setForm(blankForm);
    setOpen(true);
  }
  function openEdit(r: BankRule) {
    setEditingId(r.id);
    setForm({
      name: r.name,
      priority: r.priority,
      isActive: r.isActive,
      bankAccountId: r.bankAccountId?.toString() ?? "",
      descriptionContains: r.descriptionContains ?? "",
      amountComparator: r.amountComparator ?? "",
      // API stores rule thresholds in integer cents — the form inputs are dollars
      amountMin: r.amountMin != null ? (r.amountMin / 100).toString() : "",
      amountMax: r.amountMax != null ? (r.amountMax / 100).toString() : "",
      direction: r.direction ?? "",
      actionType: (r.actionType as any) ?? "categorize",
      categoryAccountId: r.categoryAccountId?.toString() ?? "",
      transferAccountId: r.transferAccountId?.toString() ?? "",
      payeeVendorId: (r as any).payeeVendorId?.toString() ?? "",
      autoPost: r.autoPost,
    });
    setOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async (f: RuleForm) => {
      const body: any = {
        name: f.name,
        priority: Number(f.priority) || 100,
        isActive: f.isActive,
        bankAccountId: f.bankAccountId ? Number(f.bankAccountId) : null,
        descriptionContains: f.descriptionContains || undefined,
        amountComparator: f.amountComparator || undefined,
        amountMin: f.amountMin ? Number(f.amountMin) : undefined,
        amountMax: f.amountMax ? Number(f.amountMax) : undefined,
        direction: f.direction ? f.direction : null,
        actionType: f.actionType,
        categoryAccountId: f.actionType === "categorize" && f.categoryAccountId ? Number(f.categoryAccountId) : null,
        transferAccountId: f.actionType === "transfer" && f.transferAccountId ? Number(f.transferAccountId) : null,
        payeeVendorId: f.actionType === "categorize" && f.payeeVendorId ? Number(f.payeeVendorId) : null,
        autoPost: f.autoPost,
      };
      if (editingId) {
        const r = await apiRequest("PATCH", `/api/bank-rules/${editingId}`, body);
        return r.json();
      }
      const r = await apiRequest("POST", "/api/bank-rules", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-rules"] });
      setOpen(false);
      toast({ title: editingId ? "Rule updated" : "Rule created" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/bank-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-rules"] });
      toast({ title: "Rule deleted" });
    },
  });

  const applyMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/bank-rules/apply", {});
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-rules"] });
      toast({
        title: "Rules applied",
        description: `${data.autoMatched ?? 0} transaction(s) auto-matched.`,
      });
    },
    onError: (e: any) => toast({ title: "Apply failed", description: e.message, variant: "destructive" }),
  });

  const acctName = (id: number | null | undefined) => {
    if (!id) return "—";
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : `#${id}`;
  };

  return (
    <Layout>
      <PageHeader
        title="Bank Rules"
        description="Auto-categorize imported bank transactions. Rules run in priority order — lowest first."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => applyMut.mutate()}
              disabled={applyMut.isPending}
              data-testid="button-apply-rules"
            >
              <Zap className="h-4 w-4 mr-1.5" />
              {applyMut.isPending ? "Applying…" : "Apply to unmatched"}
            </Button>
            <Button onClick={openNew} data-testid="button-new-rule">
              <Plus className="h-4 w-4 mr-1.5" />
              New rule
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium w-16">Priority</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Match</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium w-20 text-right">Hits</th>
                <th className="px-4 py-3 font-medium w-20">Active</th>
                <th className="px-4 py-3 font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <Filter className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No rules yet. Create one to auto-categorize bank transactions.
                  </td>
                </tr>
              )}
              {rules.map((r) => {
                const matchParts: string[] = [];
                if (r.descriptionContains) matchParts.push(`desc ~ "${r.descriptionContains}"`);
                if (r.direction) matchParts.push(r.direction === "in" ? "deposits" : "withdrawals");
                if (r.amountComparator) {
                  if (r.amountComparator === "between") {
                    matchParts.push(`${fmtMoney(r.amountMin)}–${fmtMoney(r.amountMax)}`);
                  } else {
                    matchParts.push(`amt ${r.amountComparator} ${fmtMoney(r.amountMin)}`);
                  }
                }
                if (r.bankAccountId) matchParts.push(acctName(r.bankAccountId));
                return (
                  <tr key={r.id} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-rule-${r.id}`}>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{r.priority}</td>
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {matchParts.length > 0 ? matchParts.join(" · ") : <span className="italic">any</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium capitalize">{r.actionType}</span>
                      {r.actionType === "categorize" && (
                        <span className="text-muted-foreground"> → {acctName(r.categoryAccountId)}</span>
                      )}
                      {r.actionType === "transfer" && (
                        <span className="text-muted-foreground"> → {acctName(r.transferAccountId)}</span>
                      )}
                      {!r.autoPost && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">suggest only</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.hits}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          r.isActive
                            ? "text-xs px-2 py-0.5 rounded bg-primary/15 text-primary"
                            : "text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                        }
                      >
                        {r.isActive ? "Active" : "Off"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(r)} data-testid={`button-edit-rule-${r.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(`Delete rule "${r.name}"?`)) delMut.mutate(r.id);
                          }}
                          data-testid={`button-delete-rule-${r.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit rule" : "New bank rule"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label htmlFor="rname">Rule name</Label>
                <Input
                  id="rname"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. AWS hosting → Software"
                  data-testid="input-rule-name"
                />
              </div>
              <div>
                <Label htmlFor="rprio">Priority</Label>
                <Input
                  id="rprio"
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  data-testid="input-rule-priority"
                />
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-medium mb-3">Match conditions</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Bank account</Label>
                  <Select
                    value={form.bankAccountId || "any"}
                    onValueChange={(v) => setForm({ ...form, bankAccountId: v === "any" ? "" : v })}
                  >
                    <SelectTrigger data-testid="select-rule-bank">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any bank account</SelectItem>
                      {bankAccts.map((a) => (
                        <SelectItem key={a.id} value={a.id.toString()}>
                          {a.code} {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Direction</Label>
                  <Select
                    value={form.direction || "any"}
                    onValueChange={(v) => setForm({ ...form, direction: v === "any" ? "" : v })}
                  >
                    <SelectTrigger data-testid="select-rule-direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any (deposits or withdrawals)</SelectItem>
                      <SelectItem value="in">Deposits only</SelectItem>
                      <SelectItem value="out">Withdrawals only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-3">
                <Label htmlFor="rdesc">Description contains</Label>
                <Input
                  id="rdesc"
                  value={form.descriptionContains}
                  onChange={(e) => setForm({ ...form, descriptionContains: e.target.value })}
                  placeholder="e.g. AWS, STRIPE PAYOUT, UBER"
                  data-testid="input-rule-desc"
                />
                <p className="text-xs text-muted-foreground mt-1">Case-insensitive substring match.</p>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-3">
                <div>
                  <Label>Amount</Label>
                  <Select
                    value={form.amountComparator || "none"}
                    onValueChange={(v) => setForm({ ...form, amountComparator: v === "none" ? "" : v })}
                  >
                    <SelectTrigger data-testid="select-rule-cmp">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No filter</SelectItem>
                      <SelectItem value="eq">Equals</SelectItem>
                      <SelectItem value="gt">Greater than</SelectItem>
                      <SelectItem value="gte">Greater or equal</SelectItem>
                      <SelectItem value="lt">Less than</SelectItem>
                      <SelectItem value="lte">Less or equal</SelectItem>
                      <SelectItem value="between">Between</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.amountComparator && (
                  <div>
                    <Label htmlFor="rmin">{form.amountComparator === "between" ? "Min" : "Amount"}</Label>
                    <Input
                      id="rmin"
                      type="number"
                      step="0.01"
                      value={form.amountMin}
                      onChange={(e) => setForm({ ...form, amountMin: e.target.value })}
                      data-testid="input-rule-min"
                    />
                  </div>
                )}
                {form.amountComparator === "between" && (
                  <div>
                    <Label htmlFor="rmax">Max</Label>
                    <Input
                      id="rmax"
                      type="number"
                      step="0.01"
                      value={form.amountMax}
                      onChange={(e) => setForm({ ...form, amountMax: e.target.value })}
                      data-testid="input-rule-max"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-medium mb-3">Action</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Action type</Label>
                  <Select
                    value={form.actionType}
                    onValueChange={(v: any) => setForm({ ...form, actionType: v })}
                  >
                    <SelectTrigger data-testid="select-rule-action">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="categorize">Categorize to account</SelectItem>
                      <SelectItem value="transfer">Transfer between accounts</SelectItem>
                      <SelectItem value="ignore">Ignore (skip)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.actionType === "categorize" && (
                  <div>
                    <Label>Category account</Label>
                    <Select
                      value={form.categoryAccountId}
                      onValueChange={(v) => setForm({ ...form, categoryAccountId: v })}
                    >
                      <SelectTrigger data-testid="select-rule-cat">
                        <SelectValue placeholder="Choose account" />
                      </SelectTrigger>
                      <SelectContent>
                        {categoryAccts.map((a) => (
                          <SelectItem key={a.id} value={a.id.toString()}>
                            {a.code} {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {vendors.length > 0 && (
                      <div className="mt-3">
                        <Label>Payee (vendor) <span className="text-muted-foreground font-normal">— optional</span></Label>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          data-testid="select-rule-payee"
                          value={form.payeeVendorId}
                          onChange={(e) => setForm({ ...form, payeeVendorId: e.target.value })}
                        >
                          <option value="">— None —</option>
                          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}
                {form.actionType === "transfer" && (
                  <div>
                    <Label>Transfer account</Label>
                    <Select
                      value={form.transferAccountId}
                      onValueChange={(v) => setForm({ ...form, transferAccountId: v })}
                    >
                      <SelectTrigger data-testid="select-rule-xfer">
                        <SelectValue placeholder="Choose account" />
                      </SelectTrigger>
                      <SelectContent>
                        {bankAccts.map((a) => (
                          <SelectItem key={a.id} value={a.id.toString()}>
                            {a.code} {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mt-4 gap-6">
                <div className="flex items-center gap-3">
                  <Switch
                    id="autopost"
                    checked={form.autoPost}
                    onCheckedChange={(v) => setForm({ ...form, autoPost: v })}
                    data-testid="switch-rule-autopost"
                  />
                  <Label htmlFor="autopost" className="cursor-pointer">
                    Auto-post (otherwise just suggest)
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="active"
                    checked={form.isActive}
                    onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                    data-testid="switch-rule-active"
                  />
                  <Label htmlFor="active" className="cursor-pointer">Active</Label>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.name || saveMut.isPending}
              onClick={() => saveMut.mutate(form)}
              data-testid="button-save-rule"
            >
              {saveMut.isPending ? "Saving…" : editingId ? "Update rule" : "Create rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
