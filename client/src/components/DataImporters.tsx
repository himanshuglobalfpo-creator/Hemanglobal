// ============================================================================
// DATA IMPORTERS (Settings) — CSV upload → dry-run preview → commit
// ============================================================================
// Wraps the five POST /api/import/* endpoints. Each importer runs a dry-run
// first (?dryRun=true) so the user sees inserted/skipped counts and any
// per-row errors before committing. Endpoints accept a raw text/csv body, so
// this posts directly with fetch + the CSRF header (apiRequest sends JSON).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type ImportKind = "customers" | "vendors" | "chart-of-accounts" | "invoices" | "opening-balances";
type ImportResult = { inserted: number; skipped: number; errors: Array<{ row: number; message: string }>; dryRun?: boolean };

const KINDS: Array<{ value: ImportKind; label: string; sample: string; needsAsOf?: boolean }> = [
  { value: "customers", label: "Customers", sample: "name,email,phone\nAcme Co,ap@acme.test,555-0100" },
  { value: "vendors", label: "Vendors", sample: "name,email,phone\nSupplier Inc,billing@supplier.test,555-0111" },
  { value: "chart-of-accounts", label: "Chart of accounts", sample: "code,name,type,subtype\n4100,Consulting Income,income,operating_income" },
  { value: "invoices", label: "Invoices", sample: "number,customer,date,dueDate,description,quantity,rate,account\nINV-9001,Acme Co,2026-07-01,2026-07-31,Work,1,500,4000" },
  { value: "opening-balances", label: "Opening balances", sample: "code,debit,credit\n1000,10000,0\n3000,0,10000", needsAsOf: true },
];

async function postCsv(kind: ImportKind, csv: string, opts: { dryRun: boolean; asOfDate?: string }): Promise<ImportResult> {
  const params = new URLSearchParams();
  if (opts.dryRun) params.set("dryRun", "true");
  if (opts.asOfDate) params.set("asOfDate", opts.asOfDate);
  const qs = params.toString();
  const csrf = readCsrfToken();
  const res = await fetch(`/api/import/${kind}${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: csv,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
  return body as ImportResult;
}

export function DataImporters() {
  const { toast } = useToast();
  const [kind, setKind] = useState<ImportKind>("customers");
  const [csv, setCsv] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const spec = KINDS.find((k) => k.value === kind)!;

  const dryRunMut = useMutation({
    mutationFn: () => postCsv(kind, csv, { dryRun: true, asOfDate: spec.needsAsOf ? asOfDate : undefined }),
    onSuccess: (r) => setPreview(r),
    onError: (e: any) => { setPreview(null); toast({ title: "Preview failed", description: e.message, variant: "destructive" }); },
  });
  const commitMut = useMutation({
    mutationFn: () => postCsv(kind, csv, { dryRun: false, asOfDate: spec.needsAsOf ? asOfDate : undefined }),
    onSuccess: (r) => {
      setPreview(null); setCsv("");
      queryClient.invalidateQueries();
      toast({ title: "Import complete", description: `${r.inserted} inserted, ${r.skipped} skipped.` });
    },
    onError: (e: any) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result || "")); setPreview(null); };
    reader.readAsText(file);
  }

  const hasErrors = !!preview && preview.errors.length > 0;

  return (
    <Card data-testid="card-data-import">
      <CardHeader><CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Import data (CSV)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-56">
            <Label>What to import</Label>
            <Select value={kind} onValueChange={(v) => { setKind(v as ImportKind); setPreview(null); }}>
              <SelectTrigger data-testid="select-import-kind"><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {spec.needsAsOf && (
            <div><Label>As-of date</Label><Input type="date" className="w-40" data-testid="input-import-asof" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></div>
          )}
          <div className="flex-1" />
          <div className="self-end">
            <Input type="file" accept=".csv,text/csv" onChange={onFile} data-testid="input-import-file" />
          </div>
          <Button variant="outline" size="sm" className="self-end" onClick={() => { setCsv(spec.sample); setPreview(null); }} data-testid="button-import-sample">Use sample</Button>
        </div>

        <div>
          <Label>CSV</Label>
          <Textarea rows={5} className="font-mono text-xs" data-testid="textarea-import-csv" value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder={spec.sample} />
        </div>

        {preview && (
          <div className={`rounded-md border p-3 text-sm ${hasErrors ? "border-amber-300 bg-amber-50 text-amber-900" : "border-green-300 bg-green-50 text-green-900"}`} data-testid="panel-import-preview">
            <div className="flex items-center gap-2 font-medium">
              {hasErrors ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              Dry run: {preview.inserted} to insert · {preview.skipped} skipped · {preview.errors.length} error(s)
            </div>
            {hasErrors && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {preview.errors.slice(0, 20).map((er, i) => <li key={i} data-testid={`import-error-${i}`}>Row {er.row}: {er.message}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={!csv.trim() || dryRunMut.isPending} onClick={() => dryRunMut.mutate()} data-testid="button-import-preview">
            {dryRunMut.isPending ? "Checking…" : "Preview (dry run)"}
          </Button>
          <Button disabled={!preview || hasErrors || commitMut.isPending} onClick={() => commitMut.mutate()} data-testid="button-import-commit">
            {commitMut.isPending ? "Importing…" : "Import"}
          </Button>
          <span className="text-xs text-muted-foreground">Preview first; import is enabled once a dry run has no errors.</span>
        </div>
      </CardContent>
    </Card>
  );
}
