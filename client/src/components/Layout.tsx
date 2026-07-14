import { ReactNode, useEffect, useRef, useState } from "react";
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
  ListFilter,
  Lock,
  History,
  Percent,
  LogOut,
  Building2,
  Plus,
  Package,
  PiggyBank,
  FileSignature,
  FileMinus,
  FilePlus,
  ClipboardList,
  Boxes,
  Settings as SettingsIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { requestCreate } from "@/lib/create-shortcut";
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
  { href: "/estimates", label: "Estimates", icon: FileSignature },
  { href: "/credit-notes", label: "Credit Notes", icon: FileMinus },
  { href: "/bills", label: "Bills", icon: Receipt },
  { href: "/debit-notes", label: "Debit Notes", icon: FilePlus },
  { href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList },
  { href: "/banking", label: "Banking", icon: Landmark },
  { href: "/transactions", label: "Transactions", icon: ListFilter },
  { href: "/reconciliation", label: "Reconcile", icon: CheckSquare },
  { href: "/rules", label: "Bank Rules", icon: Filter },
  { href: "/recurring", label: "Recurring", icon: Repeat },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/vendors", label: "Vendors", icon: Truck },
  { href: "/items", label: "Products & Services", icon: Package },
  { href: "/budgets", label: "Budgeting", icon: PiggyBank },
  { href: "/accounts", label: "Chart of Accounts", icon: Library },
  { href: "/fixed-assets", label: "Fixed Assets", icon: Boxes },
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

