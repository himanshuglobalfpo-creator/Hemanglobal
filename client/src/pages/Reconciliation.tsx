import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Plus, ArrowLeft, CheckSquare, Lock } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Account, BankTransaction, Reconciliation } from "@shared/schema";

type ReconDetail = {
  reconciliation: Reconciliation;
  transactions: Array<BankTransaction & { cleared: boolean }>;
  totals: {
    beginningBalance: number;
    endingBalance: number;
    clearedDeposits: number;
    clearedWithdrawals: number;
    bookBalance: number;
    difference: number;
  };
};

function fmt(n: number) {
  // API money is integer cents — display boundary divides by 100
  return (n / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function ReconciliationPage() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (selectedId) {
    return <ReconDetailView reconId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return <ReconListView onSelect={setSelectedId} toastFn={toast} />;
}

function ReconListView({
  onSelect,
  toastFn,
}: {
  onSelect: (id: number) => void;
  toastFn: ReturnType<typeof useToast>["toast"];
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    bankAccountId: "",
    statementDate: new Date().toISOString().slice(0, 10),
    beginningBalance: "0",
    endingBalance: "",
  });

  const { data: recons = [] } = useQuery<Reconciliation[]>({ queryKey: ["/api/reconciliations"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const bankAccts = accounts.filter((a) => a.subtype === "bank");
  const acctName = (id: number) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : `#${id}`;
  };

  const startMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/reconciliations", {
        bankAccountId: Number(form.bankAccountId),
        statementDate: form.statementDate,
        beginningBalance: Number(form.beginningBalance) || 0,
        endingBalance: Number(form.endingBalance) || 0,
      });
      return r.json();
    },
    onSuccess: (data: Reconciliation) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliations"] });
      setOpen(false);
      onSelect(data.id);
    },
    onError: (e: any) => toastFn({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Layout>
      <PageHeader
        title="Reconciliation"
        description="Match your books to your bank statement."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-start-recon">
                <Plus className="h-4 w-4 mr-1.5" />
                Start reconciliation
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Start a new reconciliation</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Bank account</Label>
                  <Select
                    value={form.bankAccountId}
                    onValueChange={(v) => setForm({ ...form, bankAccountId: v })}
                  >
                    <SelectTrigger data-testid="select-recon-account">
                      <SelectValue placeholder="Pick account" />
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
                <div>
                  <Label htmlFor="sdate">Statement ending date</Label>
                  <Input
                    id="sdate"
                    type="date"
                    value={form.statementDate}
                    onChange={(e) => setForm({ ...form, statementDate: e.target.value })}
                    data-testid="input-recon-date"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="beg">Beginning balance</Label>
                    <Input
                      id="beg"
                      type="number"
                      step="0.01"
                      value={form.beginningBalance}
                      onChange={(e) => setForm({ ...form, beginningBalance: e.target.value })}
                      data-testid="input-recon-beg"
                    />
                  </div>
                  <div>
                    <Label htmlFor="end">Ending balance (from statement)</Label>
                    <Input
                      id="end"
                      type="number"
                      step="0.01"
                      value={form.endingBalance}
                      onChange={(e) => setForm({ ...form, endingBalance: e.target.value })}
                      data-testid="input-recon-end"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button
                  disabled={!form.bankAccountId || !form.statementDate || startMut.isPending}
                  onClick={() => startMut.mutate()}
                  data-testid="button-confirm-start-recon"
                >
                  {startMut.isPending ? "Starting…" : "Start"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Statement date</th>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium text-right">Beginning</th>
                <th className="px-4 py-3 font-medium text-right">Ending</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {recons.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No reconciliations yet. Start one to match your books to a bank statement.
                  </td>
                </tr>
              )}
              {recons.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border last:border-0 hover-elevate cursor-pointer"
                  onClick={() => onSelect(r.id)}
                  data-testid={`row-recon-${r.id}`}
                >
                  <td className="px-4 py-3 font-medium">{r.statementDate}</td>
                  <td className="px-4 py-3 text-muted-foreground">{acctName(r.bankAccountId)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.beginningBalance)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.endingBalance)}</td>
                  <td className="px-4 py-3">
                    {r.status === "completed" ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary inline-flex items-center gap-1">
                        <Lock className="h-3 w-3" /> Completed
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400">
                        In progress
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onSelect(r.id); }}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </Layout>
  );
}

