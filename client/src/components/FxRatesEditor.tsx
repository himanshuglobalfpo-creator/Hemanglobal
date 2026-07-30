// ============================================================================
// FX RATES EDITOR (Settings) — manual exchange rates
// ============================================================================
// Over GET/PUT /api/settings/fx-rates. Rates are keyed by (date, fromCode,
// toCode); PUT upserts one. Used by multi-currency documents and period-end FX
// revaluation.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, todayISO } from "@/lib/format";

type FxRate = { date: string; fromCode: string; toCode: string; rate: number; source: string | null };

export function FxRatesEditor() {
  const { toast } = useToast();
  const { data: rates = [] } = useQuery<FxRate[]>({ queryKey: ["/api/settings/fx-rates"] });
  const { data: status } = useQuery<{ provider: string; lastFetchDate: string | null; systemRateCount: number }>({ queryKey: ["/api/settings/fx-rates/status"] });
  const [form, setForm] = useState({ date: todayISO(), fromCode: "EUR", toCode: "USD", rate: "" });

  const refreshMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/settings/fx-rates/refresh", {})).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/fx-rates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/fx-rates/status"] });
      toast({ title: r.ok ? "Rates refreshed" : "Refresh failed", description: r.ok ? `${r.updated} updated, ${r.skipped} kept manual/skipped` : r.error, variant: r.ok ? undefined : "destructive" });
    },
    onError: (e: any) => toast({ title: "Refresh failed", description: e.message, variant: "destructive" }),
  });

  const saveMut = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/settings/fx-rates", {
      date: form.date, fromCode: form.fromCode.toUpperCase(), toCode: form.toCode.toUpperCase(), rate: parseFloat(form.rate), source: "manual",
    })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/settings/fx-rates"] }); setForm((f) => ({ ...f, rate: "" })); toast({ title: "FX rate saved" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const valid = /^[A-Za-z]{3}$/.test(form.fromCode) && /^[A-Za-z]{3}$/.test(form.toCode) && parseFloat(form.rate) > 0;

  return (
    <Card data-testid="card-fx-rates">
      <CardHeader><CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5" /> FX rates</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="fx-auto-status">
          <span className="text-muted-foreground">Auto source:</span>
          <span className="font-medium">{status?.provider ?? "—"}</span>
          <span className="text-muted-foreground">· last fetch: {status?.lastFetchDate ?? "never"}</span>
          <button className="ml-auto rounded border px-2 py-1 text-xs hover-elevate disabled:opacity-60" disabled={refreshMut.isPending || status?.provider === "disabled"} onClick={() => refreshMut.mutate()} data-testid="button-fx-refresh">
            {refreshMut.isPending ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Automatic rates are fetched daily for currencies used in your documents. Manual rates below always win — an auto refresh never overwrites a rate you set for the same date.</p>
        <div className="flex items-end gap-2 flex-wrap">
          <div><Label>Date</Label><Input type="date" className="w-40" data-testid="input-fx-date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
          <div><Label>From</Label><Input className="w-20 uppercase" maxLength={3} data-testid="input-fx-from" value={form.fromCode} onChange={(e) => setForm({ ...form, fromCode: e.target.value })} /></div>
          <div><Label>To</Label><Input className="w-20 uppercase" maxLength={3} data-testid="input-fx-to" value={form.toCode} onChange={(e) => setForm({ ...form, toCode: e.target.value })} /></div>
          <div><Label>Rate</Label><Input type="number" step="0.0001" className="w-32" data-testid="input-fx-rate" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></div>
          <Button disabled={!valid || saveMut.isPending} onClick={() => saveMut.mutate()} data-testid="button-save-fx-rate"><Plus className="h-4 w-4 mr-1.5" />{saveMut.isPending ? "Saving…" : "Save rate"}</Button>
        </div>
        <p className="text-xs text-muted-foreground">Rate = base units of “To” per 1 unit of “From”. Used by multi-currency documents and FX revaluation.</p>
        <div className="rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="text-left px-3 py-2 font-medium">Date</th><th className="text-left px-3 py-2 font-medium">Pair</th><th className="text-right px-3 py-2 font-medium">Rate</th><th className="text-left px-3 py-2 font-medium">Source</th></tr></thead>
            <tbody>
              {rates.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No FX rates yet.</td></tr>}
              {rates.map((r, i) => (
                <tr key={`${r.date}-${r.fromCode}-${r.toCode}-${i}`} className="border-t border-border" data-testid={`row-fx-rate-${r.fromCode}-${r.toCode}-${r.date}`}>
                  <td className="px-3 py-1.5 text-muted-foreground">{fmtDate(r.date)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.fromCode}→{r.toCode}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.rate}</td>
                  <td className="px-3 py-1.5 text-muted-foreground text-xs">{r.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
