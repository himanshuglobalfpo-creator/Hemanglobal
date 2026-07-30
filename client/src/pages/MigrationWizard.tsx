// ============================================================================
// GUIDED MIGRATION WIZARD — /settings/import (QBO/Xero switcher path)
// ============================================================================
// Four steps: upload files → auto-detect source + map columns → dry-run report
// (downloadable) → commit one file at a time with progress. Everything talks to
// /api/migration/*: analyze (detect + suggest mapping) and import (?dryRun for
// the preview, then the real commit). A commit into an org that already has
// posted transactions is gated behind typing the org name to confirm.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, CheckCircle2, AlertTriangle, Download, ArrowRight, ArrowLeft, Loader2, FileSpreadsheet } from "lucide-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { readCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type EntityKind = "accounts" | "customers" | "vendors" | "items" | "invoices" | "bills" | "trial_balance";
type Source = "qbo" | "xero" | "generic";
type FieldSpec = { field: string; required: boolean };
type Analysis = {
  source: Source; entity: EntityKind; headers: string[];
  mapping: Record<string, string>; unmapped: string[]; rowCount: number;
  sampleRows: Record<string, string>[]; entityOptions: EntityKind[]; canonicalFields: FieldSpec[];
};
type ImportReport = {
  inserted: number; skipped: number; updated?: number;
  errors: Array<{ row: number; message: string }>;
  rows?: Array<{ row: number; status: string; message?: string; key?: string }>;
  dryRun?: boolean;
};
type FileState = {
  id: string; name: string; csv: string; analysis: Analysis;
  entity: EntityKind; source: Source; mapping: Record<string, string>;
  conversionDate: string; canonicalFields: FieldSpec[];
  dry?: ImportReport; commit?: ImportReport; busy?: boolean;
};

const ENTITY_LABELS: Record<EntityKind, string> = {
  accounts: "Chart of Accounts", customers: "Customers", vendors: "Vendors",
  items: "Products & Services", invoices: "Open Invoices", bills: "Open Bills",
  trial_balance: "Trial Balance (opening balances)",
};
const SOURCE_LABELS: Record<Source, string> = { qbo: "QuickBooks Online", xero: "Xero", generic: "Generic CSV" };
// Import order so dependencies resolve: accounts → parties/items → docs → opening balances.
const ORDER: EntityKind[] = ["accounts", "customers", "vendors", "items", "invoices", "bills", "trial_balance"];

