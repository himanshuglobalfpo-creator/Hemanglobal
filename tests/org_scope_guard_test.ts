// ============================================================================
// ORG-SCOPE GUARD — CI gate against the missing-org-filter bug class
// ============================================================================
// Three consecutive audits (v2.0.0, v2.1.0, v2.1.1) each found the SAME bug in
// a different module: a query on a tenant-owned table with no org filter,
// letting one tenant read or write another tenant's data (row IDs are a global
// sequence, so they're guessable). This test turns that review question into a
// build failure.
//
// How it works (static analysis, no DB needed):
//   1. Read server/storage.ts as text.
//   2. Find every `.from(<BusinessTable>)` occurrence.
//   3. PASS the occurrence if any of:
//        a. its statement contains an org filter ("orgId" / "org_id"),
//        b. its statement uses `.where(where)` / `.where(and(...conditions))`
//           and the enclosing method builds that variable WITH an org filter,
//        c. the enclosing method is on the documented ALLOWLIST of provably
//           safe patterns (public-token auth, boot-time withOrg loops,
//           child rows fetched by the key of an org-scoped parent).
//   4. Exit 1 listing every violation otherwise.
//
// If this fails on your new code: add eq(<table>.orgId, currentOrgId()) to the
// query (or AND org_id = $N in raw SQL). Only extend the ALLOWLIST when the
// query is provably safe WITHOUT the filter, with a one-line reason.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_PATH = join(__dirname, "..", "server", "storage.ts");
const src = readFileSync(STORAGE_PATH, "utf8");

// Tenant-owned tables. users/sessions/organizations/orgMemberships/
// schemaMigrations are intentionally global (or membership-keyed) and excluded.
const BUSINESS_TABLES = [
  "accounts",
  "invoices",
  "invoiceLines",
  "bills",
  "billLines",
  "customers",
  "vendors",
  "journalEntries",
  "journalLines",
  "bankTransactions",
  "bankRules",
  "reconciliations",
  "reconciliationItems",
  "recurringTemplates",
  "periodLocks",
  "invoiceShares",
  "creditNotes",
  "creditNoteApplications",
  "debitNotes",
  "debitNoteApplications",
  "taxCodes",
  "nexusRegions",
  "auditLog",
  "plaidItems",
];

// (method, table) pairs where an unscoped .from(table) inside that method is
// SAFE BY DESIGN. TABLE-SPECIFIC on purpose: allowlisting a whole method would
// also mask its PRIMARY lookup — e.g. getReconciliation's reconciliationItems
// child-fetch is safe, but its reconciliations lookup MUST stay org-filtered,
// and the guard must still fail if someone removes that filter.
// Every entry documents why. Keep this SHORT — prefer adding the org filter.
// Child-row fetches (lines/items keyed by an org-scoped parent id) are the
// dominant category: the parent lookup in the same method already enforced
// tenancy, and the child key (entryId / invoiceId / reconciliationId) is
// meaningless across tenants.
const ALLOWLIST: Record<string, { tables: string[]; reason: string }> = {
  getShareByToken: {
    tables: ["invoiceShares"],
    reason: "public share page: unguessable token IS the auth; body resolves invoice via withOrg(share.orgId)",
  },
  recordShareView: {
    tables: ["invoiceShares"],
    reason: "public share page: token is the auth; only bumps view counters on that share row",
  },
  runCatchUp: {
    tables: ["recurringTemplates"],
    reason: "boot-time job outside any request; iterates ALL orgs' due templates wrapping EACH in withOrg(t.orgId)",
  },
  getInvoice: {
    tables: ["invoiceLines"],
    reason: "invoiceLines fetched by invoiceId of the org-scoped invoice loaded first in this method",
  },
  getBill: {
    tables: ["billLines"],
    reason: "billLines fetched by billId of the org-scoped bill loaded first in this method",
  },
  listInvoices: {
    tables: ["invoiceLines"],
    reason: "lines aggregated per invoice id from the org-scoped page query",
  },
  listBills: {
    tables: ["billLines"],
    reason: "lines aggregated per bill id from the org-scoped page query",
  },
  listJournalEntries: {
    tables: ["journalLines"],
    reason: "journalLines fetched via inArray(entryIds) where entryIds came from the org-scoped page query",
  },
  getJournalEntry: {
    tables: ["journalLines"],
    reason: "journalLines fetched by entryId of the org-scoped entry loaded first in this method",
  },
  voidInvoice: {
    tables: ["journalLines"],
    reason: "journalLines fetched by entryId of the org-scoped original entry (entry lookup is org-filtered)",
  },
  voidBill: {
    tables: ["journalLines"],
    reason: "journalLines fetched by entryId of the org-scoped original entry (entry lookup is org-filtered)",
  },
  unmatchBankTransaction: {
    tables: ["journalLines"],
    reason: "journalLines fetched by entryId of the org-scoped matched entry (entry lookup is org-filtered)",
  },
  reclassifyLines: {
    tables: ["journalLines"],
    reason: "journalLines validated against org-scoped journal entries inside the same transaction",
  },
  getReconciliation: {
    tables: ["reconciliationItems"],
    reason: "items fetched by reconciliationId of the org-scoped recon (the recon lookup itself is NOT exempt)",
  },
  toggleReconItem: {
    tables: ["reconciliationItems"],
    reason: "items keyed by the org-scoped recon loaded first in this method (the recon lookup itself is NOT exempt)",
  },
  deleteReconciliation: {
    tables: ["reconciliationItems"],
    reason: "items deleted by reconciliationId of the org-scoped recon",
  },
  listSharesForInvoice: {
    tables: ["invoiceShares"],
    reason: "only reachable from routes after org-scoped getInvoice ownership check",
  },
  createInvoiceShare: {
    tables: ["invoiceShares"],
    reason: "invoice ownership verified via org-scoped getInvoice before insert",
  },
};

