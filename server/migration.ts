// ============================================================================
// MIGRATION ENGINE — QBO/Xero "switcher" path behind the wizard at
// /settings/import.
// ============================================================================
// One import path for QuickBooks Online and Xero exports (and our own generic
// CSVs). The pipeline per file is:
//
//   raw CSV ──parse──▶ detect source (QBO vs Xero vs generic by header
//   signature) ──▶ detect entity ──▶ suggest a column mapping (canonical field
//   ◀ source header) ──▶ apply mapping + value normalization ──▶ re-emit a
//   CANONICAL CSV ──▶ hand to the matching importer in importers.ts.
//
// Re-emitting a canonical CSV means the row-level importers stay source-blind:
// they only ever see our canonical headers. QBO/Xero quirks (asterisked
// required headers, "Detail Type", account-type vocab) are absorbed here.
// ============================================================================

import { parse } from "csv-parse/sync";
import { pool } from "./storage";
import { currentOrgId } from "./org-scope";
import * as importers from "./importers";
import type { ImportReport } from "./importers";

export type Source = "qbo" | "xero" | "generic";
export type EntityKind = "accounts" | "customers" | "vendors" | "items" | "invoices" | "bills" | "trial_balance";

export const ENTITY_LABELS: Record<EntityKind, string> = {
  accounts: "Chart of Accounts",
  customers: "Customers",
  vendors: "Vendors",
  items: "Products & Services",
  invoices: "Open Invoices",
  bills: "Open Bills",
  trial_balance: "Trial Balance (opening balances)",
};

export const SOURCE_LABELS: Record<Source, string> = {
  qbo: "QuickBooks Online",
  xero: "Xero",
  generic: "Generic CSV",
};

// Canonical schema per entity. `field` is exactly what the importer reads;
// `required` drives the mapping screen's "unmapped required column" warning.
type FieldSpec = { field: string; required: boolean };
export const CANONICAL_FIELDS: Record<EntityKind, FieldSpec[]> = {
  accounts: [
    { field: "code", required: true }, { field: "name", required: true },
    { field: "type", required: true }, { field: "subtype", required: false },
  ],
  customers: [
    { field: "name", required: true }, { field: "email", required: false }, { field: "phone", required: false },
    { field: "address", required: false }, { field: "shipping_city", required: false },
    { field: "shipping_state", required: false }, { field: "shipping_zip", required: false },
  ],
  vendors: [
    { field: "name", required: true }, { field: "email", required: false }, { field: "phone", required: false },
    { field: "address", required: false }, { field: "shipping_city", required: false },
    { field: "shipping_state", required: false }, { field: "shipping_zip", required: false },
  ],
  items: [
    { field: "sku", required: false }, { field: "name", required: true }, { field: "type", required: false },
    { field: "income_account_code", required: true }, { field: "expense_account_code", required: false },
    { field: "cogs_account_code", required: false }, { field: "inventory_account_code", required: false },
    { field: "description", required: false },
  ],
  invoices: [
    { field: "number", required: true }, { field: "customer_name", required: true },
    { field: "date", required: true }, { field: "due_date", required: false }, { field: "tax_rate", required: false },
    { field: "line_description", required: true }, { field: "quantity", required: true },
    { field: "rate", required: true }, { field: "income_account_code", required: true },
  ],
  bills: [
    { field: "number", required: true }, { field: "vendor_name", required: true },
    { field: "date", required: true }, { field: "due_date", required: false }, { field: "tax_rate", required: false },
    { field: "line_description", required: true }, { field: "quantity", required: true },
    { field: "rate", required: true }, { field: "expense_account_code", required: true },
  ],
  trial_balance: [
    { field: "account_code", required: false }, { field: "account_name", required: false },
    { field: "debit", required: false }, { field: "credit", required: false },
  ],
};

