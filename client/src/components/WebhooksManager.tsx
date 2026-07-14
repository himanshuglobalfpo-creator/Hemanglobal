// ============================================================================
// WEBHOOKS (Settings) — CRUD + test-fire + deliveries log
// ============================================================================
// Over /api/webhooks. Subscribe an endpoint to business events; secrets are
// write-only (never returned). Test-fire enqueues a synthetic "ping" delivery;
// the deliveries dialog shows recent attempts. Note: the server's SSRF guard
// rejects private/loopback URLs at create time.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Zap, ScrollText } from "lucide-react";
import { WEBHOOK_EVENT_NAMES } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDate } from "@/lib/format";

type Webhook = { id: number; url: string; events: string[]; isActive: boolean; createdAt: string };

export function WebhooksManager() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deliveriesFor, setDeliveriesFor] = useState<number | null>(null);
  const { data: webhooks = [] } = useQuery<Webhook[]>({ queryKey: ["/api/webhooks"] });

  const [form, setForm] = useState<{ url: string; secret: string; events: string[] }>({ url: "", secret: "", events: ["invoice.paid"] });

  const createMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/webhooks", { url: form.url.trim(), secret: form.secret, events: form.events, isActive: true })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/webhooks"] }); setOpen(false); toast({ title: "Webhook created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const toggleMut = useMutation({
    mutationFn: async (w: Webhook) => (await apiRequest("PATCH", `/api/webhooks/${w.id}`, { isActive: !w.isActive })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/webhooks"] }),
  });
  const delMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/webhooks/${id}`)).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/webhooks"] }); toast({ title: "Webhook deleted" }); },
  });
  const testMut = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/webhooks/${id}/test`, {})).json(),
    onSuccess: (data: any) => toast({ title: "Test queued", description: data.message }),
    onError: (e: any) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });

  const toggleEvent = (ev: string) => setForm((f) => ({ ...f, events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev] }));

  return (
    <Card data-testid="card-webhooks">
      <CardHeader><CardTitle className="flex items-center justify-between"><span className="flex items-center gap-2"><Zap className="h-5 w-5" /> Webhooks</span>
        <Button size="sm" onClick={() => { setForm({ url: "", secret: "", events: ["invoice.paid"] }); setOpen(true); }} data-testid="button-new-webhook"><Plus className="h-4 w-4 mr-1.5" />New webhook</Button>
      </CardTitle></CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">URL</th><th className="px-4 py-3 font-medium">Events</th>
              <th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium w-52"></th>
            </tr>
          </thead>
          <tbody>
            {webhooks.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No webhooks yet.</td></tr>}
            {webhooks.map((w) => (
              <tr key={w.id} className="border-b border-border last:border-0" data-testid={`row-webhook-${w.id}`}>
                <td className="px-4 py-3 font-mono text-xs truncate max-w-xs">{w.url}</td>
                <td className="px-4 py-3"><span className="flex flex-wrap gap-1">{w.events.map((e) => <Badge key={e} variant="outline" className="text-[10px]">{e}</Badge>)}</span></td>
                <td className="px-4 py-3"><Badge variant={w.isActive ? "default" : "secondary"}>{w.isActive ? "active" : "paused"}</Badge></td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => testMut.mutate(w.id)} disabled={!w.isActive || testMut.isPending} data-testid={`button-test-webhook-${w.id}`}><Zap className="h-3.5 w-3.5 mr-1" />Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeliveriesFor(w.id)} data-testid={`button-deliveries-webhook-${w.id}`}><ScrollText className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleMut.mutate(w)} data-testid={`button-toggle-webhook-${w.id}`}>{w.isActive ? "Pause" : "Resume"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => delMut.mutate(w.id)} data-testid={`button-delete-webhook-${w.id}`}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New webhook</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Endpoint URL</Label><Input data-testid="input-webhook-url" placeholder="https://example.com/hooks/ledgerlite" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></div>
            <div><Label>Signing secret <span className="text-muted-foreground font-normal">(≥16 chars, stored write-only)</span></Label><Input data-testid="input-webhook-secret" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} /></div>
            <div>
              <Label>Events</Label>
              <div className="grid grid-cols-2 gap-1.5 mt-1">
                {WEBHOOK_EVENT_NAMES.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={form.events.includes(ev)} onChange={() => toggleEvent(ev)} data-testid={`checkbox-event-${ev}`} />
                    <span className="font-mono text-xs">{ev}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.url.trim() || form.secret.length < 16 || form.events.length === 0 || createMut.isPending} onClick={() => createMut.mutate()} data-testid="button-save-webhook">
              {createMut.isPending ? "Saving…" : "Create webhook"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {deliveriesFor !== null && <DeliveriesDialog webhookId={deliveriesFor} onClose={() => setDeliveriesFor(null)} />}
    </Card>
  );
}

function DeliveriesDialog({ webhookId, onClose }: { webhookId: number; onClose: () => void }) {
  const { data: deliveries = [] } = useQuery<any[]>({
    queryKey: ["/api/webhooks", webhookId, "deliveries"],
    queryFn: async () => (await apiRequest("GET", `/api/webhooks/${webhookId}/deliveries`)).json(),
    refetchInterval: 3000,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Recent deliveries</DialogTitle></DialogHeader>
        <div className="rounded-md border border-border max-h-80 overflow-y-auto" data-testid="panel-deliveries">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground sticky top-0">
              <tr><th className="text-left px-3 py-2 font-medium">Event</th><th className="text-left px-3 py-2 font-medium">Status</th><th className="text-right px-3 py-2 font-medium">Attempts</th><th className="text-right px-3 py-2 font-medium">Code</th><th className="text-right px-3 py-2 font-medium">When</th></tr>
            </thead>
            <tbody>
              {deliveries.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No deliveries yet.</td></tr>}
              {deliveries.map((d) => (
                <tr key={d.id} className="border-t border-border" data-testid={`row-delivery-${d.id}`}>
                  <td className="px-3 py-1.5 font-mono text-xs">{d.event}</td>
                  <td className="px-3 py-1.5"><Badge variant={d.status === "delivered" ? "default" : d.status === "failed" ? "destructive" : "secondary"}>{d.status}</Badge></td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.attempts}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.responseCode ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground text-xs">{fmtDate(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
