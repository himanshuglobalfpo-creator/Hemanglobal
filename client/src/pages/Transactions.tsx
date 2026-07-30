// ============================================================================
// ADVANCED TRANSACTIONS SEARCH (QBO-style)
// ============================================================================
// A unified, filterable view over every transaction type (invoice, bill,
// credit note, expense, deposit, journal). Filters: date range, type, reference
// number, contact, and amount comparator — all optional, applied live against
// GET /api/transactions/search.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search, ExternalLink } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { fmtMoney, fmtDate } from "@/lib/format";

type TxnRow = {
  type: string;
  id: number;
  date: string;
  referenceNumber: string | null;
  contactName: string | null;
  amountCents: number;
  memo: string | null;
  url: string;
};

const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice", bill: "Bill", credit_note: "Credit Note",
  expense: "Expense", deposit: "Deposit", journal: "Journal Entry",
};
const AMOUNT_OPS = [
  { value: "any", label: "Any amount" },
  { value: "eq", label: "Equals" },
  { value: "gte", label: "Greater or equal" },
  { value: "lte", label: "Less or equal" },
  { value: "gt", label: "Greater than" },
  { value: "lt", label: "Less than" },
];

function initialQ(): string {
  // The dropdown's "Advanced transactions search" link passes ?q=… in the hash.
  const hash = window.location.hash;
  const qs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(qs).get("q") ?? "";
}

export default function Transactions() {
  const [, navigate] = useLocation();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [type, setType] = useState("all");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [contact, setContact] = useState("");
  const [amountOp, setAmountOp] = useState("any");
  const [amount, setAmount] = useState("");
  const [q, setQ] = useState(initialQ);

  // Build the querystring, omitting every empty/any filter so a blank box is a
  // true no-op on the server.
  const search = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);
    if (type !== "all") p.set("type", type);
    if (referenceNumber.trim()) p.set("referenceNumber", referenceNumber.trim());
    if (contact.trim()) p.set("contact", contact.trim());
    if (amountOp !== "any" && amount.trim() && !isNaN(Number(amount))) {
      p.set("amountOp", amountOp);
      p.set("amount", amount.trim());
    }
    if (q.trim()) p.set("q", q.trim());
    p.set("limit", "100");
    return p.toString();
  }, [dateFrom, dateTo, type, referenceNumber, contact, amountOp, amount, q]);

  const { data, isFetching } = useQuery<{ rows: TxnRow[]; total: number }>({
    queryKey: ["/api/transactions/search", search],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/transactions/search?${search}`);
      return r.json();
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  function reset() {
    setDateFrom(""); setDateTo(""); setType("all"); setReferenceNumber("");
    setContact(""); setAmountOp("any"); setAmount(""); setQ("");
  }

  return (
    <Layout>
      <PageHeader
        title="Advanced transactions search"
        description="Search and filter across every transaction type"
        actions={<Button variant="outline" onClick={reset} data-testid="button-reset-filters">Clear filters</Button>}
      />

      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label>Date range</Label>
              <div className="flex items-center gap-2">
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-date-from" />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="input-date-to" />
              </div>
            </div>
            <div>
              <Label>Transaction type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger data-testid="select-txn-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Reference number</Label>
              <Input placeholder="e.g. INV-1001" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} data-testid="input-reference" />
            </div>
            <div>
              <Label>Contact</Label>
              <Input placeholder="Customer or vendor name" value={contact} onChange={(e) => setContact(e.target.value)} data-testid="input-contact" />
            </div>
            <div>
              <Label>Amount</Label>
              <div className="flex items-center gap-2">
                <Select value={amountOp} onValueChange={setAmountOp}>
                  <SelectTrigger className="w-44" data-testid="select-amount-op"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AMOUNT_OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input
                  type="number" step="0.01" placeholder="0.00" value={amount}
                  disabled={amountOp === "any"} onChange={(e) => setAmount(e.target.value)}
                  data-testid="input-amount"
                />
              </div>
            </div>
            <div>
              <Label>Contains text</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Memo, reference, contact…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="input-q" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-2 text-sm text-muted-foreground" data-testid="text-result-count">
        {isFetching ? "Searching…" : `${total} transaction${total === 1 ? "" : "s"}`}
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">No.</th>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Memo</th>
                <th className="px-4 py-3 font-medium text-right">Amount</th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    {isFetching ? "Searching…" : "No transactions match these filters."}
                  </td>
                </tr>
              )}
              {rows.map((t) => (
                <tr key={`${t.type}-${t.id}`} className="border-b border-border last:border-0 hover-elevate" data-testid={`row-txn-${t.type}-${t.id}`}>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">{fmtDate(t.date)}</td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-xs">{TYPE_LABEL[t.type] ?? t.type}</Badge></td>
                  <td className="px-4 py-3 font-medium">{t.referenceNumber || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3">{t.contactName || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3 text-muted-foreground truncate max-w-xs">{t.memo || ""}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{fmtMoney(t.amountCents)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => navigate(t.url)} data-testid={`button-open-${t.type}-${t.id}`} className="text-muted-foreground hover:text-foreground" title="Open">
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </Layout>
  );
}
