// ============================================================================
// FIRM INVITE APPROVAL — /firm-invite?token=... (client owner approves)
// ============================================================================
// Reached from the emailed invitation link. The logged-in client owner picks
// which organization they own to grant the firm accountant access to. Nothing
// is granted until they approve here — the token alone confers no access.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { readCsrfToken } from "@/lib/queryClient";

type InviteInfo = { firmName: string; grantedRole: string; inviteEmail: string; myOrgs: Array<{ id: number; name: string; slug: string }> };

function tokenFromHash(): string {
  const qs = window.location.hash.split("?")[1] || "";
  return new URLSearchParams(qs).get("token") || "";
}

async function post(url: string, body: unknown) {
  const csrf = readCsrfToken();
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

export default function FirmInvite() {
  const token = tokenFromHash();
  const [approvedFirm, setApprovedFirm] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery<InviteInfo>({
    queryKey: [`/api/firm/invite/${token}`],
    enabled: !!token,
    retry: false,
  });

  const approveMut = useMutation({
    mutationFn: (orgId: number) => post(`/api/firm/invite/${token}/approve`, { orgId }),
    onSuccess: (r: any) => { setApprovedFirm(r.firmName || data?.firmName || "the firm"); queryClient.invalidateQueries(); },
  });
  const declineMut = useMutation({
    mutationFn: () => post(`/api/firm/invite/${token}/decline`, {}),
    onSuccess: () => setApprovedFirm("__declined__"),
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-lg border p-6 space-y-4">
        <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h1 className="text-lg font-semibold">Accountant access request</h1></div>

        {!token && <p className="text-sm text-red-600">This link is missing its invitation token.</p>}
        {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading invitation…</div>}
        {isError && <p className="text-sm text-red-600">{(error as any)?.message || "This invitation is no longer valid."}</p>}

        {approvedFirm === "__declined__" && <p className="text-sm">Invitation declined. No access was granted.</p>}
        {approvedFirm && approvedFirm !== "__declined__" && (
          <div className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="h-4 w-4" /> {approvedFirm} now has access. You can revoke it anytime from Settings → Your accountant.</div>
        )}

        {data && !approvedFirm && (
          <>
            <p className="text-sm text-muted-foreground">
              <strong>{data.firmName}</strong> is requesting <strong>{data.grantedRole}</strong> access to your books. Choose which organization to grant — you can revoke it at any time.
            </p>
            {data.myOrgs.length === 0 ? (
              <p className="text-sm text-amber-700">You must be an <strong>owner</strong> of an organization to approve this. Log in as the owner and reopen this link.</p>
            ) : (
              <div className="space-y-2">
                {data.myOrgs.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 rounded-md border p-2" data-testid={`approve-org-${o.id}`}>
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{o.name}</span>
                    <Button size="sm" className="ml-auto" disabled={approveMut.isPending} onClick={() => approveMut.mutate(o.id)} data-testid={`button-approve-${o.id}`}>
                      Grant access
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {approveMut.isError && <p className="text-sm text-red-600">{(approveMut.error as any)?.message}</p>}
            <div className="pt-1">
              <Button variant="ghost" size="sm" onClick={() => declineMut.mutate()} disabled={declineMut.isPending}>Decline</Button>
            </div>
          </>
        )}
        <a href="#/" className="inline-block text-sm underline">Back to LedgerLite</a>
      </div>
    </div>
  );
}
