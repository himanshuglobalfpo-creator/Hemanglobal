import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  Truck,
  FileText,
  Receipt,
  Landmark,
  Library,
  BarChart3,
  Sprout,
  CheckSquare,
  Filter,
  Repeat,
  Mail,
  Search,
  Lock,
  History,
  Percent,
  LogOut,
  Building2,
  Settings as SettingsIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { Me } from "@/App";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/bills", label: "Bills", icon: Receipt },
  { href: "/banking", label: "Banking", icon: Landmark },
  { href: "/reconciliation", label: "Reconcile", icon: CheckSquare },
  { href: "/rules", label: "Bank Rules", icon: Filter },
  { href: "/recurring", label: "Recurring", icon: Repeat },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/vendors", label: "Vendors", icon: Truck },
  { href: "/accounts", label: "Chart of Accounts", icon: Library },
  { href: "/journal", label: "Journal", icon: BookOpen },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/statements", label: "Statements", icon: Mail },
  { href: "/tax-codes", label: "Sales Tax", icon: Percent },
  { href: "/period-close", label: "Period Close", icon: Lock },
  { href: "/audit", label: "Audit Log", icon: History },
  { href: "/security", label: "Security", icon: History },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

type SearchResult = {
  kind: string;
  id: number;
  title: string;
  subtitle?: string;
  amount?: number;
  date?: string;
  url: string;
};