// Accepted source header spellings per canonical field (union of QBO, Xero and
// our own). Compared case-insensitively after trimming and stripping Xero's
// leading "*". First match in a file's header row wins.
const FIELD_ALIASES: Record<EntityKind, Record<string, string[]>> = {
  accounts: {
    code: ["code", "account number", "account no", "number", "account code"],
    name: ["name", "account name", "account"],
    type: ["type", "account type"],
    subtype: ["subtype", "detail type", "detailtype"],
  },
  customers: {
    name: ["name", "customer", "contactname", "contact name", "customer name", "display name as", "company"],
    email: ["email", "emailaddress", "email address", "e-mail"],
    phone: ["phone", "phonenumber", "phone number", "phone numbers"],
    address: ["address", "billing address", "poaddressline1", "street"],
    shipping_city: ["shipping_city", "shipping city", "city", "pocity"],
    shipping_state: ["shipping_state", "shipping state", "state", "poregion", "province"],
    shipping_zip: ["shipping_zip", "shipping zip", "zip", "postal code", "popostalcode", "zip code"],
  },
  vendors: {
    name: ["name", "vendor", "supplier", "contactname", "contact name", "vendor name", "company"],
    email: ["email", "emailaddress", "email address", "e-mail"],
    phone: ["phone", "phonenumber", "phone number", "phone numbers"],
    address: ["address", "billing address", "poaddressline1", "street"],
    shipping_city: ["shipping_city", "shipping city", "city", "pocity"],
    shipping_state: ["shipping_state", "shipping state", "state", "poregion", "province"],
    shipping_zip: ["shipping_zip", "shipping zip", "zip", "postal code", "popostalcode", "zip code"],
  },
  items: {
    sku: ["sku", "itemcode", "item code", "code", "product code"],
    name: ["name", "product/service name", "product/service", "itemname", "item name", "item"],
    type: ["type", "item type"],
    income_account_code: ["income_account_code", "income account", "salesaccount", "sales account", "income account code"],
    expense_account_code: ["expense_account_code", "expense account", "purchasesaccount", "purchase account", "expense account code"],
    cogs_account_code: ["cogs_account_code", "cogs account", "costofgoodssoldaccount", "cogs"],
    inventory_account_code: ["inventory_account_code", "inventory account", "inventoryassetaccount", "asset account"],
    description: ["description", "purchase description", "sales description"],
  },
  invoices: {
    number: ["number", "invoice no", "invoice number", "invoicenumber", "invoice #", "invoiceno"],
    customer_name: ["customer_name", "customer", "contactname", "contact name", "customer name"],
    date: ["date", "invoice date", "invoicedate"],
    due_date: ["due_date", "due date", "duedate"],
    tax_rate: ["tax_rate", "tax rate", "tax %", "taxrate"],
    line_description: ["line_description", "description", "item description", "memo/description"],
    quantity: ["quantity", "qty"],
    rate: ["rate", "unit price", "unitamount", "price", "amount"],
    income_account_code: ["income_account_code", "income account", "accountcode", "account code", "account"],
  },
  bills: {
    number: ["number", "bill no", "bill number", "invoicenumber", "reference", "bill #"],
    vendor_name: ["vendor_name", "vendor", "supplier", "contactname", "contact name"],
    date: ["date", "bill date", "invoicedate"],
    due_date: ["due_date", "due date", "duedate"],
    tax_rate: ["tax_rate", "tax rate", "taxrate"],
    line_description: ["line_description", "description", "item description"],
    quantity: ["quantity", "qty"],
    rate: ["rate", "unit price", "unitamount", "amount"],
    expense_account_code: ["expense_account_code", "expense account", "accountcode", "account code", "account"],
  },
  trial_balance: {
    account_code: ["account_code", "code", "account code", "account number", "account no"],
    account_name: ["account_name", "account", "account name", "name"],
    debit: ["debit", "debits", "debit ($)"],
    credit: ["credit", "credits", "credit ($)"],
  },
};

const norm = (h: string) => h.trim().toLowerCase().replace(/^\*/, "");

// ---------------------------------------------------------------------------
// Parse — keep ORIGINAL header spellings (the mapping UI shows them verbatim).
// ---------------------------------------------------------------------------
export function parseWithHeaders(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : firstLineHeaders(csvText);
  return { headers, rows: records };
}
function firstLineHeaders(csvText: string): string[] {
  const line = (csvText.split(/\r?\n/)[0] || "").trim();
  if (!line) return [];
  return (parse(line, { skip_empty_lines: true, trim: true, bom: true })[0] as string[]) ?? [];
}

// ---------------------------------------------------------------------------
// Source detection by header signature.
// ---------------------------------------------------------------------------
export function detectSource(headers: string[]): Source {
  let xero = 0, qbo = 0;
  for (const raw of headers) {
    const h = raw.trim().toLowerCase();
    if (raw.trim().startsWith("*")) xero += 2; // Xero marks required columns with a leading asterisk
    if (/^(contactname|unitamount|accountcode|itemcode|pocity|poregion|popostalcode|purchasesaccount|salesunitprice)$/.test(norm(h))) xero += 2;
    if (/detail type|product\/service|memo\/description|account number/.test(h)) qbo += 2;
  }
  if (xero === 0 && qbo === 0) return "generic";
  return xero >= qbo ? "xero" : "qbo";
}