function ReconDetailView({ reconId, onBack }: { reconId: number; onBack: () => void }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ReconDetail>({
    queryKey: ["/api/reconciliations", reconId],
  });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const acctName = (id: number) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : `#${id}`;
  };

  const toggleMut = useMutation({
    mutationFn: async ({ btId, cleared }: { btId: number; cleared: boolean }) => {
      const r = await apiRequest("POST", `/api/reconciliations/${reconId}/toggle`, {
        bankTransactionId: btId,
        cleared,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliations", reconId] });
    },
    onError: (e: any) => toast({ title: "Toggle failed", description: e.message, variant: "destructive" }),
  });

  const completeMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/reconciliations/${reconId}/complete`, {});
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliations", reconId] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliations"] });
      toast({ title: "Reconciliation locked", description: "Books match the statement." });
    },
    onError: (e: any) => toast({ title: "Cannot complete", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <Layout>
        <div className="text-muted-foreground">Loading reconciliation…</div>
      </Layout>
    );
  }

  const recon = data.reconciliation;
  const isLocked = recon.status === "completed";
  const deposits = data.transactions.filter((t) => t.amount > 0);
  const withdrawals = data.transactions.filter((t) => t.amount < 0);
  const diffOk = data.totals.difference === 0; // exact integer cents

  return (
    <Layout>
      <PageHeader
        title={`Reconciliation · ${recon.statementDate}`}
        description={`${acctName(recon.bankAccountId)} — ${isLocked ? "Locked" : "Tick off transactions until the difference is $0.00"}`}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onBack} data-testid="button-back-recon">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Back
            </Button>
            {!isLocked && (
              <Button
                disabled={!diffOk || completeMut.isPending}
                onClick={() => completeMut.mutate()}
                data-testid="button-complete-recon"
              >
                <Lock className="h-4 w-4 mr-1.5" />
                {completeMut.isPending ? "Locking…" : "Complete & lock"}
              </Button>
            )}
          </div>
        }
      />

      {/* Summary panel */}
      <Card className="mb-6">
        <CardContent className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Beginning balance" value={fmt(data.totals.beginningBalance)} />
            <Stat label="+ Cleared deposits" value={fmt(data.totals.clearedDeposits)} accent="text-emerald-600 dark:text-emerald-400" />
            <Stat label="− Cleared withdrawals" value={fmt(data.totals.clearedWithdrawals)} accent="text-rose-600 dark:text-rose-400" />
            <Stat label="Statement ending" value={fmt(data.totals.endingBalance)} />
            <Stat
              label="Difference"
              value={fmt(data.totals.difference)}
              accent={diffOk ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-rose-600 dark:text-rose-400 font-semibold"}
            />
          </div>
          <div className={"mt-4 px-3 py-2 rounded text-sm " + (diffOk ? "bg-primary/10 text-primary" : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
            {diffOk
              ? "Books balance with the statement. Ready to lock."
              : `Off by ${fmt(Math.abs(data.totals.difference))}. Continue clearing transactions or fix the statement balance.`}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ReconColumn
          title="Deposits (money in)"
          transactions={deposits}
          isLocked={isLocked}
          onToggle={(btId, cleared) => toggleMut.mutate({ btId, cleared })}
        />
        <ReconColumn
          title="Withdrawals (money out)"
          transactions={withdrawals}
          isLocked={isLocked}
          onToggle={(btId, cleared) => toggleMut.mutate({ btId, cleared })}
        />
      </div>
    </Layout>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={"text-base tabular-nums " + (accent ?? "")}>{value}</div>
    </div>
  );
}

function ReconColumn({
  title,
  transactions,
  isLocked,
  onToggle,
}: {
  title: string;
  transactions: Array<BankTransaction & { cleared: boolean }>;
  isLocked: boolean;
  onToggle: (btId: number, cleared: boolean) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground font-medium">
          {title} · {transactions.length}
        </div>
        <div className="divide-y divide-border">
          {transactions.length === 0 && (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">No transactions in period.</div>
          )}
          {transactions.map((t) => (
            <label
              key={t.id}
              className="flex items-center gap-3 px-4 py-3 hover-elevate cursor-pointer"
              data-testid={`row-recon-tx-${t.id}`}
            >
              <Checkbox
                checked={t.cleared}
                disabled={isLocked}
                onCheckedChange={(v) => onToggle(t.id, !!v)}
                data-testid={`checkbox-recon-tx-${t.id}`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{t.description}</div>
                <div className="text-xs text-muted-foreground">{t.date} · {t.status}</div>
              </div>
              <div className={"text-sm tabular-nums " + (t.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                {fmt(Math.abs(t.amount))}
              </div>
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
