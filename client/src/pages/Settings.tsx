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
import { CheckCircle2, XCircle, CreditCard, MapPin } from "lucide-react";
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

export default function Settings() {
  const { toast } = useToast();

  const { data: me } = useQuery<Me & { org: (Me["org"] & {
    addressCity?: string | null;
    addressState?: string | null;
    addressZip?: string | null;
    stripeClearingAccountId?: number | null;
  }) | null }>({ queryKey: ["/api/auth/me"] });
  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const { data: stripe } = useQuery<StripeStatus>({ queryKey: ["/api/stripe/status"] });

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
      </div>
    </Layout>
  );
}