// ---------------------------------------------------------------------------
// Entity detection — score each entity by matched fields, then apply a few
// distinctive tie-breakers. The wizard lets the user override the guess.
// ---------------------------------------------------------------------------
export function detectEntity(headers: string[]): EntityKind {
  const hn = headers.map(norm);
  const has = (aliases: string[]) => aliases.some((a) => hn.includes(a));
  // A genuine Products/Services file names a catalog item AND a GL account —
  // NOT just a bare "code" column (which a chart of accounts also has).
  const itemsSignal = hn.some((h) => /product|item/.test(h)) ||
    has(["salesaccount", "purchasesaccount", "sales price", "salesunitprice", "income account", "expense account"]);
  // Strongest structural signals first.
  if (has(FIELD_ALIASES.trial_balance.debit) && has(FIELD_ALIASES.trial_balance.credit)) return "trial_balance";
  if (itemsSignal && has(["type", "sku", "item type"])) return "items";

  const scores: Array<[EntityKind, number]> = (Object.keys(FIELD_ALIASES) as EntityKind[]).map((e) => {
    let s = 0;
    for (const field of Object.keys(FIELD_ALIASES[e])) if (has(FIELD_ALIASES[e][field])) s++;
    return [e, s];
  });
  // Distinctive boosts to separate look-alikes.
  const bump = (e: EntityKind, n: number) => { const t = scores.find((x) => x[0] === e); if (t) t[1] += n; };
  if (hn.some((h) => /invoice/.test(h))) bump("invoices", 3);
  if (hn.some((h) => /bill/.test(h))) bump("bills", 3);
  if (has(["vendor", "supplier"])) { bump("vendors", 2); bump("bills", 1); }
  if (has(["customer"])) { bump("customers", 2); bump("invoices", 1); }
  if (itemsSignal) bump("items", 3);
  // A Type column with account names/codes and no item signal is a chart of accounts.
  if (has(FIELD_ALIASES.accounts.type) && !itemsSignal) bump("accounts", 3);
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : "customers";
}

