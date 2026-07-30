import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePlaidLink } from "react-plaid-link";
import {
  Plus,
  Upload,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Sparkles,
  Building2,
  CheckCircle2,
  XCircle,
  Banknote,
  Undo2,
} from "lucide-react";
import type { Account } from "@shared/schema";
import { useOpenOnCreateParam } from "@/lib/create-shortcut";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, todayISO } from "@/lib/format";
import type { Me } from "@/App";

// ============================================================
// Dimension (class / location / project) tracking — QBO-style
// ============================================================
// A dimension's picker only appears when the org has that tracking switch on
// (Settings → Dimension tracking). The selected ids ride along on the match /
// manual-entry payload and are validated org-scoped on the server.
export type Dims = { classId: number | null; locationId: number | null; projectId: number | null };
export const EMPTY_DIMS: Dims = { classId: null, locationId: null, projectId: null };

type DimItem = { id: number; name: string; isActive: boolean };

function useDimensionTracking() {
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });
  const enableClass = !!me?.org?.enableClassTracking;
  const enableLocation = !!me?.org?.enableLocationTracking;
  const enableProject = !!me?.org?.enableProjectTracking;
  const anyEnabled = enableClass || enableLocation || enableProject;
  // Only fetch a dimension list when its tracking is on.
  const { data: classes = [] } = useQuery<DimItem[]>({ queryKey: ["/api/classes"], enabled: enableClass });
  const { data: locations = [] } = useQuery<DimItem[]>({ queryKey: ["/api/locations"], enabled: enableLocation });
  const { data: projects = [] } = useQuery<DimItem[]>({ queryKey: ["/api/projects"], enabled: enableProject });
  return { enableClass, enableLocation, enableProject, anyEnabled, classes, locations, projects };
}

