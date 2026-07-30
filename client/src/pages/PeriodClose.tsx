import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock, LockOpen, Calendar, Sparkles } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, fmtMoney, todayISO } from "@/lib/format";

type PeriodLock = {
  id: number;
  lockDate: string;
  reason: string | null;
  isYearEnd: boolean;
  closingEntryId: number | null;
  createdAt: string;
};

export default function PeriodClose() {
  const { toast } = useToast();
  const [closeOpen, setCloseOpen] = useState(false);
  const [yeOpen, setYeOpen] = useState(false);
  const [closeForm, setCloseForm] = useState({ lockDate: todayISO(), reason: "" });
  const [yeForm, setYeForm] = useState({ fiscalYearEnd: `${new Date().getFullYear()}-12-31` });

  const { data: locks = [] } = useQuery<PeriodLock[]>({ queryKey: ["/api/period-locks"] });

  const closeMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/period-locks", {
        lockDate: closeForm.lockDate,
        reason: closeForm.reason || undefined,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/period-locks"] });
      setCloseOpen(false);
      setCloseForm({ lockDate: todayISO(), reason: "" });
      toast({ title: "Period closed", description: "All edits before the lock date are now blocked." });
    },
    onError: (e: any) =>
      toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const reopenMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/period-locks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/period-locks"] });
      toast({ title: "Period reopened" });
    },
  });

  const yeMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/period-locks/year-end-close", {
        fiscalYearEnd: yeForm.fiscalYearEnd,
      });
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/period-locks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      setYeOpen(false);
      toast({
        title: "Year-end close complete",
        description: `Net income ${fmtMoney(data.netIncome || 0)} closed to Retained Earnings.`,
      });
    },
    onError: (e: any) =>
      toast({ title: "Year-end failed", description: e.message, variant: "destructive" }),
  });

  const sortedLocks = [...locks].sort((a, b) => (b.lockDate || "").localeCompare(a.lockDate || ""));
  const currentLock = sortedLocks[0];

  return (
    <Layout>
      <PageHeader
        title="Period Close"
        description="Lock past months to prevent edits and run year-end close"
        actions={
          <div className="flex items-center gap-2">
            <Dialog open={yeOpen} onOpenChange={setYeOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" data-testid="button-year-end">
                  <Sparkles className="h-4 w-4 mr-1.5" />
                  Year-end close
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Run year-end close</DialogTitle>
                  <DialogDescription>
                    Posts a journal entry zeroing all income and expense accounts and transferring
                    net income to Retained Earnings (3100). The period through the fiscal year-end
                    will be locked.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="ye-date">Fiscal year-end date</Label>
                    <Input
                      id="ye-date"
                      type="date"
                      value={yeForm.fiscalYearEnd}
                      onChange={(e) => setYeForm({ fiscalYearEnd: e.target.value })}
                      data-testid="input-fiscal-year-end"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => yeMut.mutate()}
                    disabled={yeMut.isPending}
                    data-testid="button-run-year-end"
                  >
                    {yeMut.isPending ? "Running…" : "Run year-end close"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-close-period">
                  <Lock className="h-4 w-4 mr-1.5" />
                  Close period
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Close period</DialogTitle>
                  <DialogDescription>
                    Block all edits to transactions on or before this date.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="end-date">Through date</Label>
                    <Input
                      id="end-date"
                      type="date"
                      value={closeForm.lockDate}
                      onChange={(e) =>
                        setCloseForm({ ...closeForm, lockDate: e.target.value })
                      }
                      data-testid="input-close-end-date"
                    />
                  </div>
                  <div>
                    <Label htmlFor="notes">Reason (optional)</Label>
                    <Textarea
                      id="notes"
                      placeholder="e.g. March 2026 close"
                      value={closeForm.reason}
                      onChange={(e) =>
                        setCloseForm({ ...closeForm, reason: e.target.value })
                      }
                      data-testid="textarea-close-reason"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => closeMut.mutate()}
                    disabled={closeMut.isPending}
                    data-testid="button-confirm-close"
                  >
                    Close period
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      {currentLock && (
        <Card className="mb-6 border-primary/20 bg-primary/5">
          <CardContent className="p-4 flex items-center gap-3">
            <Lock className="h-5 w-5 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                Current lock: through {fmtDate(currentLock.lockDate)}
                {currentLock.isYearEnd && (
                  <Badge className="ml-2" variant="secondary">Year-end</Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                All transactions dated on or before this date are read-only.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lock history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Through</TableHead>
                <TableHead>Closed at</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedLocks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                    <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No periods closed yet.
                  </TableCell>
                </TableRow>
              )}
              {sortedLocks.map((l, i) => (
                <TableRow key={l.id} data-testid={`row-lock-${l.id}`}>
                  <TableCell className="font-medium">
                    {fmtDate(l.lockDate)}
                    {i === 0 && (
                      <Badge className="ml-2" variant="default">
                        Current
                      </Badge>
                    )}
                    {l.isYearEnd && (
                      <Badge className="ml-2" variant="secondary">Year-end</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {l.createdAt?.replace("T", " ").slice(0, 16) || "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {l.reason || "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Reopen period through ${fmtDate(l.lockDate)}?`))
                          reopenMut.mutate(l.id);
                      }}
                      data-testid={`button-reopen-${l.id}`}
                    >
                      <LockOpen className="h-4 w-4 mr-1.5" />
                      Reopen
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <FxRevaluationCard />
    </Layout>
  );
}

// Period-end FX revaluation: restate open foreign-currency balances at the
// as-of rate and post the unrealized gain/loss. Over POST /api/fx/revalue.
function FxRevaluationCard() {
  const { toast } = useToast();
  const [asOfDate, setAsOfDate] = useState(todayISO());
  const { data: revsRaw } = useQuery<any>({ queryKey: ["/api/fx/revaluations"], queryFn: async () => (await apiRequest("GET", "/api/fx/revaluations?limit=20")).json() });
  const revaluations: any[] = Array.isArray(revsRaw) ? revsRaw : revsRaw?.rows ?? [];

  const revalueMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/fx/revalue", { asOfDate })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fx/revaluations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      toast({ title: "FX revaluation posted", description: `Open foreign balances restated as of ${asOfDate}.` });
    },
    onError: (e: any) => toast({ title: "Revaluation failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="mt-6" data-testid="card-fx-revaluation">
      <CardHeader><CardTitle className="text-base">FX revaluation</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">Restate open foreign-currency balances at the period-end rate and post the unrealized gain/loss. Requires FX rates for the as-of date (Settings → FX rates).</p>
        <div className="flex items-end gap-3">
          <div><Label htmlFor="fx-asof">As-of date</Label><Input id="fx-asof" type="date" className="w-44" data-testid="input-fx-asof" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></div>
          <Button onClick={() => revalueMut.mutate()} disabled={revalueMut.isPending} data-testid="button-fx-revalue">{revalueMut.isPending ? "Posting…" : "Run revaluation"}</Button>
        </div>
        {revaluations.length > 0 && (
          <div className="rounded-md border border-border" data-testid="list-fx-revaluations">
            <div className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground border-b border-border">Recent revaluations</div>
            {revaluations.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-1.5 text-sm border-b border-border last:border-0" data-testid={`row-fx-revaluation-${r.id}`}>
                <span>{fmtDate(r.asOfDate ?? r.date)}</span>
                <span className="tabular-nums text-muted-foreground">{fmtMoney(r.gainLossCents ?? r.adjustmentCents ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
