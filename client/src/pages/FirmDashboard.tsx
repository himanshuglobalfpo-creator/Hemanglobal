// ============================================================================
// FIRM DASHBOARD — /firm (accountant's client list)
// ============================================================================
// One row per client the firm has active access to, each with status tiles
// (unreconciled bank lines, open period, overdue invoices, last close date) and
// a one-click "Open" that reuses POST /api/auth/switch-org and drops the
// accountant into that client's books. Below: invite a new client by email.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Building2, Users, AlertTriangle, CalendarCheck, Lock, Unlock, Mail, ArrowRight, Loader2, XCircle } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Tiles = { unreconciledBankLines: number; overdueInvoices: number; lastCloseDate: string | null; currentPeriodOpen: boolean };
type Client = { id: number; clientOrgId: number; clientName: string; clientSlug: string; grantedRole: string; approvedAt: string | null; tiles: Tiles };
type Pending = { id: number; inviteEmail: string; grantedRole: string; createdAt: string };
type FirmClients = { clients: Client[]; pending: Pending[] };

function Tile({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone?: "warn" | "ok" | "muted" }) {
  const color = tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-green-600" : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border p-2">
      <div className={`flex items-center gap-1 text-xs ${color}`}><Icon className="h-3.5 w-3.5" /> {label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

export default function FirmDashboard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");

  const { data, isLoading } = useQuery<FirmClients>({ queryKey: ["/api/firm/clients"] });

  const switchMut = useMutation({
    mutationFn: (orgId: number) => apiRequest("POST", "/api/auth/switch-org", { orgId }),
    onSuccess: async () => { await queryClient.invalidateQueries(); navigate("/"); },
    onError: (e: any) => toast({ title: "Could not open client", description: e.message, variant: "destructive" }),
  });

  const inviteMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/firm/clients/invite", { email }),
    onSuccess: async () => { setEmail(""); await queryClient.invalidateQueries({ queryKey: ["/api/firm/clients"] }); toast({ title: "Invitation sent", description: "The client owner will approve access via email." }); },
    onError: (e: any) => toast({ title: "Invite failed", description: e.message, variant: "destructive" }),
  });

  const revokeMut = useMutation({
    mutationFn: (grantId: number) => apiRequest("POST", `/api/firm/clients/${grantId}/revoke`, {}),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["/api/firm/clients"] }); toast({ title: "Access ended" }); },
    onError: (e: any) => toast({ title: "Revoke failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Layout>
      <PageHeader title="Firm dashboard" description="Your clients at a glance — jump into any client's books in one click." />
      <div className="space-y-6">
        <Card data-testid="card-firm-clients">
          <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Clients {data ? `(${data.clients.length})` : ""}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
            {data && data.clients.length === 0 && <p className="text-sm text-muted-foreground">No clients yet. Invite one below — the client owner approves access by email.</p>}
            {data?.clients.map((c) => (
              <div key={c.id} className="rounded-lg border p-3" data-testid={`client-row-${c.clientOrgId}`}>
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{c.clientName}</span>
                  <Badge variant="secondary">{c.grantedRole}</Badge>
                  <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" onClick={() => switchMut.mutate(c.clientOrgId)} disabled={switchMut.isPending} data-testid={`button-open-client-${c.clientOrgId}`}>
                      Open <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => revokeMut.mutate(c.id)} disabled={revokeMut.isPending} data-testid={`button-revoke-client-${c.clientOrgId}`}>
                      <XCircle className="mr-1 h-3.5 w-3.5" /> End access
                    </Button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Tile icon={AlertTriangle} label="Unreconciled lines" value={String(c.tiles.unreconciledBankLines)} tone={c.tiles.unreconciledBankLines > 0 ? "warn" : "ok"} />
                  <Tile icon={c.tiles.currentPeriodOpen ? Unlock : Lock} label="This period" value={c.tiles.currentPeriodOpen ? "Open" : "Closed"} tone={c.tiles.currentPeriodOpen ? "warn" : "ok"} />
                  <Tile icon={Mail} label="Overdue invoices" value={String(c.tiles.overdueInvoices)} tone={c.tiles.overdueInvoices > 0 ? "warn" : "ok"} />
                  <Tile icon={CalendarCheck} label="Last close" value={c.tiles.lastCloseDate ?? "Never"} tone={c.tiles.lastCloseDate ? "muted" : "warn"} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card data-testid="card-firm-invite">
          <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" /> Invite a client</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Enter the client owner's email. They'll approve accountant access from a link — you never see their books until they say yes.</p>
            <div className="flex items-end gap-2">
              <div className="flex-1 max-w-sm">
                <Label>Client owner email</Label>
                <Input type="email" placeholder="owner@client.com" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-firm-invite-email" />
              </div>
              <Button disabled={!email.trim() || inviteMut.isPending} onClick={() => inviteMut.mutate()} data-testid="button-firm-invite">
                {inviteMut.isPending ? "Sending…" : "Send invite"}
              </Button>
            </div>
            {data && data.pending.length > 0 && (
              <div className="space-y-1 pt-2">
                <div className="text-xs font-medium text-muted-foreground">Pending invitations</div>
                {data.pending.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 text-sm" data-testid={`pending-invite-${p.id}`}>
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {p.inviteEmail}
                    <Badge variant="outline">{p.grantedRole}</Badge>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => revokeMut.mutate(p.id)}>Cancel</Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
