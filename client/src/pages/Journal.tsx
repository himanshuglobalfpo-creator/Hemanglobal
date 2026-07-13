import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, ArrowRightLeft } from "lucide-react";
import type { Account, JournalEntry, JournalLine } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, todayISO } from "@/lib/format";

interface Line { accountId: number | null; debit: number; credit: number; description: string; projectId?: number | null; }

type EntryWithLines = JournalEntry & { lines: (JournalLine & { account?: Account })[] };

export default function Journal() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<number>>(new Set());
  const [reclassOpen, setReclassOpen] = useState(false);
  const [reclassToAccount, setReclassToAccount] = useState<string>("");
  const [reclassMemo, setReclassMemo] = useState<string>("");

  const { data: entries = [] } = useQuery<EntryWithLines[]>({ queryKey: ["/api/journal"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: projects = [] } = useQuery<{ id: number; name: string; isActive: boolean }[]>({ queryKey: ["/api/projects"] });
  const showProject = projects.length > 0;

  function toggleLine(id: number) {
    const next = new Set(selectedLineIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedLineIds(next);
  }
  function clearSelection() {
    setSelectedLineIds(new Set());
  }

  const reclassifyMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/reclassify", {
        lineIds: Array.from(selectedLineIds),
        toAccountId: Number(reclassToAccount),
        memo: reclassMemo || undefined,
      });
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries();
      toast({
        title: "Reclassified",
        description: `${data.linesUpdated} line(s) moved.`,
      });
      setReclassOpen(false);
      setReclassToAccount("");
      setReclassMemo("");
      clearSelection();
    },
    onError: (e: any) => toast({ title: "Reclassify failed", description: e.message, variant: "destructive" }),
  });

  const [form, setForm] = useState({
    date: todayISO(),
    memo: "",
    reference: "",
    lines: [
      { accountId: null, debit: 0, credit: 0, description: "" },
      { accountId: null, debit: 0, credit: 0, description: "" },
    ] as Line[],
  });

  // Typed amounts are dollars — convert to integer cents exactly like the API
  // route does (Math.round(x * 100)), so the preview matches the server and
  // the balance check is EXACT integer equality, no epsilon.
  const totalDebit = form.lines.reduce((s, l) => s + Math.round((Number(l.debit) || 0) * 100), 0);
  const totalCredit = form.lines.reduce((s, l) => s + Math.round((Number(l.credit) || 0) * 100), 0);
  const balanced = totalDebit === totalCredit && totalDebit > 0;

  const createMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/journal", {
        date: form.date,
        memo: form.memo || undefined,
        reference: form.reference || undefined,
        source: "manual",
        lines: form.lines.map((l) => ({ accountId: l.accountId, debit: l.debit || 0, credit: l.credit || 0, description: l.description || undefined, projectId: l.projectId ?? undefined })),
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      setOpen(false);
      setForm({
        date: todayISO(), memo: "", reference: "",
        lines: [{ accountId: null, debit: 0, credit: 0, description: "" }, { accountId: null, debit: 0, credit: 0, description: "" }],
      });
      toast({ title: "Entry posted" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Layout>
      <PageHeader
        title="General Journal"
        description="Every accounting transaction posted to your books. Select lines to reclassify in bulk."
        actions={<Button onClick={() => setOpen(true)} data-testid="button-new-journal"><Plus className="h-4 w-4 mr-1.5" />Manual entry</Button>}
      />

      {selectedLineIds.size > 0 && (
        <div className="sticky top-2 z-20 mb-4 flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm shadow-sm">
          <span className="font-medium">
            {selectedLineIds.size} line{selectedLineIds.size === 1 ? "" : "s"} selected
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection} data-testid="button-clear-selection">
              Clear
            </Button>
            <Button size="sm" onClick={() => setReclassOpen(true)} data-testid="button-reclassify">
              <ArrowRightLeft className="h-4 w-4 mr-1.5" />
              Reclassify to…
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {entries.length === 0 && (
          <Card><CardContent className="p-12 text-center text-muted-foreground">No entries yet.</CardContent></Card>
        )}
        {entries.map((e) => {
          const debit = e.lines.reduce((s, l) => s + l.debit, 0);
          return (
            <Card key={e.id} data-testid={`row-journal-${e.id}`}>
              <CardContent className="p-0">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-sm">{fmtDate(e.date)}</span>
                    {e.reference && <Badge variant="outline" className="font-mono text-xs">{e.reference}</Badge>}
                    <Badge variant="secondary" className="text-xs capitalize">{e.source}</Badge>
                    {e.memo && <span className="text-sm text-muted-foreground">{e.memo}</span>}
                  </div>
                  <span className="text-sm tabular-nums font-medium">{fmtMoney(debit)}</span>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {e.lines.map((l) => {
                      const checked = selectedLineIds.has(l.id);
                      return (
                        <tr
                          key={l.id}
                          className={"border-b border-border last:border-0 " + (checked ? "bg-primary/5" : "")}
                        >
                          <td className="px-3 py-2 w-10">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleLine(l.id)}
                              data-testid={`checkbox-line-${l.id}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground w-20">{l.account?.code}</td>
                          <td className="px-3 py-2">{l.account?.name}</td>
                          <td className="px-3 py-2 text-muted-foreground text-xs">{l.description}</td>
                          <td className="px-3 py-2 text-right tabular-nums w-28">{l.debit > 0 ? fmtMoney(l.debit) : ""}</td>
                          <td className="px-3 py-2 text-right tabular-nums w-28">{l.credit > 0 ? fmtMoney(l.credit) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={reclassOpen} onOpenChange={setReclassOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reclassify {selectedLineIds.size} line{selectedLineIds.size === 1 ? "" : "s"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Move the selected line(s) to a different account. An audit entry will be added to the journal.
            </p>
            <div>
              <Label>Move to account</Label>
              <Select value={reclassToAccount} onValueChange={setReclassToAccount}>
                <SelectTrigger data-testid="select-reclass-account">
                  <SelectValue placeholder="Choose target account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Memo (optional)</Label>
              <Textarea
                value={reclassMemo}
                onChange={(e) => setReclassMemo(e.target.value)}
                placeholder="Reason for reclassification"
                data-testid="input-reclass-memo"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReclassOpen(false)}>Cancel</Button>
            <Button
              disabled={!reclassToAccount || reclassifyMut.isPending}
              onClick={() => reclassifyMut.mutate()}
              data-testid="button-confirm-reclassify"
            >
              {reclassifyMut.isPending ? "Reclassifying…" : "Reclassify"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Manual journal entry</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Date</Label>
                <Input type="date" data-testid="input-journal-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Memo</Label>
                <Input placeholder="Description of this entry" data-testid="input-journal-memo" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
              </div>
            </div>

            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Account</th>
                    <th className="text-left px-3 py-2 font-medium">Description</th>
                    {showProject && <th className="text-left px-3 py-2 font-medium w-32">Project</th>}
                    <th className="text-right px-3 py-2 font-medium w-28">Debit</th>
                    <th className="text-right px-3 py-2 font-medium w-28">Credit</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((l, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-2 py-1">
                        <Select value={l.accountId?.toString() ?? ""} onValueChange={(v) => { const lines = [...form.lines]; lines[idx].accountId = Number(v); setForm({ ...form, lines }); }}>
                          <SelectTrigger data-testid={`select-journal-account-${idx}`}><SelectValue placeholder="Select…" /></SelectTrigger>
                          <SelectContent>
                            {accounts.map((a) => <SelectItem key={a.id} value={a.id.toString()}>{a.code} {a.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-2 py-1">
                        <Input data-testid={`input-journal-line-desc-${idx}`} value={l.description} onChange={(e) => { const lines = [...form.lines]; lines[idx].description = e.target.value; setForm({ ...form, lines }); }} />
                      </td>
                      {showProject && (
                        <td className="px-2 py-1">
                          <select
                            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                            data-testid={`select-journal-line-project-${idx}`}
                            value={l.projectId?.toString() ?? ""}
                            onChange={(e) => { const lines = [...form.lines]; lines[idx].projectId = e.target.value ? Number(e.target.value) : null; setForm({ ...form, lines }); }}
                          >
                            <option value="">—</option>
                            {projects.filter((p) => p.isActive || p.id === l.projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                      )}
                      <td className="px-2 py-1">
                        <Input type="number" step="0.01" className="text-right" data-testid={`input-journal-debit-${idx}`} value={l.debit || ""} onChange={(e) => { const lines = [...form.lines]; lines[idx].debit = Number(e.target.value); if (lines[idx].debit > 0) lines[idx].credit = 0; setForm({ ...form, lines }); }} />
                      </td>
                      <td className="px-2 py-1">
                        <Input type="number" step="0.01" className="text-right" data-testid={`input-journal-credit-${idx}`} value={l.credit || ""} onChange={(e) => { const lines = [...form.lines]; lines[idx].credit = Number(e.target.value); if (lines[idx].credit > 0) lines[idx].debit = 0; setForm({ ...form, lines }); }} />
                      </td>
                      <td className="px-2 py-1">
                        {form.lines.length > 2 && (
                          <Button variant="ghost" size="icon" onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== idx) })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-muted/30 font-medium">
                    <td colSpan={showProject ? 3 : 2} className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">Totals</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalDebit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totalCredit)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setForm({ ...form, lines: [...form.lines, { accountId: null, debit: 0, credit: 0, description: "" }] })}
                data-testid="button-journal-add-line"
              ><Plus className="h-4 w-4 mr-1" />Add line</Button>
              <span className={`text-xs ${balanced ? "text-primary" : "text-destructive"}`}>
                {balanced ? "✓ Balanced" : `Out of balance by ${fmtMoney(Math.abs(totalDebit - totalCredit))}`}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!balanced || form.lines.some((l) => !l.accountId) || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-post-journal">
              {createMut.isPending ? "Posting…" : "Post entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
