import { Component, ErrorInfo, ReactNode, Suspense, lazy, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

// Auth and NotFound stay eager: Auth is the first screen an anonymous visitor
// sees (a lazy chunk there just adds a flash), and NotFound is tiny.
import NotFound from "@/pages/not-found";
import Auth from "@/pages/Auth";

// Route-based code splitting: every authenticated page is its own chunk, loaded
// on navigation. This keeps the initial bundle small — heavy dependencies like
// recharts (Reports/Dashboard) never ship until a page that needs them renders.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Customers = lazy(() => import("@/pages/Customers"));
const Vendors = lazy(() => import("@/pages/Vendors"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Invoices = lazy(() => import("@/pages/Invoices"));
const Bills = lazy(() => import("@/pages/Bills"));
const Banking = lazy(() => import("@/pages/Banking"));
const Transactions = lazy(() => import("@/pages/Transactions"));
const Journal = lazy(() => import("@/pages/Journal"));
const Reports = lazy(() => import("@/pages/Reports"));
const BankRules = lazy(() => import("@/pages/BankRules"));
const Reconciliation = lazy(() => import("@/pages/Reconciliation"));
const Recurring = lazy(() => import("@/pages/Recurring"));
const Statements = lazy(() => import("@/pages/Statements"));
const SalesTax = lazy(() => import("@/pages/SalesTax"));
const PeriodClose = lazy(() => import("@/pages/PeriodClose"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const Security = lazy(() => import("@/pages/Security"));
const Settings = lazy(() => import("@/pages/Settings"));
const MigrationWizard = lazy(() => import("@/pages/MigrationWizard"));
const ProductsServices = lazy(() => import("@/pages/ProductsServices"));
const Budgeting = lazy(() => import("@/pages/Budgeting"));
const Estimates = lazy(() => import("@/pages/Estimates"));
const CreditNotes = lazy(() => import("@/pages/CreditNotes"));
const DebitNotes = lazy(() => import("@/pages/DebitNotes"));
const PurchaseOrders = lazy(() => import("@/pages/PurchaseOrders"));
const FixedAssets = lazy(() => import("@/pages/FixedAssets"));
const Payroll = lazy(() => import("@/pages/Payroll"));

// Shown while a lazily-loaded page chunk is being fetched.
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
      Loading…
    </div>
  );
}

// Error boundary: when a page throws (typically due to a malformed API response or a
// missing field), show a recoverable error screen instead of a white page.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px 20px", maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
          <h1 style={{ color: "#b91c1c", marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#475569", marginBottom: 16 }}>
            The page hit an unexpected error. Try reloading. If it keeps happening, the
            details below may help diagnose it.
          </p>
          <pre style={{ background: "#f1f5f9", padding: 12, borderRadius: 6, fontSize: 12, overflow: "auto" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button
              onClick={() => this.setState({ error: null })}
              style={{ padding: "8px 14px", background: "#0f766e", color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}
            >
              Try again
            </button>
            <button
              onClick={() => { window.location.hash = "#/"; this.setState({ error: null }); }}
              style={{ padding: "8px 14px", background: "#e2e8f0", color: "#0f172a", border: 0, borderRadius: 6, cursor: "pointer" }}
            >
              Go to dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppRouter() {
  return (
    <Suspense fallback={<PageLoader />}>
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/customers" component={Customers} />
      <Route path="/vendors" component={Vendors} />
      <Route path="/accounts" component={Accounts} />
      <Route path="/invoices" component={Invoices} />
      <Route path="/bills" component={Bills} />
      <Route path="/banking" component={Banking} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/reconciliation" component={Reconciliation} />
      <Route path="/rules" component={BankRules} />
      <Route path="/recurring" component={Recurring} />
      <Route path="/journal" component={Journal} />
      <Route path="/reports" component={Reports} />
      <Route path="/statements" component={Statements} />
      <Route path="/tax-codes" component={SalesTax} />
      <Route path="/period-close" component={PeriodClose} />
      <Route path="/audit" component={AuditLog} />
      <Route path="/security" component={Security} />
      <Route path="/settings/import" component={MigrationWizard} />
      <Route path="/settings" component={Settings} />
      <Route path="/items" component={ProductsServices} />
      <Route path="/budgets" component={Budgeting} />
      <Route path="/estimates" component={Estimates} />
      <Route path="/credit-notes" component={CreditNotes} />
      <Route path="/debit-notes" component={DebitNotes} />
      <Route path="/purchase-orders" component={PurchaseOrders} />
      <Route path="/fixed-assets" component={FixedAssets} />
      <Route path="/payroll" component={Payroll} />
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

// Session info shared with Layout (org switcher / logout) via react-query cache.
export type Me = {
  user: { id: number; email: string; name: string; emailVerified?: boolean; createdAt?: string } | null;
  org: {
    id: number; name: string; slug: string;
    // Dimension tracking switches (QBO-style) — gate the class/location/project
    // pickers across the UI.
    enableClassTracking?: boolean;
    enableLocationTracking?: boolean;
    enableProjectTracking?: boolean;
    // Invoice form (Manage panel) preferences — served fully defaulted.
    invoiceSettings?: import("@shared/schema").InvoiceSettings;
  } | null;
  role: string | null;
  orgs: Array<{ id: number; name: string; slug: string; role: string }>;
};

// Handles the link from the verification email: /#/verify-email?token=...
// Posts the token, reports the result, and offers a way back into the app.
function VerifyEmail() {
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Verifying your email…");
  useEffect(() => {
    const qs = window.location.hash.split("?")[1] || "";
    const token = new URLSearchParams(qs).get("token") || "";
    apiRequest("POST", "/api/auth/verify-email", { token })
      .then(async (r) => {
        const body = await r.json();
        setState("done");
        setMessage(body.message || "Email verified. Thanks!");
        queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      })
      .catch((e: any) => {
        setState("error");
        setMessage(String(e?.message || "Verification failed"));
      });
  }, []);
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-lg border p-6 text-center space-y-4">
        <h1 className="text-lg font-semibold">Email verification</h1>
        <p className={state === "error" ? "text-red-600 text-sm" : "text-sm"}>{message}</p>
        <a href="#/" className="inline-block text-sm underline">Back to LedgerLite</a>
      </div>
    </div>
  );
}

// Verification banner. Mirrors the server rule: 24h grace after signup, then
// business APIs 403 with code EMAIL_UNVERIFIED. During grace it's a dismissable
// warning strip; past grace it becomes a blocking overlay with a resend button.
function EmailVerificationBanner({ me }: { me: Me }) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  if (!me.user || me.user.emailVerified !== false) return null;
  const createdMs = me.user.createdAt ? new Date(me.user.createdAt).getTime() : Date.now();
  const pastGrace = Date.now() - createdMs > 24 * 60 * 60 * 1000;

  const resend = async () => {
    setSending(true);
    try {
      await apiRequest("POST", "/api/auth/resend-verification", {});
      setSent(true);
    } catch {
      /* authLimiter or transient error — the button stays available */
    } finally {
      setSending(false);
    }
  };

  const inner = (
    <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
      <span>
        {pastGrace
          ? "Please verify your email to continue using LedgerLite."
          : "Please verify your email — unverified accounts lose access 24 hours after signup."}
      </span>
      <button
        onClick={resend}
        disabled={sending || sent}
        className="rounded border px-3 py-1 font-medium bg-white text-amber-900 disabled:opacity-60"
      >
        {sent ? "Sent — check your inbox" : sending ? "Sending…" : "Resend verification email"}
      </button>
    </div>
  );

  if (pastGrace) {
    // BLOCKING: overlay the whole app (matches the API's EMAIL_UNVERIFIED 403s).
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-lg bg-amber-50 border border-amber-300 p-6 text-amber-900">
          {inner}
        </div>
      </div>
    );
  }
  return <div className="bg-amber-50 border-b border-amber-300 text-amber-900 px-4 py-2">{inner}</div>;
}

// Gate: everything behind a session. /api/auth/me returns { user: null } when
// anonymous (it never 401s), so a plain query is enough.
function AuthGate() {
  const { data: me, isLoading, isError } = useQuery<Me>({ queryKey: ["/api/auth/me"] });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }
  // The verification link must work even for anonymous visitors (they clicked
  // it from their inbox) — route it before the session check.
  if (window.location.hash.startsWith("#/verify-email")) {
    return <VerifyEmail />;
  }
  if (isError || !me?.user) {
    return <Auth />;
  }
  return (
    <>
      <EmailVerificationBanner me={me} />
      <AppRouter />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <ErrorBoundary>
            <AuthGate />
          </ErrorBoundary>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