async function postJson(url: string, body: unknown): Promise<any> {
  const csrf = readCsrfToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

function reportToCsv(name: string, r: ImportReport): string {
  const rows = [["row", "status", "message"]];
  (r.rows ?? []).forEach((x) => rows.push([String(x.row), x.status, x.message ?? ""]));
  r.errors.forEach((e) => rows.push([String(e.row), "error", e.message]));
  if (rows.length === 1) rows.push(["", "summary", `${r.inserted} to import, ${r.skipped} skipped, ${r.errors.length} errors`]);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((line) => line.map(esc).join(",")).join("\n");
}
function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const rid = () => Math.random().toString(36).slice(2, 9);

export default function MigrationWizard() {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [files, setFiles] = useState<FileState[]>([]);
  const [confirmName, setConfirmName] = useState("");

  const { data: summary } = useQuery<{ orgName: string; hasTransactions: boolean; journalEntryCount: number }>({
    queryKey: ["/api/migration/summary"],
    queryFn: () => fetch("/api/migration/summary").then((r) => r.json()),
  });

  const ordered = useMemo(
    () => [...files].sort((a, b) => ORDER.indexOf(a.entity) - ORDER.indexOf(b.entity)),
    [files]
  );

  const analyzeMut = useMutation({
    mutationFn: async (list: FileList) => {
      const out: FileState[] = [];
      for (const f of Array.from(list)) {
        const csv = await f.text();
        const analysis: Analysis = await postJson("/api/migration/analyze", { csv });
        out.push({
          id: rid(), name: f.name, csv, analysis,
          entity: analysis.entity, source: analysis.source, mapping: { ...analysis.mapping },
          conversionDate: "", canonicalFields: analysis.canonicalFields,
        });
      }
      return out;
    },
    onSuccess: (out) => { setFiles((prev) => [...prev, ...out]); setStep(2); },
    onError: (e: any) => toast({ title: "Could not read file", description: e.message, variant: "destructive" }),
  });

  // Changing the entity re-detects the mapping for that entity from the server.
  async function changeEntity(id: string, entity: EntityKind) {
    const file = files.find((f) => f.id === id);
    if (!file) return;
    const analysis: Analysis = await postJson("/api/migration/analyze", { csv: file.csv, entity });
    setFiles((prev) => prev.map((f) => f.id === id
      ? { ...f, entity, mapping: { ...analysis.mapping }, canonicalFields: analysis.canonicalFields, analysis: { ...f.analysis, ...analysis }, dry: undefined }
      : f));
  }
  const setMapping = (id: string, field: string, header: string) =>
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, mapping: { ...f.mapping, [field]: header }, dry: undefined } : f));
  const setSource = (id: string, source: Source) =>
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, source } : f));
  const setConversion = (id: string, conversionDate: string) =>
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, conversionDate } : f));
  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  async function runOne(file: FileState, dryRun: boolean): Promise<ImportReport> {
    return postJson(`/api/migration/import?dryRun=${dryRun}`, {
      entity: file.entity, source: file.source, mapping: file.mapping, csv: file.csv,
      conversionDate: file.conversionDate || undefined,
      partial: false,
      confirmOrgName: dryRun ? undefined : confirmName,
    });
  }

  const dryRunMut = useMutation({
    mutationFn: async () => {
      for (const f of ordered) {
        setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, busy: true } : x));
        try {
          const rep = await runOne(f, true);
          setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, dry: rep, busy: false } : x));
        } catch (e: any) {
          setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, dry: { inserted: 0, skipped: 0, errors: [{ row: 0, message: e.message }] }, busy: false } : x));
        }
      }
    },
    onSuccess: () => setStep(3),
  });

  const missingRequired = (f: FileState) => f.canonicalFields.filter((c) => c.required && !f.mapping[c.field]).map((c) => c.field);
  const needsDate = (f: FileState) => f.entity === "trial_balance" && !f.conversionDate;
  const readyToPreview = files.length > 0 && files.every((f) => missingRequired(f).length === 0 && !needsDate(f));

  const dryHasErrors = ordered.some((f) => f.dry && f.dry.errors.length > 0);
  const guardActive = !!summary?.hasTransactions;
  const confirmOk = !guardActive || confirmName.trim() === summary?.orgName;

  const commitMut = useMutation({
    mutationFn: async () => {
      for (const f of ordered) {
        setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, busy: true } : x));
        try {
          const rep = await runOne(f, false);
          setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, commit: rep, busy: false } : x));
        } catch (e: any) {
          setFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, commit: { inserted: 0, skipped: 0, errors: [{ row: 0, message: e.message }] }, busy: false } : x));
          throw e;
        }
      }
    },
    onSuccess: () => { queryClient.invalidateQueries(); setStep(4); toast({ title: "Migration complete", description: "Data imported. Review your Trial Balance to confirm." }); },
    onError: (e: any) => toast({ title: "Import stopped", description: e.message, variant: "destructive" }),
  });

  return (
    <Layout>
      <PageHeader title="Migrate from QuickBooks or Xero" description="Bring your Chart of Accounts, contacts, catalog, open documents and opening balances across in one guided pass." />
      <div className="mx-auto max-w-4xl space-y-4 p-1">
        <Stepper step={step} />

        {step === 1 && (
          <Card data-testid="card-migrate-upload">
            <CardHeader><CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Upload your export files</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Export the standard bundle from your old system — Chart of Accounts, Customers, Vendors, Products/Services, open Invoices, open Bills and the Trial Balance — and drop the CSV files here. We auto-detect QuickBooks Online vs Xero from the column headers.
              </p>
              <Input type="file" accept=".csv,text/csv" multiple data-testid="input-migrate-files"
                onChange={(e) => { if (e.target.files?.length) analyzeMut.mutate(e.target.files); }} />
              {analyzeMut.isPending && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Detecting sources…</div>}
              {files.length > 0 && (
                <div className="space-y-1">
                  {files.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 text-sm" data-testid={`file-row-${f.entity}`}>
                      <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{f.name}</span>
                      <Badge variant="secondary">{SOURCE_LABELS[f.source]}</Badge>
                      <span className="text-muted-foreground">→ {ENTITY_LABELS[f.entity]} · {f.analysis.rowCount} rows</span>
                      <button className="ml-auto text-xs text-muted-foreground hover:text-destructive" onClick={() => removeFile(f.id)}>Remove</button>
                    </div>
                  ))}
                  <div className="pt-2"><Button onClick={() => setStep(2)} data-testid="button-to-mapping">Continue to mapping <ArrowRight className="ml-1 h-4 w-4" /></Button></div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {ordered.map((f) => (
              <Card key={f.id} data-testid={`map-card-${f.entity}`}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <FileSpreadsheet className="h-4 w-4" /> {f.name}
                    <Badge variant="secondary">{SOURCE_LABELS[f.source]}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <Label className="text-xs">This file is</Label>
                      <select className="block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid={`select-entity-${f.entity}`}
                        value={f.entity} onChange={(e) => changeEntity(f.id, e.target.value as EntityKind)}>
                        {f.analysis.entityOptions.map((o) => <option key={o} value={o}>{ENTITY_LABELS[o]}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Source</Label>
                      <select className="block rounded-md border bg-background px-2 py-1.5 text-sm"
                        value={f.source} onChange={(e) => setSource(f.id, e.target.value as Source)}>
                        {(["qbo", "xero", "generic"] as Source[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
                      </select>
                    </div>
                    {f.entity === "trial_balance" && (
                      <div>
                        <Label className="text-xs">Conversion date</Label>
                        <Input type="date" className="w-40" data-testid={`input-conversion-${f.id}`} value={f.conversionDate} onChange={(e) => setConversion(f.id, e.target.value)} />
                      </div>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-1 pr-4">Our field</th><th className="py-1">Your column</th></tr></thead>
                      <tbody>
                        {f.canonicalFields.map((cf) => (
                          <tr key={cf.field} className="border-b/50">
                            <td className="py-1 pr-4">
                              <span className="font-mono text-xs">{cf.field}</span>
                              {cf.required && <span className="ml-1 text-destructive">*</span>}
                            </td>
                            <td className="py-1">
                              <select className={`w-full max-w-xs rounded-md border bg-background px-2 py-1 text-sm ${cf.required && !f.mapping[cf.field] ? "border-destructive" : ""}`}
                                data-testid={`map-${f.entity}-${cf.field}`}
                                value={f.mapping[cf.field] ?? ""} onChange={(e) => setMapping(f.id, cf.field, e.target.value)}>
                                <option value="">— not mapped —</option>
                                {f.analysis.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {missingRequired(f).length > 0 && (
                    <div className="flex items-center gap-2 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Map required columns: {missingRequired(f).join(", ")}</div>
                  )}
                </CardContent>
              </Card>
            ))}
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
              <Button disabled={!readyToPreview || dryRunMut.isPending} onClick={() => dryRunMut.mutate()} data-testid="button-run-dryrun">
                {dryRunMut.isPending ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Checking…</> : <>Preview (dry run) <ArrowRight className="ml-1 h-4 w-4" /></>}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {ordered.map((f) => {
              const r = f.dry;
              const err = r && r.errors.length > 0;
              return (
                <Card key={f.id} data-testid={`review-card-${f.entity}`}>
                  <CardContent className="space-y-2 pt-4">
                    <div className="flex items-center gap-2">
                      {err ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      <span className="font-medium">{ENTITY_LABELS[f.entity]}</span>
                      <span className="text-sm text-muted-foreground">
                        {r ? `${r.inserted} to import · ${r.skipped} skipped · ${r.errors.length} error(s)` : "—"}
                      </span>
                      {r && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => download(`${f.entity}-dryrun.csv`, reportToCsv(f.name, r))}><Download className="mr-1 h-3.5 w-3.5" /> Report</Button>}
                    </div>
                    {err && (
                      <ul className="space-y-0.5 text-xs text-amber-700">
                        {r!.errors.slice(0, 15).map((e, i) => <li key={i} data-testid={`review-error-${f.entity}-${i}`}>Row {e.row}: {e.message}</li>)}
                        {r!.errors.length > 15 && <li>…and {r!.errors.length - 15} more</li>}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              );
            })}

            {guardActive && (
              <Card className="border-amber-300" data-testid="card-guard">
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-800"><AlertTriangle className="h-4 w-4" /> This organization already has {summary?.journalEntryCount} posted transaction(s).</div>
                  <p className="text-xs text-muted-foreground">Importing on top of existing data can create duplicates. To confirm, type the organization name <span className="font-mono">{summary?.orgName}</span> below.</p>
                  <Input placeholder={summary?.orgName} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="max-w-sm" data-testid="input-confirm-org" />
                </CardContent>
              </Card>
            )}

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft className="mr-1 h-4 w-4" /> Back to mapping</Button>
              <Button disabled={dryHasErrors || !confirmOk || commitMut.isPending} onClick={() => commitMut.mutate()} data-testid="button-commit">
                {commitMut.isPending ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Importing…</> : "Import all files"}
              </Button>
              {dryHasErrors && <span className="text-xs text-muted-foreground">Fix the errors above before importing.</span>}
            </div>
          </div>
        )}

        {step === 4 && (
          <Card data-testid="card-done">
            <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-600" /> Migration complete</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {ordered.map((f) => (
                <div key={f.id} className="flex items-center gap-2 text-sm" data-testid={`done-row-${f.entity}`}>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="font-medium">{ENTITY_LABELS[f.entity]}</span>
                  <span className="text-muted-foreground">{f.commit ? `${f.commit.inserted} imported · ${f.commit.skipped} skipped` : "—"}</span>
                </div>
              ))}
              <p className="pt-2 text-sm text-muted-foreground">Open your <a className="underline" href="/reports">Trial Balance report</a> to confirm the opening balances match your prior system to the cent.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Upload", "Map columns", "Review", "Done"];
  return (
    <div className="flex items-center gap-2 text-sm">
      {labels.map((l, i) => {
        const n = i + 1;
        return (
          <div key={l} className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${n <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{n}</span>
            <span className={n === step ? "font-medium" : "text-muted-foreground"}>{l}</span>
            {n < labels.length && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
        );
      })}
    </div>
  );
}