// ---------------------------------------------------------------------------
// Method attribution: scan for `async <name>(` and `private async <name>(`
// declarations at class-method indentation. Control-flow keywords are skipped.
// ---------------------------------------------------------------------------
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "new"]);
type MethodSpan = { name: string; start: number };
const methodSpans: MethodSpan[] = [];
const methodRe = /^\s{2}(?:private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/gm;
let mm: RegExpExecArray | null;
while ((mm = methodRe.exec(src)) !== null) {
  if (!KEYWORDS.has(mm[1])) methodSpans.push({ name: mm[1], start: mm.index });
}
methodSpans.sort((a, b) => a.start - b.start);

function enclosingMethodSpan(offset: number): { name: string; start: number; end: number } {
  let cur = { name: "<module>", start: 0 };
  let next = src.length;
  for (let i = 0; i < methodSpans.length; i++) {
    if (methodSpans[i].start <= offset) cur = methodSpans[i];
    else {
      next = methodSpans[i].start;
      break;
    }
  }
  return { name: cur.name, start: cur.start, end: next };
}

function lineOf(offset: number): number {
  return src.slice(0, offset).split("\n").length;
}

// The "statement" around a .from(): walk back to the previous real ';' or '{'
// and forward to the next real ';'. "Real" = not inside a // line comment,
// because comments in this codebase legitimately contain semicolons (e.g.
// "// Defense-in-depth: inv is already org-scoped;") which would otherwise
// truncate the slice before the orgId filter and cause a false positive.
function isInLineComment(pos: number): boolean {
  // Scan back to start of line; if we pass "//" before reaching `pos`'s column
  // start, pos is within a comment.
  let i = pos;
  while (i > 0 && src[i] !== "\n") i--;
  const lineStart = i === 0 ? 0 : i + 1;
  const slashIdx = src.indexOf("//", lineStart);
  return slashIdx !== -1 && slashIdx < pos;
}
function statementAround(offset: number): string {
  let start = offset;
  while (start > 0) {
    const c = src[start];
    if ((c === ";" || c === "{") && !isInLineComment(start)) break;
    start--;
  }
  let end = offset;
  while (end < src.length) {
    if (src[end] === ";" && !isInLineComment(end)) break;
    end++;
  }
  return src.slice(start, end + 1);
}

// Does the enclosing method build an org-scoped `where`/`conditions` variable
// that this statement then consumes via .where(where)?
function whereVarIsScoped(methodBody: string): boolean {
  // matches: const where = eq(<t>.orgId, currentOrgId())
  //          const where = and(eq(<t>.orgId, ...), ...)
  //          const conditions: any[] = [eq(<t>.orgId, currentOrgId())]; ... and(...conditions)
  const whereDecl = methodBody.match(/const\s+where\s*=\s*([\s\S]*?);/);
  if (whereDecl && /orgId|org_id/.test(whereDecl[1])) return true;
  const condsDecl = methodBody.match(/const\s+conditions[^=]*=\s*\[([\s\S]*?)\]/);
  if (condsDecl && /orgId|org_id/.test(condsDecl[1])) return true;
  return false;
}

const violations: string[] = [];
let checked = 0;

for (const table of BUSINESS_TABLES) {
  const re = new RegExp(`\\.from\\(${table}\\)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    checked++;
    const stmt = statementAround(m.index);
    const span = enclosingMethodSpan(m.index);
    const methodBody = src.slice(span.start, span.end);

    const directlyScoped = stmt.includes("orgId") || stmt.includes("org_id");
    const usesWhereVar =
      /\.where\(\s*where\s*\)/.test(stmt) || /\.where\(\s*and\(\s*\.\.\.conditions\s*\)/.test(stmt);
    const viaWhereVar = usesWhereVar && whereVarIsScoped(methodBody);
    const entry = ALLOWLIST[span.name];
    const allowlisted = !!entry && entry.tables.includes(table);

    if (!directlyScoped && !viaWhereVar && !allowlisted) {
      violations.push(
        `  ❌ line ${lineOf(m.index)} in ${span.name}(): .from(${table}) has no org filter\n` +
          `     ${stmt.trim().split("\n").map((l) => l.trim()).join(" ").slice(0, 160)}…`
      );
    }
  }
}

console.log("Org-scope guard: static scan of server/storage.ts");
console.log(`  Business-table .from() occurrences checked: ${checked}`);
console.log(`  Allowlisted methods: ${Object.keys(ALLOWLIST).length}`);

if (violations.length > 0) {
  console.log(`\n${violations.length} VIOLATION(S) — every business-table query must filter by orgId:\n`);
  for (const v of violations) console.log(v);
  console.log(
    "\nFix: add eq(<table>.orgId, currentOrgId()) to the query (or AND org_id = $N for raw SQL)." +
      "\nOnly allowlist a method if it is provably safe without the filter, with a one-line reason.\n"
  );
  process.exit(1);
}

console.log("\n✅ ORG-SCOPE GUARD PASSES — no unscoped business-table queries detected");
