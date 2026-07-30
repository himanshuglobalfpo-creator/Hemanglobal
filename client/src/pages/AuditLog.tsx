import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";

type AuditEntry = {
  id: number;
  ts: string;
  user: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  metadata: string | null;
};

const ENTITY_TYPES = [
  "invoice",
  "bill",
  "payment",
  "customer",
  "vendor",
  "account",
  "journal",
  "bank_transaction",
  "reconciliation",
  "tax_code",
  "period_lock",
  "year_end",
];

const ACTIONS = ["create", "update", "delete", "pay", "void", "match", "send", "close", "reopen"];

const actionColor: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  update: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  delete: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  pay: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  void: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  match: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  send: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  close: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  reopen: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

export default function AuditLog() {
  const [entityType, setEntityType] = useState<string>("all");
  const [action, setAction] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const params = new URLSearchParams();
  if (entityType !== "all") params.set("entityType", entityType);
  if (action !== "all") params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("limit", "200");

  const { data: entries = [] } = useQuery<AuditEntry[]>({
    queryKey: ["/api/audit", params.toString()],
    queryFn: async () => {
      // Paginated endpoint (Task 1): unwrap .rows (limit=200 is set above).
      const r = await apiRequest("GET", `/api/audit?${params.toString()}`);
      const body = await r.json();
      return Array.isArray(body) ? body : body.rows ?? [];
    },
  });

  const exportCsv = () => {
    window.location.href = `/api/audit?${params.toString()}&format=csv`;
  };

  const clearFilters = () => {
    setEntityType("all");
    setAction("all");
    setFrom("");
    setTo("");
  };
  const hasFilters = entityType !== "all" || action !== "all" || from || to;

  return (
    <Layout>
      <PageHeader
        title="Audit Log"
        description="Every change to your books, captured automatically"
      />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Entity</Label>
            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger className="w-44" data-testid="select-filter-entity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger className="w-36" data-testid="select-filter-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
              data-testid="input-filter-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
              data-testid="input-filter-to"
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="button-clear-filters"
            >
              <X className="h-4 w-4 mr-1.5" />
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">Time</TableHead>
                <TableHead className="w-28">Action</TableHead>
                <TableHead className="w-32">Entity</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-28">Actor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No audit entries match these filters.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => (
                <TableRow key={e.id} data-testid={`row-audit-${e.id}`}>
                  <TableCell className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                    {e.ts?.replace("T", " ").slice(0, 19)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={actionColor[e.action] || ""}
                    >
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="font-medium">{e.entityType.replace(/_/g, " ")}</span>
                    {e.entityId !== null && (
                      <span className="text-muted-foreground"> #{e.entityId}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{e.summary}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {e.user || "system"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Layout>
  );
}
