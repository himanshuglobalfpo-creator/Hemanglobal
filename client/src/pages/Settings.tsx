// ============================================================================
// ORGANIZATION SETTINGS
// ============================================================================
// Online payments (Stripe): payments that customers make online settle into a
// SPECIFIC bank account chosen here — the "clearing account". Until one is
// selected, online payments are disabled and the Stripe webhook refuses to
// record payments rather than guessing an account. The readiness panel mirrors
// the server-side gate in server/stripe.ts (`onlinePaymentsReady`).
// Ship-from address: used for sales-tax calculation (TaxJar from_* params).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, CreditCard, MapPin, Tags, Boxes } from "lucide-react";
import type { Account } from "@shared/schema";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Me } from "@/App";
import { DataImporters } from "@/components/DataImporters";
import { WebhooksManager } from "@/components/WebhooksManager";
import { FxRatesEditor } from "@/components/FxRatesEditor";

type StripeStatus = {
  configured: boolean;
  webhookConfigured: boolean;
  error: string | null;
  clearingAccountConfigured?: boolean;
  clearingAccount?: { id: number; code: string; name: string } | null;
  clearingAccountError?: string | null;
  onlinePaymentsReady?: boolean;
};

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600 shrink-0" data-testid="icon-status-ok" />
      ) : (
        <XCircle className="h-4 w-4 mt-0.5 text-red-600 shrink-0" data-testid="icon-status-missing" />
      )}
      <div>
        <span>{label}</span>
        {!ok && detail ? <p className="text-muted-foreground text-xs mt-0.5">{detail}</p> : null}
      </div>
    </div>
  );
}

// Manage a single dimension type (classes / locations / projects): list, add,
// and activate/deactivate. Inactive entries stay on historical transactions but
// are hidden from new-entry pickers.
function DimensionManager({ kind, title, singular, canEdit }: { kind: "classes" | "locations" | "projects"; title: string; singular: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { data: items = [] } = useQuery<Array<{ id: number; name: string; isActive: boolean }>>({ queryKey: [`/api/${kind}`] });
  const [name, setName] = useState("");
  const createMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/${kind}`, { name: name.trim() })).json(),
    onSuccess: () => { setName(""); queryClient.invalidateQueries({ queryKey: [`/api/${kind}`] }); },
    onError: (e: any) => toast({ title: "Error", description: String(e?.message || e), variant: "destructive" }),
  });
  const toggleMut = useMutation({
    mutationFn: async (it: { id: number; isActive: boolean }) => { await apiRequest("PATCH", `/api/${kind}/${it.id}`, { isActive: !it.isActive }); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/${kind}`] }),
  });
  return (
    <Card data-testid={`card-${kind}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Tags className="h-5 w-5" /> {title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between py-1.5 text-sm" data-testid={`row-${kind}-${it.id}`}>
              <span className={it.isActive ? "" : "text-muted-foreground line-through"}>{it.name}</span>
              {canEdit && (
                <button className="text-xs underline text-muted-foreground hover:text-foreground" onClick={() => toggleMut.mutate(it)} data-testid={`toggle-${kind}-${it.id}`}>
                  {it.isActive ? "Deactivate" : "Activate"}
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="py-1.5 text-sm text-muted-foreground">None yet.</li>}
        </ul>
        {canEdit && (
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${singular}`} data-testid={`input-new-${kind}`}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) createMut.mutate(); }} />
            <Button onClick={() => createMut.mutate()} disabled={!name.trim() || createMut.isPending} data-testid={`button-add-${kind}`}>Add</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Inventory costing method + negative-stock policy. Costing method can only be