// Renders a labelled <select> for each ENABLED dimension. `current` keeps a
// deactivated-but-already-selected option visible so it never silently drops.
function DimensionSelects({ dims, onChange, testPrefix }: {
  dims: Dims;
  onChange: (next: Dims) => void;
  testPrefix: string;
}) {
  const { enableClass, enableLocation, enableProject, anyEnabled, classes, locations, projects } = useDimensionTracking();
  if (!anyEnabled) return null;

  const Row = ({ label, kind, value, items }: { label: string; kind: keyof Dims; value: number | null; items: DimItem[] }) => (
    <div>
      <Label>{label} <span className="text-muted-foreground font-normal">— optional</span></Label>
      <select
        className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        data-testid={`${testPrefix}-${kind}`}
        value={value?.toString() ?? ""}
        onChange={(e) => onChange({ ...dims, [kind]: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">— None —</option>
        {items.filter((it) => it.isActive || it.id === value).map((it) => (
          <option key={it.id} value={it.id}>{it.name}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-3">
      {enableClass && <Row label="Class" kind="classId" value={dims.classId} items={classes} />}
      {enableLocation && <Row label="Location" kind="locationId" value={dims.locationId} items={locations} />}
      {enableProject && <Row label="Project" kind="projectId" value={dims.projectId} items={projects} />}
    </div>
  );
}

type BankTx = {
  id: number;
  bankAccountId: number;
  date: string;
  description: string;
  amount: number;
  status: "unmatched" | "matched" | "ignored";
  entryId?: number | null;
  source: "manual" | "csv" | "plaid";
  payee?: string | null;
  vendorId?: number | null;
  categoryName?: string | null;
};

// Per-account summary powering the Banking page cards.
type BankAccountSummary = {
  accountId: number;
  code: string;
  name: string;
  subtype: string | null;
  ledgerBalanceCents: number;
  reviewCount: number;
  lastImportedAt: string | null;
  feedBalanceCents: number | null;
  feedBalanceAt: string | null;
};

type Suggestion = {
  kind: "invoice" | "bill";
  id: number;
  number: string;
  date: string;
  partyName: string;
  total: number;
  balance: number;
  score: number;
};

type PlaidStatus = { configured: boolean; env: string; message: string };

// ---- Lightweight CSV parser (handles quoted fields with commas) ----
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        cur.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (field !== "" || cur.length) {
          cur.push(field);
          rows.push(cur);
          cur = [];
          field = "";
        }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        field += c;
      }
    }
  }
  if (field !== "" || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export default function Banking() {
  const [activeBankId, setActiveBankId] = useState<number | null>(null);
  const [tab, setTab] = useState("review");
  const [manualOpen, setManualOpen] = useState(false);
  useOpenOnCreateParam(() => setManualOpen(true)); // global "+ Create → Expense / Bank deposit / Transfer"
  const [importOpen, setImportOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState<BankTx | null>(null);

  const { data: accounts = [] } = useQuery<Account[]>({ queryKey: ["/api/accounts"] });
  const bankAccts = useMemo(
    () => accounts.filter((a) => a.subtype === "bank" || a.subtype === "credit_card"),
    [accounts]
  );

  // Per-account cards: ledger balance, review count, last import, feed balance.
  const { data: summaries = [] } = useQuery<BankAccountSummary[]>({ queryKey: ["/api/accounts/balances"] });

  // Auto-select first bank account
  useEffect(() => {
    if (activeBankId === null && bankAccts.length > 0) {
      setActiveBankId(bankAccts[0].id);
    }
  }, [bankAccts, activeBankId]);

  const { data: txAll = [] } = useQuery<BankTx[]>({
    queryKey: ["/api/bank-transactions", { bankAccountId: activeBankId }],
    queryFn: async () => {
      if (activeBankId === null) return [];
      // Paginated endpoint (Task 1): request max page, unwrap .rows.
      const r = await apiRequest("GET", `/api/bank-transactions?bankAccountId=${activeBankId}&limit=200`);
      const body = await r.json();
      return Array.isArray(body) ? body : body.rows ?? [];
    },
    enabled: activeBankId !== null,
  });

  const { data: plaid } = useQuery<PlaidStatus>({ queryKey: ["/api/plaid/status"] });

  // Three QBO tabs, all scoped to the selected account.
  const unmatched = txAll.filter((t) => t.status === "unmatched");
  const matched = txAll.filter((t) => t.status === "matched");
  const ignored = txAll.filter((t) => t.status === "ignored");

  return (
    <Layout>
      <PageHeader
        title="Banking"
        description="Record deposits, withdrawals, transfers and reconcile bank activity to your books"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)} data-testid="button-import-csv">
              <Upload className="h-4 w-4 mr-1.5" />
              Import CSV
            </Button>
            <Button onClick={() => setManualOpen(true)} data-testid="button-new-manual">
              <Plus className="h-4 w-4 mr-1.5" />
              New transaction
            </Button>
          </div>
        }
      />

      {/* Horizontally scrollable account cards (QBO-style) */}
      {bankAccts.length === 0 ? (
        <Card className="mb-6">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              No bank or credit card accounts. Add one in Chart of Accounts (subtype = bank or credit_card).
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 mb-6" data-testid="row-account-cards">
          {bankAccts.map((a) => {
            const s = summaries.find((x) => x.accountId === a.id);
            const reviewCount = s?.reviewCount ?? txAll.filter((t) => t.bankAccountId === a.id && t.status === "unmatched").length;
            const selected = activeBankId === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setActiveBankId(a.id)}
                data-testid={`card-bank-${a.id}`}
                className={`shrink-0 w-60 text-left rounded-lg border p-4 hover-elevate active-elevate-2 ${
                  selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Banknote className="h-4 w-4 text-primary" />
                  <span className="font-medium truncate">{a.name}</span>
                </div>
                <div className="mt-2 text-2xl font-semibold tabular-nums" data-testid={`text-ledger-balance-${a.id}`}>
                  {fmtMoney(s?.ledgerBalanceCents ?? 0)}
                </div>
                <div className="text-xs text-muted-foreground">In LedgerLite · {a.code}</div>
                {s?.feedBalanceCents != null && (
                  <div className="mt-1 text-xs text-muted-foreground" data-testid={`text-feed-balance-${a.id}`}>
                    Bank feed: <span className="tabular-nums">{fmtMoney(s.feedBalanceCents)}</span>
                    {s.feedBalanceAt ? ` · ${fmtDate(s.feedBalanceAt)}` : ""}
                  </div>
                )}
                {s?.lastImportedAt && (
                  <div className="text-xs text-muted-foreground" data-testid={`text-last-import-${a.id}`}>
                    Last import {fmtDate(s.lastImportedAt)}
                  </div>
                )}
                <div className="mt-2">
                  {reviewCount > 0 ? (
                    <Badge variant="secondary" className="text-xs" data-testid={`badge-review-${a.id}`}>
                      {reviewCount} to review
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">All caught up</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Connect a bank (Plaid) */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Building2 className="h-5 w-5 text-primary mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium">Connect a bank</p>
              <p className="text-xs text-muted-foreground mt-1">
                {plaid?.message || "Checking Plaid status..."}
              </p>
              <PlaidConnectButton
                configured={!!plaid?.configured}
                activeBankId={activeBankId}
                activeBankName={bankAccts.find((a) => a.id === activeBankId)?.name}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="review" data-testid="tab-review">
            For review
            {unmatched.length > 0 && (
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                {unmatched.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="categorized" data-testid="tab-categorized">
            Categorized
            {matched.length > 0 && (
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                {matched.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="excluded" data-testid="tab-excluded">
            Excluded
            {ignored.length > 0 && (
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                {ignored.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="review" className="mt-4">
          <TxTable variant="review" rows={unmatched} emptyText="No transactions waiting for review." onMatch={(t) => setMatchOpen(t)} />
        </TabsContent>
        <TabsContent value="categorized" className="mt-4">
          <TxTable variant="categorized" rows={matched} emptyText="Nothing categorized yet." onMatch={(t) => setMatchOpen(t)} />
        </TabsContent>
        <TabsContent value="excluded" className="mt-4">
          <TxTable variant="excluded" rows={ignored} emptyText="Nothing excluded." onMatch={(t) => setMatchOpen(t)} />
        </TabsContent>
      </Tabs>

      {manualOpen && activeBankId !== null && (
        <ManualEntryDialog
          open={manualOpen}
          onClose={() => setManualOpen(false)}
          accounts={accounts}
          bankAccountId={activeBankId}
        />
      )}

      {importOpen && activeBankId !== null && (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          bankAccountId={activeBankId}
        />
      )}

      {matchOpen && (
        <MatchDialog tx={matchOpen} accounts={accounts} onClose={() => setMatchOpen(null)} />
      )}
    </Layout>
  );
}

// One table, three variants:
//   review      → Match button + inline suggestion rows (unmatched)
//   categorized → Category column + Undo (matched)
//   excluded    → Undo (ignored)
function TxTable({
  variant,
  rows,
  emptyText,
  onMatch,
}: {
  variant: "review" | "categorized" | "excluded";
  rows: BankTx[];
  emptyText: string;
  onMatch: (t: BankTx) => void;
}) {
  const isReview = variant === "review";
  const isCategorized = variant === "categorized";
  const colCount = 5 + (isCategorized ? 1 : 0) + 1; // date, desc, payee, source, amount [+category] + actions
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Payee</th>
              {isCategorized && <th className="px-4 py-3 font-medium">Category</th>}
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const isIn = t.amount > 0;
              const mainRow = (
                <tr
                  key={`row-${t.id}`}
                  className="border-b border-border last:border-0 hover-elevate"
                  data-testid={`row-banktx-${t.id}`}
                >
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(t.date)}</td>
                  <td className="px-4 py-3">{t.description}</td>
                  <td className="px-4 py-3 text-muted-foreground" data-testid={`text-payee-${t.id}`}>{t.payee || ""}</td>
                  {isCategorized && (
                    <td className="px-4 py-3" data-testid={`text-category-${t.id}`}>
                      {t.categoryName || <span className="text-muted-foreground">—</span>}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs capitalize">
                      {t.source}
                    </Badge>
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-medium tabular-nums ${
                      isIn ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {isIn ? "+" : ""}
                    {fmtMoney(t.amount)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isReview ? (
                      <Button size="sm" variant="outline" onClick={() => onMatch(t)} data-testid={`button-match-${t.id}`}>
                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                        Match
                      </Button>
                    ) : (
                      <UndoButton tx={t} />
                    )}
                  </td>
                </tr>
              );
              if (!isReview) return mainRow;
              return (
                <Fragment key={t.id}>
                  {mainRow}
                  <SuggestionRow tx={t} onMatch={onMatch} />
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// Undo a categorization/exclusion — deletes the match's journal entry and
// returns the row to For Review (server: /api/bank-transactions/:id/unmatch).
function UndoButton({ tx }: { tx: BankTx }) {
  const { toast } = useToast();
  const undoMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/bank-transactions/${tx.id}/unmatch`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/trial-balance"] });
      toast({ title: "Undone", description: "Returned to For Review." });
    },
    onError: (e: any) => toast({ title: "Undo failed", description: e.message, variant: "destructive" }),
  });
  return (
    <Button size="sm" variant="outline" onClick={() => undoMut.mutate()} disabled={undoMut.isPending} data-testid={`button-undo-${tx.id}`}>
      <Undo2 className="h-3.5 w-3.5 mr-1" />
      {undoMut.isPending ? "Undoing…" : "Undo"}
    </Button>
  );
}

// ============================================================
// Inline suggestion row — shows top suggestions and one-click match
// ============================================================
function SuggestionRow({ tx, onMatch }: { tx: BankTx; onMatch: (t: BankTx) => void }) {
  const { toast } = useToast();
  const { data: suggestions = [], isLoading } = useQuery<Suggestion[]>({
    queryKey: ["/api/bank-transactions", tx.id, "suggestions"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/bank-transactions/${tx.id}/suggestions`);
      return r.json();
    },
  });

  const matchMut = useMutation({
    mutationFn: async (s: Suggestion) => {
      const body: any = { matchType: s.kind === "invoice" ? "invoice_payment" : "bill_payment" };
      if (s.kind === "invoice") body.invoiceId = s.id;
      else body.billId = s.id;
      const r = await apiRequest("POST", `/api/bank-transactions/${tx.id}/match`, body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      toast({ title: "Matched" });
    },
    onError: (e: any) =>
      toast({ title: "Match failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || suggestions.length === 0) return null;
  const top = suggestions.slice(0, 2);

  return (
    <tr className="border-b border-border last:border-0 bg-muted/30">
      <td colSpan={6} className="px-4 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-primary" />
            Suggested:
          </span>
          {top.map((s) => (
            <button
              key={`${s.kind}-${s.id}`}
              type="button"
              onClick={() => matchMut.mutate(s)}
              disabled={matchMut.isPending}
              data-testid={`button-suggest-match-${tx.id}-${s.kind}-${s.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs hover-elevate active-elevate-2"
            >
              <Badge variant="outline" className="text-[10px] capitalize">
                {s.kind}
              </Badge>
              <span className="font-medium">{s.number}</span>
              <span className="text-muted-foreground">· {s.partyName}</span>
              <span className="text-muted-foreground tabular-nums">{fmtMoney(s.balance)}</span>
              <span className="text-[10px] text-primary font-medium">
                {Math.round(s.score * 100)}% match
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onMatch(tx)}
            data-testid={`button-suggest-more-${tx.id}`}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            More options
          </button>
        </div>
      </td>
    </tr>
  );
}

// ============================================================
// Manual entry dialog
// ============================================================
function ManualEntryDialog({
  open,
  onClose,
  accounts,
  bankAccountId,
}: {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  bankAccountId: number;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<"deposit" | "withdrawal" | "transfer">("deposit");
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryAccountId, setCategoryAccountId] = useState<number | null>(null);
  const [transferAccountId, setTransferAccountId] = useState<number | null>(null);
  const [dims, setDims] = useState<Dims>(EMPTY_DIMS);

  const incomeAccts = accounts.filter((a) => a.type === "income" || a.type === "equity");
  const expenseAccts = accounts.filter((a) => a.type === "expense");
  const bankAccts = accounts.filter(
    (a) => (a.subtype === "bank" || a.subtype === "credit_card") && a.id !== bankAccountId
  );

  const mut = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a positive amount");
      const signedAmount = kind === "withdrawal" ? -amt : amt;
      const body: any = {
        bankAccountId,
        date,
        description,
        amount: signedAmount,
        kind,
      };
      if (kind === "deposit" || kind === "withdrawal") {
        body.categoryAccountId = categoryAccountId;
      } else {
        body.transferAccountId = transferAccountId;
      }
      if (dims.classId != null) body.classId = dims.classId;
      if (dims.locationId != null) body.locationId = dims.locationId;
      if (dims.projectId != null) body.projectId = dims.projectId;
      const r = await apiRequest("POST", "/api/bank-transactions/manual", body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/trial-balance"] });
      toast({ title: "Transaction posted" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const KindButton = ({
    value,
    icon: Icon,
    label,
  }: {
    value: typeof kind;
    icon: typeof ArrowDownToLine;
    label: string;
  }) => (
    <button
      type="button"
      onClick={() => setKind(value)}
      data-testid={`button-kind-${value}`}
      className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm hover-elevate active-elevate-2 ${
        kind === value
          ? "border-primary bg-primary/5 font-medium text-foreground"
          : "border-border text-muted-foreground"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New bank transaction</DialogTitle>
          <DialogDescription>
            Records a journal entry on your books and a matched bank line.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <KindButton value="deposit" icon={ArrowDownToLine} label="Deposit" />
            <KindButton value="withdrawal" icon={ArrowUpFromLine} label="Withdrawal" />
            <KindButton value="transfer" icon={ArrowLeftRight} label="Transfer" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="input-date"
              />
            </div>
            <div>
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-amount"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="desc">Description</Label>
            <Input
              id="desc"
              placeholder={
                kind === "deposit"
                  ? "e.g. Customer payment, owner contribution"
                  : kind === "withdrawal"
                    ? "e.g. ATM withdrawal, bank fee"
                    : "e.g. Transfer to savings"
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="input-description"
            />
          </div>

          {kind === "deposit" && (
            <div>
              <Label>Source (income / equity account)</Label>
              <Select
                value={categoryAccountId?.toString() || ""}
                onValueChange={(v) => setCategoryAccountId(Number(v))}
              >
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder="Where did the money come from?" />
                </SelectTrigger>
                <SelectContent>
                  {incomeAccts.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === "withdrawal" && (
            <div>
              <Label>Category (expense account)</Label>
              <Select
                value={categoryAccountId?.toString() || ""}
                onValueChange={(v) => setCategoryAccountId(Number(v))}
              >
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder="What was this spent on?" />
                </SelectTrigger>
                <SelectContent>
                  {expenseAccts.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === "transfer" && (
            <div>
              <Label>Other account</Label>
              <Select
                value={transferAccountId?.toString() || ""}
                onValueChange={(v) => setTransferAccountId(Number(v))}
              >
                <SelectTrigger data-testid="select-transfer">
                  <SelectValue placeholder="Transfer to / from which account?" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccts.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1.5">
                Positive amount = money in. Negative not allowed here — switch to Withdrawal.
              </p>
            </div>
          )}

          {/* Class / Location / Project — only the dimensions the org tracks. */}
          <DimensionSelects dims={dims} onChange={setDims} testPrefix="select-manual-dim" />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !description || !amount}
            data-testid="button-post"
          >
            {mut.isPending ? "Posting..." : "Post transaction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CSV Import dialog
// ============================================================
function ImportDialog({
  open,
  onClose,
  bankAccountId,
}: {
  open: boolean;
  onClose: () => void;
  bankAccountId: number;
}) {
  const { toast } = useToast();
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<
    Array<{ date: string; description: string; amount: number; externalId?: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  function handlePreview(text: string) {
    setCsvText(text);
    setError(null);
    try {
      const rows = parseCSV(text);
      if (rows.length < 1) {
        setError("No rows found");
        setPreview([]);
        return;
      }
      // Try to detect header
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const dateIdx = header.findIndex((h) => h.includes("date"));
      const descIdx = header.findIndex((h) => h.includes("desc") || h.includes("memo") || h.includes("payee"));
      const amtIdx = header.findIndex((h) => h.includes("amount") || h === "amt");
      const debIdx = header.findIndex((h) => h.includes("debit") || h.includes("withdraw"));
      const credIdx = header.findIndex((h) => h.includes("credit") || h.includes("deposit"));
      const idIdx = header.findIndex((h) => h.includes("id") || h.includes("ref"));

      const hasHeader = dateIdx !== -1 && (amtIdx !== -1 || (debIdx !== -1 && credIdx !== -1));
      const dataRows = hasHeader ? rows.slice(1) : rows;

      // Fallback: assume order date, description, amount
      const out: Array<{ date: string; description: string; amount: number; externalId?: string }> = [];
      for (const r of dataRows) {
        const rawDate = (hasHeader && dateIdx !== -1 ? r[dateIdx] : r[0]) || "";
        const rawDesc = (hasHeader && descIdx !== -1 ? r[descIdx] : r[1]) || "";
        let amount = 0;
        if (hasHeader && amtIdx !== -1) {
          amount = parseFloat((r[amtIdx] || "0").replace(/[$,]/g, ""));
        } else if (hasHeader && (debIdx !== -1 || credIdx !== -1)) {
          const deb = parseFloat((r[debIdx] || "0").replace(/[$,]/g, "")) || 0;
          const cred = parseFloat((r[credIdx] || "0").replace(/[$,]/g, "")) || 0;
          amount = cred - deb; // credit (deposit) positive, debit (withdrawal) negative
        } else {
          amount = parseFloat(((r[2] || "0") + "").replace(/[$,]/g, ""));
        }
        const externalId = hasHeader && idIdx !== -1 ? r[idIdx] : undefined;
        const date = normalizeDate(rawDate.trim());
        if (!date || isNaN(amount)) continue;
        out.push({
          date,
          description: rawDesc.trim() || "(no description)",
          amount,
          externalId: externalId?.trim() || undefined,
        });
      }
      setPreview(out);
      if (out.length === 0) setError("Could not parse any rows. Expected columns like Date, Description, Amount.");
    } catch (e: any) {
      setError(e.message);
      setPreview([]);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handlePreview(reader.result as string);
    reader.readAsText(file);
  }

  const importMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/bank-transactions/import", {
        bankAccountId,
        source: "csv",
        transactions: preview,
      });
      return r.json();
    },
    onSuccess: (data: { inserted: number; skipped: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      toast({
        title: "Import complete",
        description: `Imported ${data.inserted} transactions, skipped ${data.skipped} duplicates.`,
      });
      onClose();
    },
    onError: (e: any) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import bank transactions from CSV</DialogTitle>
          <DialogDescription>
            Expected columns: Date, Description, Amount. Or Date, Description, Debit, Credit. Imported as
            "unmatched" — review and post each row from the For Review tab.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Input type="file" accept=".csv,text/csv" onChange={onFile} data-testid="input-csv-file" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const sample = `Date,Description,Amount\n2026-04-01,Acme Corp wire,6489.00\n2026-04-03,WeWork rent April,-2500.00\n2026-04-05,AWS hosting,-480.00\n2026-04-10,Globex partial payment,500.00\n2026-04-15,Bank fee,-12.50`;
                handlePreview(sample);
              }}
              data-testid="button-sample-csv"
            >
              Use sample
            </Button>
          </div>

          <div>
            <Label>Or paste CSV</Label>
            <Textarea
              rows={6}
              placeholder="Date,Description,Amount&#10;2026-04-01,Customer payment,1500.00"
              value={csvText}
              onChange={(e) => handlePreview(e.target.value)}
              className="font-mono text-xs"
              data-testid="textarea-csv"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {preview.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                Preview ({preview.length} rows)
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.date}</td>
                        <td className="px-3 py-2">{r.description}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-medium ${
                            r.amount > 0 ? "text-primary" : "text-foreground"
                          }`}
                        >
                          {r.amount > 0 ? "+" : ""}
                          {fmtMoney(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-import">
            Cancel
          </Button>
          <Button
            onClick={() => importMut.mutate()}
            disabled={importMut.isPending || preview.length === 0}
            data-testid="button-import"
          >
            {importMut.isPending ? "Importing..." : `Import ${preview.length} transactions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function normalizeDate(s: string): string | null {
  if (!s) return null;
  // ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

// ============================================================
// Match dialog
// ============================================================
function MatchDialog({
  tx,
  accounts,
  onClose,
}: {
  tx: BankTx;
  accounts: Account[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [matchType, setMatchType] = useState<"invoice_payment" | "bill_payment" | "categorize" | "transfer" | "ignore">(
    tx.amount > 0 ? "invoice_payment" : "bill_payment"
  );
  const [selectedSuggestion, setSelectedSuggestion] = useState<Suggestion | null>(null);
  const [categoryAccountId, setCategoryAccountId] = useState<number | null>(null);
  const [transferAccountId, setTransferAccountId] = useState<number | null>(null);
  const [payeeVendorId, setPayeeVendorId] = useState<number | null>(tx.vendorId ?? null);
  const [dims, setDims] = useState<Dims>(EMPTY_DIMS);

  const { data: vendors = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/vendors"] });

  const { data: suggestions = [] } = useQuery<Suggestion[]>({
    queryKey: ["/api/bank-transactions", tx.id, "suggestions"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/bank-transactions/${tx.id}/suggestions`);
      return r.json();
    },
  });

  const incomeAccts = accounts.filter((a) => a.type === "income" || a.type === "equity");
  const expenseAccts = accounts.filter((a) => a.type === "expense");
  const bankAccts = accounts.filter(
    (a) => (a.subtype === "bank" || a.subtype === "credit_card") && a.id !== tx.bankAccountId
  );

  const mut = useMutation({
    mutationFn: async () => {
      const body: any = { matchType };
      if (matchType === "invoice_payment") body.invoiceId = selectedSuggestion?.id;
      if (matchType === "bill_payment") body.billId = selectedSuggestion?.id;
      if (matchType === "categorize") {
        body.categoryAccountId = categoryAccountId;
        if (payeeVendorId) body.vendorId = payeeVendorId;
      }
      if (matchType === "transfer") body.transferAccountId = transferAccountId;
      // Dimensions apply to the categorize + transfer flows (the two that post
      // a fresh journal entry we control the lines of).
      if (matchType === "categorize" || matchType === "transfer") {
        if (dims.classId != null) body.classId = dims.classId;
        if (dims.locationId != null) body.locationId = dims.locationId;
        if (dims.projectId != null) body.projectId = dims.projectId;
      }
      const r = await apiRequest("POST", `/api/bank-transactions/${tx.id}/match`, body);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/trial-balance"] });
      toast({ title: "Transaction matched" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Match failed", description: e.message, variant: "destructive" }),
  });

  const isIn = tx.amount > 0;

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Match transaction</DialogTitle>
          <DialogDescription>
            <span className="block text-foreground font-medium mt-1">{tx.description}</span>
            <span className="text-muted-foreground">
              {fmtDate(tx.date)} · {isIn ? "+" : ""}
              {fmtMoney(tx.amount)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Match type pills */}
          <div className="flex flex-wrap gap-2">
            {isIn && (
              <MatchPill active={matchType === "invoice_payment"} onClick={() => setMatchType("invoice_payment")} testId="pill-invoice">
                Invoice payment
              </MatchPill>
            )}
            {!isIn && (
              <MatchPill active={matchType === "bill_payment"} onClick={() => setMatchType("bill_payment")} testId="pill-bill">
                Bill payment
              </MatchPill>
            )}
            <MatchPill active={matchType === "categorize"} onClick={() => setMatchType("categorize")} testId="pill-categorize">
              Categorize
            </MatchPill>
            <MatchPill active={matchType === "transfer"} onClick={() => setMatchType("transfer")} testId="pill-transfer">
              Transfer
            </MatchPill>
            <MatchPill active={matchType === "ignore"} onClick={() => setMatchType("ignore")} testId="pill-ignore">
              Ignore
            </MatchPill>
          </div>

          {/* Suggestions */}
          {(matchType === "invoice_payment" || matchType === "bill_payment") && (
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Suggested matches
              </Label>
              {suggestions.length === 0 ? (
                <div className="mt-2 px-3 py-6 rounded-md border border-dashed border-border text-center text-sm text-muted-foreground">
                  No open {isIn ? "invoices" : "bills"} match this transaction.
                </div>
              ) : (
                <div className="mt-2 space-y-1.5 max-h-56 overflow-y-auto">
                  {suggestions.map((s) => (
                    <button
                      key={`${s.kind}-${s.id}`}
                      onClick={() => setSelectedSuggestion(s)}
                      data-testid={`suggestion-${s.kind}-${s.id}`}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-md border text-sm hover-elevate active-elevate-2 ${
                        selectedSuggestion?.id === s.id && selectedSuggestion?.kind === s.kind
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2
                          className={`h-4 w-4 ${
                            selectedSuggestion?.id === s.id && selectedSuggestion?.kind === s.kind
                              ? "text-primary"
                              : "text-muted-foreground"
                          }`}
                        />
                        <div className="text-left">
                          <div className="font-medium">{s.number} · {s.partyName}</div>
                          <div className="text-xs text-muted-foreground">
                            {fmtDate(s.date)} · balance {fmtMoney(s.balance)}
                          </div>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {s.score >= 70 ? "Strong" : s.score >= 50 ? "Likely" : "Possible"}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {matchType === "categorize" && (
            <div>
              <Label>Account to post against</Label>
              <Select
                value={categoryAccountId?.toString() || ""}
                onValueChange={(v) => setCategoryAccountId(Number(v))}
              >
                <SelectTrigger data-testid="select-categorize">
                  <SelectValue placeholder={isIn ? "Choose an income account" : "Choose an expense account"} />
                </SelectTrigger>
                <SelectContent>
                  {(isIn ? incomeAccts : expenseAccts).map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {vendors.length > 0 && (
                <div className="mt-3">
                  <Label>Payee (vendor) <span className="text-muted-foreground font-normal">— optional</span></Label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    data-testid="select-categorize-payee"
                    value={payeeVendorId?.toString() ?? ""}
                    onChange={(e) => setPayeeVendorId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">— None —</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              )}
              {/* Class / Location / Project — only the dimensions the org tracks. */}
              <div className="mt-3">
                <DimensionSelects dims={dims} onChange={setDims} testPrefix="select-categorize-dim" />
              </div>
            </div>
          )}

          {matchType === "transfer" && (
            <div>
              <Label>Other account</Label>
              <Select
                value={transferAccountId?.toString() || ""}
                onValueChange={(v) => setTransferAccountId(Number(v))}
              >
                <SelectTrigger data-testid="select-transfer-match">
                  <SelectValue placeholder="Pick the other bank/credit card account" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccts.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Class / Location / Project — only the dimensions the org tracks. */}
              <div className="mt-3">
                <DimensionSelects dims={dims} onChange={setDims} testPrefix="select-transfer-dim" />
              </div>
            </div>
          )}

          {matchType === "ignore" && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-border bg-muted/30 text-sm">
              <XCircle className="h-4 w-4 text-muted-foreground mt-0.5" />
              <span>This transaction will be marked as ignored — no journal entry will be posted.</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-match">
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={
              mut.isPending ||
              ((matchType === "invoice_payment" || matchType === "bill_payment") && !selectedSuggestion) ||
              (matchType === "categorize" && !categoryAccountId) ||
              (matchType === "transfer" && !transferAccountId)
            }
            data-testid="button-confirm-match"
          >
            {mut.isPending ? "Matching..." : "Confirm match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MatchPill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`px-3 py-1.5 rounded-md border text-sm hover-elevate active-elevate-2 ${
        active ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}


// ----------------------------------------------------------------------------
// Plaid Link flow: link-token → Plaid Link UI → exchange public_token →
// immediate first sync. Transactions land in the currently selected bank
// account (subtype must be "bank"), matching the backend /api/plaid/exchange
// contract.
// ----------------------------------------------------------------------------
function PlaidConnectButton({
  configured,
  activeBankId,
  activeBankName,
}: {
  configured: boolean;
  activeBankId: number | null;
  activeBankName?: string;
}) {
  const { toast } = useToast();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        setBusy(true);
        const r = await apiRequest("POST", "/api/plaid/exchange", {
          public_token: publicToken,
          bankAccountId: activeBankId,
          institutionName: metadata?.institution?.name,
          // The account the user selected in Link — pins the feed-balance lookup.
          plaidAccountId: metadata?.accounts?.[0]?.id,
        });
        const { plaidItemId } = await r.json();
        toast({
          title: "Bank connected",
          description: `${metadata?.institution?.name || "Bank"} linked to ${activeBankName || "your account"}. Syncing transactions…`,
        });
        // Kick off the first sync right away
        const syncRes = await apiRequest("POST", `/api/plaid/items/${plaidItemId}/sync`);
        const sync = await syncRes.json();
        toast({
          title: "Sync complete",
          description: `${sync.added} imported, ${sync.autoMatched} auto-matched, ${sync.skipped} duplicates skipped.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/bank-transactions", { bankAccountId: activeBankId }] });
      } catch (e: any) {
        toast({ title: "Bank connection failed", description: e.message, variant: "destructive" });
      } finally {
        setBusy(false);
        setLinkToken(null);
      }
    },
    onExit: () => setLinkToken(null),
  });

  // Open Link as soon as the token arrives and the SDK is ready
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function startLink() {
    if (!activeBankId) {
      toast({
        title: "Pick a bank account first",
        description: "Select which chart-of-accounts bank account the imported transactions should belong to.",
        variant: "destructive",
      });
      return;
    }
    try {
      setBusy(true);
      const r = await apiRequest("POST", "/api/plaid/link-token");
      const { link_token } = await r.json();
      setLinkToken(link_token); // Link opens via the effect above
    } catch (e: any) {
      toast({ title: "Could not start Plaid Link", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2 w-full"
      disabled={!configured || busy}
      data-testid="button-plaid-connect"
      onClick={startLink}
    >
      {!configured ? "Plaid not configured" : busy ? "Connecting…" : "Connect with Plaid"}
    </Button>
  );
}