// ---------------------------------------------------------------------------
// Suggest a mapping: canonical field → chosen source header ("" if none).
// This is the "saved default per source" the wizard preloads and the user can
// override before the dry run.
// ---------------------------------------------------------------------------
export type Mapping = Record<string, string>;
export function suggestMapping(entity: EntityKind, headers: string[]): Mapping {
  const mapping: Mapping = {};
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const { field } of CANONICAL_FIELDS[entity]) {
    const aliases = FIELD_ALIASES[entity][field] ?? [field];
    let chosen = "";
    for (const a of aliases) { const hit = byNorm.get(norm(a)); if (hit) { chosen = hit; break; } }
    mapping[field] = chosen;
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Account-type vocabulary: map QBO/Xero type words to our {type, subtype}.
// Order matters — the most specific patterns are tested first.
// ---------------------------------------------------------------------------
const CANON_TYPES = new Set(["asset", "liability", "equity", "income", "expense"]);
export function classifyAccountType(rawType: string, rawSubtype: string): { type: string; subtype: string } {
  const already = rawType.trim().toLowerCase();
  const s = `${rawSubtype} ${rawType}`.toLowerCase();
  if (/equity|retained earnings|owner/.test(s)) return { type: "equity", subtype: "equity" };
  if (/cost of goods|direct cost|cogs/.test(s)) return { type: "expense", subtype: "cogs" };
  if (/depreciation/.test(s) && /expense|overhead/.test(s)) return { type: "expense", subtype: "depreciation_expense" };
  if (/other income|other revenue/.test(s)) return { type: "income", subtype: "other_income" };
  if (/income|revenue|sales|turnover/.test(s)) return { type: "income", subtype: "operating_income" };
  if (/other expense/.test(s)) return { type: "expense", subtype: "other_expense" };
  if (/expense|overhead|operating cost/.test(s)) return { type: "expense", subtype: "operating_expense" };
  if (/credit card/.test(s)) return { type: "liability", subtype: "credit_card" };
  if (/long.?term|non.?current liab/.test(s)) return { type: "liability", subtype: "long_term_liability" };
  if (/payable|current liab|liabilit/.test(s)) return { type: "liability", subtype: "current_liability" };
  if (/accumulated depreciation/.test(s)) return { type: "asset", subtype: "accumulated_depreciation" };
  if (/bank|checking|savings|cash/.test(s)) return { type: "asset", subtype: "bank" };
  if (/fixed asset/.test(s)) return { type: "asset", subtype: "fixed_asset" };
  if (/intangible/.test(s)) return { type: "asset", subtype: "intangible_asset" };
  if (/receivable|inventory|current asset|prepaid|other current asset/.test(s)) return { type: "asset", subtype: "current_asset" };
  if (/asset/.test(s)) return { type: "asset", subtype: "other_asset" };
  // Already one of our canonical type words? Trust it (generic CSVs).
  if (CANON_TYPES.has(already)) return { type: already, subtype: rawSubtype.trim().toLowerCase() };
  return { type: already, subtype: rawSubtype.trim().toLowerCase() }; // unknown → importer flags it
}

// ---------------------------------------------------------------------------
// Apply mapping → canonical rows, with per-entity value normalization.
// ---------------------------------------------------------------------------
export function applyMapping(entity: EntityKind, source: Source, mapping: Mapping, rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map((r) => {
    const out: Record<string, string> = {};
    for (const { field } of CANONICAL_FIELDS[entity]) {
      const header = mapping[field];
      out[field] = header && r[header] != null ? String(r[header]).trim() : "";
    }
    if (entity === "accounts" && source !== "generic") {
      const { type, subtype } = classifyAccountType(out.type, out.subtype);
      out.type = type; out.subtype = subtype;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Serialize canonical rows to a canonical CSV the row-level importers accept.
// ---------------------------------------------------------------------------
function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
export function toCanonicalCsv(entity: EntityKind, rows: Record<string, string>[]): string {
  const fields = CANONICAL_FIELDS[entity].map((f) => f.field);
  const lines = [fields.join(",")];
  for (const r of rows) lines.push(fields.map((f) => csvEscape(r[f] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Analyze one uploaded file: everything the wizard needs for the mapping step.
// ---------------------------------------------------------------------------
export function analyzeFile(csvText: string, entityHint?: EntityKind, sourceHint?: Source) {
  const { headers, rows } = parseWithHeaders(csvText);
  const source = sourceHint ?? detectSource(headers);
  const entity = entityHint ?? detectEntity(headers);
  const mapping = suggestMapping(entity, headers);
  const unmapped = CANONICAL_FIELDS[entity].filter((f) => f.required && !mapping[f.field]).map((f) => f.field);
  return {
    source, entity, headers,
    mapping,
    unmapped,
    rowCount: rows.length,
    sampleRows: rows.slice(0, 5),
    entityOptions: Object.keys(ENTITY_LABELS) as EntityKind[],
    canonicalFields: CANONICAL_FIELDS[entity],
  };
}

// ---------------------------------------------------------------------------
// Run one file through the pipeline and into its importer.
// ---------------------------------------------------------------------------
export async function runImport(
  entity: EntityKind, source: Source, mapping: Mapping, csvText: string,
  opts: { dryRun: boolean; conversionDate?: string; partial?: boolean }
): Promise<ImportReport> {
  const { rows } = parseWithHeaders(csvText);
  const canonicalRows = applyMapping(entity, source, mapping, rows);
  const canonicalCsv = toCanonicalCsv(entity, canonicalRows);
  const { dryRun, conversionDate, partial } = opts;
  switch (entity) {
    case "accounts": return importers.importChartOfAccounts(canonicalCsv, dryRun);
    case "customers": return importers.importCustomers(canonicalCsv, dryRun);
    case "vendors": return importers.importVendors(canonicalCsv, dryRun);
    case "items": return importers.importItems(canonicalCsv, dryRun);
    case "invoices": return importers.importInvoices(canonicalCsv, dryRun, !!partial);
    case "bills": return importers.importBills(canonicalCsv, dryRun, !!partial);
    case "trial_balance": return importers.importTrialBalance(canonicalCsv, conversionDate || "", dryRun);
    default: throw new Error(`Unknown entity "${entity}"`);
  }
}

// ---------------------------------------------------------------------------
// Guard support: the wizard requires typing the org name before committing
// into an org that already has posted transactions.
// ---------------------------------------------------------------------------
export async function orgMigrationSummary(): Promise<{ orgId: number; orgName: string; hasTransactions: boolean; journalEntryCount: number }> {
  const orgId = currentOrgId();
  const org = (await pool.query(`SELECT name FROM organizations WHERE id = $1`, [orgId])).rows[0] as { name: string } | undefined;
  const jeCount = Number((await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE org_id = $1`, [orgId])).rows[0].c);
  return { orgId, orgName: org?.name ?? "", hasTransactions: jeCount > 0, journalEntryCount: jeCount };
}