// changed before any inventory has moved — the server enforces this and surfaces
// the error here.
function InventorySettings({ org, canEdit }: {
  org: { id: number; costingMethod?: "average" | "fifo" | "lifo"; allowNegativeStock?: boolean } | null;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [method, setMethod] = useState<"average" | "fifo" | "lifo">(org?.costingMethod ?? "average");
  const [allowNeg, setAllowNeg] = useState<boolean>(!!org?.allowNegativeStock);
  useEffect(() => {
    setMethod(org?.costingMethod ?? "average");
    setAllowNeg(!!org?.allowNegativeStock);
  }, [org?.costingMethod, org?.allowNegativeStock]);

  const saveMut = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/orgs/${org!.id}`, { costingMethod: method, allowNegativeStock: allowNeg })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }); toast({ title: "Saved", description: "Inventory settings updated." }); },
    onError: (e: any) => toast({ title: "Error", description: String(e?.message || e), variant: "destructive" }),
  });

  return (
    <Card data-testid="card-inventory-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> Inventory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="costing-method">Costing method</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as any)} disabled={!canEdit}>
            <SelectTrigger id="costing-method" data-testid="select-costing-method"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="average">Weighted average</SelectItem>
              <SelectItem value="fifo">FIFO (first-in, first-out)</SelectItem>
              <SelectItem value="lifo">LIFO (last-in, first-out)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Can only be changed before any inventory purchase or sale is recorded.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowNeg} disabled={!canEdit} onChange={(e) => setAllowNeg(e.target.checked)} data-testid="checkbox-allow-negative-stock" className="h-4 w-4" />
          Allow selling below zero on-hand (negative stock)
        </label>
        {canEdit && (
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-inventory">
            {saveMut.isPending ? "Saving…" : "Save inventory settings"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Dimension tracking switches (QBO-style). Turning one ON reveals its picker
// across documents, banking, and manual entry. Off by default. Owners/admins
// only. Deactivating a dimension elsewhere hides it from pickers; this toggle
// governs whether the dimension is offered at all.
function DimensionTrackingSettings({ org, canEdit }: {
  org: {
    id: number;
    enableClassTracking?: boolean;
    enableLocationTracking?: boolean;
    enableProjectTracking?: boolean;
  } | null;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [cls, setCls] = useState<boolean>(!!org?.enableClassTracking);
  const [loc, setLoc] = useState<boolean>(!!org?.enableLocationTracking);
  const [proj, setProj] = useState<boolean>(!!org?.enableProjectTracking);
  useEffect(() => {
    setCls(!!org?.enableClassTracking);
    setLoc(!!org?.enableLocationTracking);
    setProj(!!org?.enableProjectTracking);
  }, [org?.enableClassTracking, org?.enableLocationTracking, org?.enableProjectTracking]);

  const saveMut = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/orgs/${org!.id}`, {
      enableClassTracking: cls, enableLocationTracking: loc, enableProjectTracking: proj,
    })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }); toast({ title: "Saved", description: "Dimension tracking updated." }); },
    onError: (e: any) => toast({ title: "Error", description: String(e?.message || e), variant: "destructive" }),
  });

  const Toggle = ({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId: string }) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={!canEdit} onChange={(e) => onChange(e.target.checked)} data-testid={testId} className="h-4 w-4" />
      {label}
    </label>
  );

  return (
    <Card data-testid="card-dimension-tracking">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Tags className="h-5 w-5" /> Dimension tracking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Turn on the dimensions you want to track. When enabled, the picker appears on invoices,
          bills, journal entries, and banking so you can tag transactions.
        </p>
        <Toggle checked={cls} onChange={setCls} label="Track Classes" testId="checkbox-enable-class" />
        <Toggle checked={loc} onChange={setLoc} label="Track Locations" testId="checkbox-enable-location" />
        <Toggle checked={proj} onChange={setProj} label="Track Projects (jobs)" testId="checkbox-enable-project" />
        {canEdit && (
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-dimension-tracking">
            {saveMut.isPending ? "Saving…" : "Save dimension tracking"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();

  const { data: me } = useQuery<Me & { org: (Me["org"] & {
    addressCity?: string | null;
    addressState?: string | null;
    addressZip?: string | null;
    stripeClearingAccountId?: number | null;
    costingMethod?: "average" | "fifo" | "lifo";
    allowNegativeStock?: boolean;
  }) | null }>({ queryKey: ["/api/auth/me"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: stripe } = useQuery<StripeStatus>({ queryKey: ["/api/stripe/status"] });
  const { data: emailStatus } = useQuery<{ configured: boolean; warning: string | null; from: string; suppressedCount: number }>({ queryKey: ["/api/email/status"] });

  const org = me?.org ?? null;
  const canEdit = me?.role === "owner" || me?.role === "admin";
  const bankAccounts = accounts.filter((a) => a.type === "asset" && a.subtype === "bank");

  // "" = no selection yet; "none" = explicitly clear the setting.
  const [clearingId, setClearingId] = useState<string>("");
  const [address, setAddress] = useState({ city: "", state: "", zip: "" });

  useEffect(() => {
    if (!org) return;
    setClearingId(org.stripeClearingAccountId ? String(org.stripeClearingAccountId) : "none");
    setAddress({
      city: org.addressCity ?? "",
      state: org.addressState ?? "",
      zip: org.addressZip ?? "",
    });
  }, [org?.id, org?.stripeClearingAccountId, org?.addressCity, org?.addressState, org?.addressZip]);

  const saveClearingMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/orgs/${org!.id}`, {
        stripeClearingAccountId: clearingId === "none" ? null : parseInt(clearingId),
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stripe/status"] });
      toast({
        title: clearingId === "none" ? "Clearing account cleared" : "Clearing account saved",
        description:
          clearingId === "none"
            ? "Online payments are disabled until an account is selected."
            : "Online payments will settle into the selected account.",
      });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const saveAddressMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/orgs/${org!.id}`, {
        addressCity: address.city || null,
        addressState: address.state || null,
        addressZip: address.zip || null,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Address saved" });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const envReady = !!stripe?.configured && !!stripe?.webhookConfigured;
  const ready = !!stripe?.onlinePaymentsReady;

  return (
    <Layout>
      <PageHeader title="Settings" description="Organization settings" />
      <div className="grid gap-6 max-w-2xl">
        {emailStatus && !emailStatus.configured && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="banner-email-unconfigured">
            <strong>Email is not configured.</strong> {emailStatus.warning || "Outgoing email (invoices, reminders) is logged but not delivered."} Set the <code>SMTP_*</code> environment variables to enable delivery.
          </div>
        )}
        <Card data-testid="card-online-payments">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" /> Online payments (Stripe)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <StatusRow
                ok={!!stripe?.configured}
                label="Stripe API key"
                detail="Set STRIPE_SECRET_KEY on the server."
              />
              <StatusRow
                ok={!!stripe?.webhookConfigured}
                label="Stripe webhook"
                detail="Set STRIPE_WEBHOOK_SECRET on the server."
              />
              <StatusRow
                ok={!!stripe?.clearingAccountConfigured}
                label={
                  stripe?.clearingAccount
                    ? `Clearing account — ${stripe.clearingAccount.code} ${stripe.clearingAccount.name}`
                    : "Clearing account"
                }
                detail={stripe?.clearingAccountError || "Select the bank account below."}
              />
            </div>

            <div
              className={
                "rounded-md border p-3 text-sm " +
                (ready
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-amber-200 bg-amber-50 text-amber-800")
              }
              data-testid="banner-online-payments-status"
            >
              {ready
                ? "Online payments are enabled. Customers can pay invoices from their share link."
                : "Online payments are disabled until every item above is configured. Payment links can't be created, and the payment webhook won't record payments."}
            </div>

            <div className="space-y-2">
              <Label htmlFor="clearing-account">Clearing account</Label>
              <p className="text-xs text-muted-foreground">
                The bank account Stripe payments are recorded against. Only bank-type
                asset accounts can be selected.
              </p>
              <Select value={clearingId} onValueChange={setClearingId} disabled={!canEdit}>
                <SelectTrigger id="clearing-account" data-testid="select-clearing-account">
                  <SelectValue placeholder="Select a bank account…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Not configured (disables online payments) —</SelectItem>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)} data-testid={`option-clearing-${a.id}`}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bankAccounts.length === 0 && (
                <p className="text-xs text-red-600">
                  No bank accounts exist yet — add one in Chart of Accounts first.
                </p>
              )}
              {!canEdit && (
                <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>
              )}
            </div>
            <Button
              onClick={() => saveClearingMut.mutate()}
              disabled={!canEdit || !org || clearingId === "" || saveClearingMut.isPending}
              data-testid="button-save-clearing-account"
            >
              {saveClearingMut.isPending ? "Saving…" : "Save clearing account"}
            </Button>
            {!envReady && (
              <p className="text-xs text-muted-foreground">
                The API key and webhook are server environment settings — ask whoever operates
                the server to set them.
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-ship-from">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" /> Ship-from address
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Used to calculate sales tax on invoices.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1 sm:col-span-1">
                <Label htmlFor="ship-city">City</Label>
                <Input
                  id="ship-city"
                  data-testid="input-ship-city"
                  value={address.city}
                  disabled={!canEdit}
                  onChange={(e) => setAddress((s) => ({ ...s, city: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ship-state">State</Label>
                <Input
                  id="ship-state"
                  data-testid="input-ship-state"
                  placeholder="TX"
                  maxLength={2}
                  value={address.state}
                  disabled={!canEdit}
                  onChange={(e) => setAddress((s) => ({ ...s, state: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ship-zip">ZIP</Label>
                <Input
                  id="ship-zip"
                  data-testid="input-ship-zip"
                  placeholder="73301"
                  value={address.zip}
                  disabled={!canEdit}
                  onChange={(e) => setAddress((s) => ({ ...s, zip: e.target.value }))}
                />
              </div>
            </div>
            <Button
              onClick={() => saveAddressMut.mutate()}
              disabled={!canEdit || !org || saveAddressMut.isPending}
              data-testid="button-save-address"
            >
              {saveAddressMut.isPending ? "Saving…" : "Save address"}
            </Button>
          </CardContent>
        </Card>

        <InventorySettings org={org} canEdit={canEdit} />
        <DimensionTrackingSettings org={org} canEdit={canEdit} />
        <DimensionManager kind="classes" title="Classes" singular="class" canEdit={canEdit} />
        <DimensionManager kind="locations" title="Locations" singular="location" canEdit={canEdit} />
        <DimensionManager kind="projects" title="Projects (jobs)" singular="project" canEdit={canEdit} />
        <BillingCard />
        {canEdit && <FxRatesEditor />}
        {canEdit && <RolesManager />}
        {canEdit && <PrivacyCard />}
        {canEdit && <YourAccountant />}
        {canEdit && (
          <Card data-testid="card-migrate-cta">
            <CardHeader><CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> Switching from QuickBooks or Xero?</CardTitle></CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">Use the guided migration wizard to bring your Chart of Accounts, contacts, catalog, open invoices/bills and opening balances across — with source auto-detect, column mapping and a dry-run preview before anything is posted.</p>
              <Button asChild><a href="/settings/import" data-testid="link-migration-wizard">Open migration wizard</a></Button>
            </CardContent>
          </Card>
        )}
        {canEdit && <DataImporters />}
        {canEdit && <WebhooksManager />}
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// "Your accountant" — active outside firms attached to THIS org, with revoke.
// ---------------------------------------------------------------------------
type Accountant = { id: number; firmName: string; grantedRole: string; approvedAt: string | null };

function YourAccountant() {
  const { toast } = useToast();
  const { data } = useQuery<{ accountants: Accountant[] }>({ queryKey: ["/api/firm/my-accountants"] });
  const revoke = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/firm/my-accountants/${id}/revoke`, {}),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["/api/firm/my-accountants"] }); toast({ title: "Accountant access revoked" }); },
    onError: (e: any) => toast({ title: "Revoke failed", description: e.message, variant: "destructive" }),
  });
  const list = data?.accountants ?? [];
  return (
    <Card data-testid="card-your-accountant">
      <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> Your accountant</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No outside accounting firm has access to this organization. Firms request access by email; you approve from the link they send.</p>
        ) : (
          list.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-sm" data-testid={`accountant-row-${a.id}`}>
              <span className="font-medium">{a.firmName}</span>
              <span className="text-muted-foreground">has {a.grantedRole} access{a.approvedAt ? ` since ${a.approvedAt.slice(0, 10)}` : ""}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => revoke.mutate(a.id)} disabled={revoke.isPending} data-testid={`button-revoke-accountant-${a.id}`}>
                <XCircle className="mr-1 h-3.5 w-3.5" /> Revoke
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// P3.11 — custom roles: a named permission set (built-in roles are immutable).
function RolesManager() {
  const { toast } = useToast();
  const { data: roles = [] } = useQuery<Array<{ id: number; name: string; permissions: string[] }>>({ queryKey: ["/api/roles"] });
  const { data: cat } = useQuery<{ permissions: string[]; builtinRoles: Record<string, string[]> }>({ queryKey: ["/api/permissions"] });
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const inv = () => queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/roles", { name: name.trim(), permissions: Object.keys(perms).filter((k) => perms[k]) }),
    onSuccess: () => { setName(""); setPerms({}); inv(); toast({ title: "Role created" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const del = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/roles/${id}`), onSuccess: inv });
  return (
    <Card data-testid="card-roles">
      <CardHeader><CardTitle>Custom roles</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">Built-in roles (owner, admin, accountant, viewer) are fixed. Create custom roles with a specific set of permissions, then assign them to members.</p>
        {roles.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border p-2 text-sm" data-testid={`role-row-${r.id}`}>
            <span className="font-medium">{r.name}</span>
            <span className="text-muted-foreground">{r.permissions.length} permission(s)</span>
            <button className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => del.mutate(r.id)} data-testid={`delete-role-${r.id}`}><XCircle className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="space-y-2">
          <Input placeholder="Role name (e.g. Auditor)" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" data-testid="input-role-name" />
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {(cat?.permissions ?? []).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={!!perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} data-testid={`perm-${k}`} /> {k}</label>
            ))}
          </div>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()} data-testid="button-create-role">Create role</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// P4.1 — subscription plan, seats, and Stripe-hosted portal/checkout.
function BillingCard() {
  const { toast } = useToast();
  const { data } = useQuery<{ plan: string; status: string; readOnly: boolean; seatLimit: number; seatsUsed: number; trialEndsAt: string | null; configured: boolean }>({ queryKey: ["/api/billing"] });
  const portal = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/billing/portal", {})).json(), onSuccess: (r: any) => { if (r.url) window.location.href = r.url; }, onError: (e: any) => toast({ title: "Billing", description: e.message, variant: "destructive" }) });
  if (!data) return null;
  return (
    <Card data-testid="card-billing">
      <CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> Subscription</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium capitalize">{data.plan}</span>
          <span className={`rounded px-1.5 py-0.5 text-xs ${data.readOnly ? "bg-red-100 text-red-800" : data.status === "past_due" ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>{data.readOnly ? "read-only" : data.status}</span>
          <span className="text-muted-foreground">· {data.seatsUsed}/{data.seatLimit} seats</span>
          {data.trialEndsAt && data.status === "trialing" && <span className="text-muted-foreground">· trial ends {data.trialEndsAt.slice(0, 10)}</span>}
        </div>
        {data.readOnly && <p className="text-xs text-red-700">Your subscription is inactive — the workspace is read-only until billing is updated.</p>}
        {data.configured
          ? <Button size="sm" variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending} data-testid="button-billing-portal">Manage billing & invoices</Button>
          : <p className="text-xs text-muted-foreground">Platform billing is not configured in this environment.</p>}
      </CardContent>
    </Card>
  );
}

// P4.3 — privacy & data rights: export, and delete-org danger zone.
function PrivacyCard() {
  const { toast } = useToast();
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });
  const [pw, setPw] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const exportMut = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/data-export", {})).json(), onSuccess: (r: any) => toast({ title: "Export ready", description: `Manifest generated (${Object.keys(r.tables || {}).length} datasets).` }), onError: (e: any) => toast({ title: "Export failed", description: e.message, variant: "destructive" }) });
  const delMut = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/org/delete-request", { password: pw, confirmName })).json(), onSuccess: (r: any) => toast({ title: "Deletion scheduled", description: `Permanent deletion on ${String(r.scheduledAt).slice(0, 10)}. An owner can cancel before then.` }), onError: (e: any) => toast({ title: "Could not schedule deletion", description: e.message, variant: "destructive" }) });
  const isOwner = me?.role === "owner";
  return (
    <Card data-testid="card-privacy">
      <CardHeader><CardTitle>Privacy & data</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">LedgerLite uses only functional cookies (session + CSRF). Export your data anytime. Financial records may be retained to meet legal obligations (financial-records hold, default 7 years).</p>
        <Button variant="outline" size="sm" onClick={() => exportMut.mutate()} disabled={exportMut.isPending} data-testid="button-export-data">Export my data</Button>
        {isOwner && (
          <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            <div className="text-sm font-medium text-destructive">Delete organization</div>
            <p className="text-xs text-muted-foreground">Permanently deletes this organization after a 7-day grace period. Enter your password and type the organization name to confirm.</p>
            <Input type="password" placeholder="Your password" value={pw} onChange={(e) => setPw(e.target.value)} className="max-w-xs" data-testid="input-delete-password" />
            <Input placeholder={me?.org?.name || "Organization name"} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="max-w-xs" data-testid="input-delete-confirm" />
            <Button variant="outline" size="sm" className="text-destructive" disabled={!pw || !confirmName || delMut.isPending} onClick={() => delMut.mutate()} data-testid="button-delete-org">Schedule deletion</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