type RecentTxn = {
  type: string; id: number; date: string;
  referenceNumber: string | null; contactName: string | null; amountCents: number; memo: string | null; url: string;
};
const TXN_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice", bill: "Bill", credit_note: "Credit Note",
  expense: "Expense", deposit: "Deposit", journal: "Journal Entry",
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

  // Recent transactions across all types — shown when the box is empty, exactly
  // like QBO's dropdown.
  const { data: recent = [] } = useQuery<RecentTxn[]>({
    queryKey: ["/api/transactions/recent"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/transactions/recent?limit=10");
      return r.json();
    },
    enabled: open,
  });

  function goAdvanced() {
    setOpen(false);
    navigate(q.trim() ? `/transactions?q=${encodeURIComponent(q.trim())}` : "/transactions");
  }

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
        placeholder="Navigate. Find transactions, contacts, reports, and more…"
        value={q}
        onValueChange={setQ}
        data-testid="input-global-search"
      />
      <CommandList>
        {q.trim() && !isFetching && results.length === 0 && (
          <CommandEmpty>No matches for “{q}”.</CommandEmpty>
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

        {/* Recent transactions — shown when the box is empty (QBO-style). */}
        {!q.trim() && recent.length > 0 && (
          <CommandGroup heading="Recent transactions">
            {recent.map((t) => (
              <CommandItem
                key={`recent-${t.type}-${t.id}`}
                value={`recent-${t.type}-${t.id}`}
                onSelect={() => { setOpen(false); navigate(t.url); }}
                data-testid={`recent-txn-${t.type}-${t.id}`}
              >
                <div className="flex items-center justify-between gap-2 w-full">
                  <span className="flex items-center gap-2 min-w-0">
                    <History className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground shrink-0">{TXN_TYPE_LABEL[t.type] ?? t.type}</span>
                    <span className="truncate">{t.contactName || t.referenceNumber || t.memo || "—"}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                    {t.date} · ${(t.amountCents / 100).toFixed(2)}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Footer: jump to the full Advanced transactions search (carries q). */}
        <CommandGroup>
          <CommandItem value="__advanced-search__" onSelect={goAdvanced} data-testid="link-advanced-search">
            <Search className="h-4 w-4 mr-2 text-muted-foreground" />
            <span className="font-medium">Advanced transactions search</span>
            <span className="text-xs text-muted-foreground ml-2">for more results</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// ----------------------------------------------------------------------------
// Create menu (QBO "+ Create"). Grouped columns of shortcuts that jump to the
// relevant page — and, where a create dialog exists, open it directly via the
// ?new=1 marker (see lib/create-shortcut). Only REAL destinations are listed:
// items whose feature has no page are intentionally omitted rather than shipped
// as dead links. (QBO's "Team" column — time activity, timesheets, contractors
// — has no counterpart in this app yet, so it isn't shown.)
// ----------------------------------------------------------------------------
// `create: true` opens that page's create dialog on arrival (via the
// sessionStorage handoff); otherwise the item just navigates to the page where
// that action lives. Only real destinations are listed — no dead links. (QBO's
// "Team" column — time activity, timesheets, contractors — has no counterpart
// in this app yet, so it is intentionally omitted.)
type CreateItem = { label: string; path: string; create?: boolean; testId: string };
type CreateColumn = { heading: string; items: CreateItem[] };

const CREATE_COLUMNS: CreateColumn[] = [
  {
    heading: "Customers",
    items: [
      { label: "Invoice", path: "/invoices", create: true, testId: "create-invoice" },
      { label: "Estimate", path: "/estimates", create: true, testId: "create-estimate-doc" },
      { label: "Receive payment", path: "/invoices", testId: "create-receive-payment" },
      { label: "Credit note", path: "/credit-notes", create: true, testId: "create-credit-note" },
      { label: "Recurring payment", path: "/recurring", create: true, testId: "create-recurring" },
      { label: "Statement", path: "/statements", testId: "create-statement" },
      { label: "Add customer", path: "/customers", create: true, testId: "create-customer" },
    ],
  },
  {
    heading: "Vendors",
    items: [
      { label: "Bill", path: "/bills", create: true, testId: "create-bill" },
      { label: "Expense", path: "/banking", create: true, testId: "create-expense" },
      { label: "Pay bills", path: "/bills", testId: "create-pay-bills" },
      { label: "Debit note", path: "/debit-notes", create: true, testId: "create-debit-note" },
      { label: "Purchase order", path: "/purchase-orders", create: true, testId: "create-po" },
      { label: "Add vendor", path: "/vendors", create: true, testId: "create-vendor" },
    ],
  },
  {
    heading: "Other",
    items: [
      { label: "Bank deposit", path: "/banking", create: true, testId: "create-bank-deposit" },
      { label: "Transfer", path: "/banking", create: true, testId: "create-transfer" },
      { label: "Journal entry", path: "/journal", create: true, testId: "create-journal" },
      { label: "Bank rule", path: "/rules", create: true, testId: "create-bank-rule" },
      { label: "Add product/service", path: "/items", create: true, testId: "create-item" },
      { label: "Reconcile", path: "/reconciliation", testId: "create-reconcile" },
    ],
  },
];

function CreateMenu() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const go = (item: CreateItem) => {
    setOpen(false);
    if (item.create) requestCreate(item.path); // open the page's create dialog on arrival
    navigate(item.path);
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        onClick={() => setOpen((v) => !v)}
        data-testid="button-create"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="h-4 w-4 mr-1.5" />
        Create
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[34rem] max-w-[90vw] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-4 z-40"
          data-testid="menu-create"
        >
          <div className="grid grid-cols-3 gap-4">
            {CREATE_COLUMNS.map((col) => (
              <div key={col.heading}>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  {col.heading}
                </div>
                <ul className="space-y-0.5">
                  {col.items.map((it) => (
                    <li key={it.testId}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => go(it)}
                        data-testid={`link-${it.testId}`}
                        className="w-full text-left rounded px-2 py-1.5 text-sm hover-elevate active-elevate-2"
                      >
                        {it.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Settings menu (QBO gear). Grouped shortcuts to settings/tools/profile that
// exist in this app. Real destinations only — QBO items with no counterpart
// (Workers' comp, Order checks, Import desktop data, Subscriptions, Resolution
// center, Share screen, …) are omitted rather than shipped as dead links.
// ----------------------------------------------------------------------------
type GearItem = { label: string; path?: string; testId: string };
type GearColumn = { heading: string; items: GearItem[] };

const GEAR_COLUMNS: GearColumn[] = [
  {
    heading: "Your Company",
    items: [
      { label: "Account and settings", path: "/settings", testId: "gear-settings" },
      { label: "Chart of accounts", path: "/accounts", testId: "gear-accounts" },
      { label: "Sales tax", path: "/tax-codes", testId: "gear-sales-tax" },
    ],
  },
  {
    heading: "Lists",
    items: [
      { label: "Products and services", path: "/items", testId: "gear-items" },
      { label: "Recurring transactions", path: "/recurring", testId: "gear-recurring" },
      { label: "Rules", path: "/rules", testId: "gear-rules" },
    ],
  },
  {
    heading: "Tools",
    items: [
      { label: "Reconcile", path: "/reconciliation", testId: "gear-reconcile" },
      { label: "Budgeting", path: "/budgets", testId: "gear-budgeting" },
      { label: "Audit log", path: "/audit", testId: "gear-audit" },
      { label: "Period close", path: "/period-close", testId: "gear-period-close" },
    ],
  },
];

function SettingsMenu() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function switchOrg(orgId: number) {
    setOpen(false);
    try {
      await apiRequest("POST", "/api/auth/switch-org", { orgId });
      queryClient.clear();
      await queryClient.invalidateQueries();
    } catch (e: any) {
      toast({ title: "Could not switch company", description: e.message, variant: "destructive" });
    }
  }
  async function logout() {
    setOpen(false);
    try { await apiRequest("POST", "/api/auth/logout"); }
    finally { queryClient.clear(); window.location.hash = "#/"; window.location.reload(); }
  }

  const otherOrgs = (me?.orgs ?? []).filter((o) => o.id !== me?.org?.id);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="button-gear"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        className="p-2 rounded-md text-muted-foreground hover-elevate active-elevate-2"
      >
        <SettingsIcon className="h-5 w-5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[44rem] max-w-[92vw] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-4 z-40"
          data-testid="menu-gear"
        >
          <div className="grid grid-cols-4 gap-4">
            {GEAR_COLUMNS.map((col) => (
              <div key={col.heading}>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">{col.heading}</div>
                <ul className="space-y-0.5">
                  {col.items.map((it) => (
                    <li key={it.testId}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setOpen(false); if (it.path) navigate(it.path); }}
                        data-testid={`link-${it.testId}`}
                        className="w-full text-left rounded px-2 py-1.5 text-sm hover-elevate active-elevate-2"
                      >
                        {it.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {/* PROFILE — real account actions. */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Profile</div>
              <ul className="space-y-0.5">
                <li>
                  <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate("/security"); }} data-testid="link-gear-security"
                    className="w-full text-left rounded px-2 py-1.5 text-sm hover-elevate active-elevate-2">Security</button>
                </li>
                <li>
                  <button type="button" role="menuitem" onClick={logout} data-testid="link-gear-signout"
                    className="w-full text-left rounded px-2 py-1.5 text-sm hover-elevate active-elevate-2">Sign out</button>
                </li>
                {otherOrgs.length > 0 && (
                  <li className="pt-1.5 mt-1 border-t border-border">
                    <div className="px-2 text-[11px] uppercase tracking-wide text-muted-foreground">Switch company</div>
                    {otherOrgs.map((o) => (
                      <button key={o.id} type="button" role="menuitem" onClick={() => switchOrg(o.id)} data-testid={`link-gear-switch-${o.id}`}
                        className="w-full text-left rounded px-2 py-1.5 text-sm hover-elevate active-elevate-2 truncate">{o.name}</button>
                    ))}
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
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
            <CreateMenu />
            <SettingsMenu />
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