function GlobalSearch({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const { data: results = [], isFetching } = useQuery<SearchResult[]>({
    queryKey: ["/api/search", q],
    queryFn: async () => {
      if (!q.trim()) return [];
      const r = await apiRequest("GET", `/api/search?q=${encodeURIComponent(q)}`);
      return r.json();
    },
    enabled: open && q.trim().length > 0,
  });

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.kind] = acc[r.kind] || []).push(r);
    return acc;
  }, {});
  const groupOrder = [
    "customer",
    "vendor",
    "invoice",
    "bill",
    "account",
    "journal",
    "bank_transaction",
  ];
  const groupLabel: Record<string, string> = {
    customer: "Customers",
    vendor: "Vendors",
    invoice: "Invoices",
    bill: "Bills",
    account: "Accounts",
    journal: "Journal entries",
    bank_transaction: "Bank transactions",
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search customers, invoices, accounts, journal…"
        value={q}
        onValueChange={setQ}
        data-testid="input-global-search"
      />
      <CommandList>
        {q.trim() && !isFetching && results.length === 0 && (
          <CommandEmpty>No matches for “{q}”.</CommandEmpty>
        )}
        {!q.trim() && (
          <CommandEmpty>Start typing to search the entire ledger.</CommandEmpty>
        )}
        {groupOrder
          .filter((k) => grouped[k]?.length)
          .map((k) => (
            <CommandGroup key={k} heading={groupLabel[k] || k}>
              {grouped[k].map((r) => (
                <CommandItem
                  key={`${r.kind}-${r.id}`}
                  value={`${r.kind}-${r.id}-${r.title}-${r.subtitle || ""}`}
                  onSelect={() => {
                    setOpen(false);
                    navigate(r.url);
                  }}
                  data-testid={`search-result-${r.kind}-${r.id}`}
                >
                  <div className="flex flex-col gap-0.5 w-full">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{r.title}</span>
                      {r.amount !== undefined && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          ${Number(r.amount).toFixed(2)}
                        </span>
                      )}
                    </div>
                    {r.subtitle && (
                      <span className="text-xs text-muted-foreground">{r.subtitle}</span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
      </CommandList>
    </CommandDialog>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg
        aria-label="LedgerLite logo"
        viewBox="0 0 32 32"
        fill="none"
        className="h-7 w-7 text-primary"
      >
        <rect x="3" y="5" width="26" height="22" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M8 11h16M8 16h16M8 21h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="24" cy="22" r="3" fill="currentColor" />
      </svg>
      <span className="font-semibold tracking-tight text-base">LedgerLite</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Email verification banner — shown above the main content for signed-in users
// whose email is not yet verified. Dismissable per session (localStorage).
// Never blocks access to any page.
// ----------------------------------------------------------------------------
function EmailVerificationBanner() {
  const { toast } = useToast();
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("verifyBannerDismissed") === "1",
  );
  const [resent, setResent] = useState(false);
  const [sending, setSending] = useState(false);

  // /api/auth/me now returns emailVerified — tolerate it living on the root or on user.
  const emailVerified =
    (me as any)?.emailVerified ?? (me?.user as any)?.emailVerified;

  if (!me?.user || emailVerified !== false || dismissed) return null;

  async function resend() {
    setSending(true);
    try {
      await apiRequest("POST", "/api/auth/resend-verification");
      setResent(true);
    } catch (e: any) {
      toast({ title: "Could not resend email", description: e.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="w-full bg-[#fef9c3] border-b border-yellow-200 text-yellow-900"
      data-testid="banner-verify-email"
    >
      <div className="max-w-6xl mx-auto px-8 py-2 flex items-center justify-between gap-4 text-sm">
        <span>⚠️ Please verify your email address. Check your inbox for a verification link.</span>
        <span className="flex items-center gap-4 shrink-0">
          {resent ? (
            <span className="font-medium" data-testid="text-verification-sent">
              Sent!
            </span>
          ) : (
            <button
              type="button"
              onClick={resend}
              disabled={sending}
              className="underline hover:text-yellow-950 disabled:opacity-60"
              data-testid="button-resend-verification"
            >
              {sending ? "Sending…" : "Resend email"}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              localStorage.setItem("verifyBannerDismissed", "1");
              setDismissed(true);
            }}
            className="text-lg leading-none hover:text-yellow-950"
            data-testid="button-dismiss-verification"
          >
            ×
          </button>
        </span>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { toast } = useToast();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function seedDemo() {
    try {
      await apiRequest("POST", "/api/seed-demo");
      await queryClient.invalidateQueries();
      toast({ title: "Demo data loaded", description: "Sample customers, vendors, invoices, and bills added." });
    } catch (e: any) {
      toast({ title: "Seed failed", description: e.message, variant: "destructive" });
    }
  }

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="px-4 py-5 border-b border-sidebar-border">
          <Logo />
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/\s/g, "-")}`}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm hover-elevate active-elevate-2",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border space-y-2">
          <AccountSection />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={seedDemo}
            data-testid="button-seed-demo"
          >
            <Sprout className="h-4 w-4 mr-2" />
            Load demo data
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="max-w-6xl mx-auto px-8 py-3 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              data-testid="button-open-search"
              className="flex-1 max-w-md flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover-elevate text-left"
            >
              <Search className="h-4 w-4" />
              <span>Search anything…</span>
              <kbd className="ml-auto pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                ⌘K
              </kbd>
            </button>
          </div>
        </div>
        <EmailVerificationBanner />
        <div className="max-w-6xl mx-auto px-8 py-8">{children}</div>
      </main>
      <GlobalSearch open={searchOpen} setOpen={setSearchOpen} />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">
          {title}
        </h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}


// ----------------------------------------------------------------------------
// Account section: active org (switchable when the user belongs to several),
// signed-in user, and logout.
// ----------------------------------------------------------------------------
function AccountSection() {
  const { toast } = useToast();
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });
  if (!me?.user) return null;

  async function switchOrg(orgId: string) {
    try {
      await apiRequest("POST", "/api/auth/switch-org", { orgId: Number(orgId) });
      // Every cached query belongs to the previous org — drop it all.
      queryClient.clear();
      await queryClient.invalidateQueries();
    } catch (e: any) {
      toast({ title: "Could not switch organization", description: e.message, variant: "destructive" });
    }
  }

  async function logout() {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } finally {
      queryClient.clear();
      window.location.hash = "#/";
      window.location.reload();
    }
  }

  return (
    <div className="space-y-2">
      {me.orgs.length > 1 ? (
        <Select value={me.org ? String(me.org.id) : undefined} onValueChange={switchOrg}>
          <SelectTrigger className="w-full h-8 text-xs" data-testid="select-active-org">
            <Building2 className="h-3.5 w-3.5 mr-1.5 shrink-0" />
            <SelectValue placeholder="Pick organization" />
          </SelectTrigger>
          <SelectContent>
            {me.orgs.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                {o.name} · {o.role}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        me.org && (
          <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground truncate">
            <Building2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{me.org.name}</span>
          </div>
        )
      )}
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs text-muted-foreground truncate" title={me.user.email}>
          {me.user.name || me.user.email}
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={logout} data-testid="button-logout">
          <LogOut className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
