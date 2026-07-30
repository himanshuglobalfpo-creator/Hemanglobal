// ============================================================================
// CREDIT NOTE (AR) & DEBIT NOTE (AP) SERVICE
// ============================================================================
// A credit note is a standalone AR document — NOT an invoice void. Issuing one
// posts its own GL entry:
//     Dr Revenue (per line)        — reduces revenue
//     Dr Sales Tax Payable (if tax) — reverses the tax liability portion
//     Cr Accounts Receivable (1100) — reduces what the customer owes
// Applying a credit note against an invoice moves invoice.amountPaid only;
// NO new journal entry is posted, because AR was already credited at issue.
//
// A debit note is the AP mirror:
//     Dr Accounts Payable (2000)    — reduces what we owe the vendor
//     Cr Expense (per line)         — reduces the expense
//     Cr Sales Tax Receivable (1150, if tax) — reverses recoverable tax
//
// Neither document EVER touches Cash — cash only moves via payments/refunds.
//
// Units: REAL dollars rounded to 2dp, matching invoices/bills/journal_lines
// throughout this codebase. (The original brief said integer cents; this
// ledger is dollar-denominated end to end, so notes follow the same unit —
// see the comment block in shared/schema.ts.)
//
// Org scoping: every function runs inside the request's AsyncLocalStorage org
// context (currentOrgId()/currentUserId() from ./org-scope) — the org is never
// read from the request body. Every mutation runs in a SQLite transaction.

import {
  accounts,
  customers,
  vendors,
  invoices,
  bills,
  creditNotes,
  creditNoteLines,
  creditNoteApplications,
  debitNotes,
  debitNoteLines,
  debitNoteApplications,
  type CreditNote,
  type CreditNoteLine,
  type CreditNoteApplication,
  type DebitNote,
  type DebitNoteLine,
  type DebitNoteApplication,
  type CreateCreditNoteInput,
  type CreateDebitNoteInput,
  type Invoice,
  type Bill,
} from "@shared/schema";
import { toCents, formatMoney } from "@shared/money";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import { db, storage } from "./storage";
import { emitWebhookEvent } from "./webhooks";
import { currentOrgId, currentUserId } from "./org-scope";

// All money is INTEGER CENTS — math is exact, no epsilon needed anywhere.
// User-input dollars convert ONCE at the API boundary via toCents().

// ---------------------------------------------------------------------------
// Numbering: CN-0001 / DN-0001, sequential PER ORG.
// Delegates to storage.nextNumber(), which allocates via ONE atomic
// INSERT..ON CONFLICT DO UPDATE..RETURNING on number_sequences — race-safe
// under concurrency (row lock serializes allocators). The old MAX+1 table
// scan could hand two concurrent creates the same number and relied on the
// UNIQUE(org_id, number) constraint to roll one back; the sequence removes
// the race instead of surviving it. Pre-sequence rows (CN-1 style, unpadded)
// coexist safely: they can never string-collide with CN-0001-style values.
// ---------------------------------------------------------------------------
async function nextNoteNumber(table: "credit_notes" | "debit_notes", _prefix: "CN" | "DN"): Promise<string> {
  return storage.nextNumber(table === "credit_notes" ? "credit_note" : "debit_note");
}

async function requireAccount(code: string, label: string) {
  const acct = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.code, code), eq(accounts.orgId, currentOrgId())))
    .then((r: any[]) => r[0]);
  if (!acct) throw new Error(`${label} account (${code}) missing from the chart of accounts`);
  return acct;
}

// NOTE: the old `touch()` helper (UPDATE ... SET updated_at via pool.query) was
// removed. It ran on a SEPARATE pool connection; now that note updates hold a
// row lock inside their transaction, a cross-connection UPDATE of the same row
// mid-transaction would block on that lock and self-deadlock. updated_at is
// folded into each in-transaction .set() instead.

// ===========================================================================
// CREDIT NOTES (AR)
// ===========================================================================

export async function createCreditNote(input: CreateCreditNoteInput): Promise<CreditNote & {
  lines: CreditNoteLine[];
  journalEntryId: number;
}> {
  const orgId = currentOrgId();
  const ar = await requireAccount("1100", "Accounts Receivable");

  // Customer must belong to this org.
  const customer = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!customer) throw new Error("Customer not found");

  // Every revenue account must belong to this org and be income (or expense,
  // for sales-returns accounts kept on the expense side).
  for (const l of input.lines) {
    const acct = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, l.revenueAccountId), eq(accounts.orgId, orgId)))
      .then((r: any[]) => r[0]);
    if (!acct) throw new Error(`Revenue account ${l.revenueAccountId} not found`);
    if (acct.type !== "income" && acct.type !== "expense") {
      throw new Error(
        `Account "${acct.name}" must be an income account (or an expense account for returns) — got type "${acct.type}"`
      );
    }
  }

  // The linked invoice (if any) must belong to this org AND the same customer.
  if (input.invoiceId !== undefined) {
    const inv = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, orgId)))
      .then((r: any[]) => r[0]);
    if (!inv) throw new Error("Linked invoice not found");
    if (inv.customerId !== input.customerId) {
      throw new Error(
        `Invoice ${inv.number} belongs to a different customer — a credit note must reference an invoice of the same customer`
      );
    }
    if (inv.status === "void") throw new Error(`Invoice ${inv.number} is voided — cannot credit it`);
  }

  // Per-line rounding, then sum — same JE-balancing fix as createInvoice.
  // Integer cents per line: rate is a dollar unit-price input; exact from here on.
  const lineAmounts = input.lines.map((l) => Math.round(l.quantity * l.rate * 100));
  const subtotal = lineAmounts.reduce((s, a) => s + a, 0); // exact integer sum
  const tax = Math.round((subtotal * (input.taxRate || 0)) / 100); // integer cents
  const total = subtotal + tax; // exact
  if (total <= 0) throw new Error("Credit note total must be greater than zero");

  const taxLiab =
    tax > 0
      ? await db.select().from(accounts).where(and(eq(accounts.code, "2100"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0])
      : undefined;
  if (tax > 0 && !taxLiab) {
    throw new Error("Sales Tax Payable account (2100) missing — cannot post a taxed credit note");
  }

  return await db.transaction(async (tx) => {
    const number = await nextNoteNumber("credit_notes", "CN");
    // Created as 'draft', then the GL entry posts and it flips to 'issued'
    // in the same transaction (credit notes are issued, not held as drafts).
    const note = await tx
      .insert(creditNotes)
      .values({
        orgId,
        number,
        customerId: input.customerId,
        invoiceId: input.invoiceId ?? null,
        date: input.date,
        status: "draft",
        reason: input.reason,
        subtotal,
        tax,
        total,
        appliedAmount: 0,
        remainingCredit: total,
        notes: input.notes ?? null,
        createdBy: currentUserId() ?? null,
      })
      .returning().then((r) => r[0]);

    const insertedLines: CreditNoteLine[] = [];
    for (let idx = 0; idx < input.lines.length; idx++) {
      const l = input.lines[idx];
      const inserted = await tx
        .insert(creditNoteLines)
        .values({
          orgId,
          creditNoteId: note.id,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: lineAmounts[idx],
          revenueAccountId: l.revenueAccountId,
        })
        .returning().then((r) => r[0]);
      insertedLines.push(inserted);
    }

    // GL: Dr Revenue per account (grouped), Dr Sales Tax Payable, Cr A/R total.
    // Never Cash — a credit note reduces the receivable; refunds are separate.
    const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [];
    const revMap = new Map<number, number>();
    input.lines.forEach((l, idx) => {
      revMap.set(l.revenueAccountId, (revMap.get(l.revenueAccountId) || 0) + lineAmounts[idx]);
    });
    for (const [acctId, amt] of revMap.entries()) {
      jeLines.push({ accountId: acctId, debit: amt, credit: 0, description: `Credit note ${number}` });
    }
    if (tax > 0 && taxLiab) {
      jeLines.push({ accountId: taxLiab.id, debit: tax, credit: 0, description: `Sales tax reversal on ${number}` });
    }
    jeLines.push({ accountId: ar.id, debit: 0, credit: total, description: `Credit note ${number}` });

    const { entry } = await storage.postJournalEntry({
      date: input.date,
      memo: `Credit note ${number}: ${input.reason}`,
      reference: number,
      source: "credit_note",
      sourceId: note.id,
      lines: jeLines,
    }, { _tx: tx }); // join THIS transaction — note + JE commit or roll back together

    const issued = await tx
      .update(creditNotes)
      .set({ status: "issued", updatedAt: sql`now()` })
      .where(eq(creditNotes.id, note.id))
      .returning().then((r) => r[0]);

    storage.audit("create", "credit_note", note.id, `Issued credit note ${number} (${formatMoney(total)}) — ${input.reason}`);
    return { ...issued, lines: insertedLines, journalEntryId: entry.id };
  }).then(async (result) => {
    // AFTER commit — a rolled-back note never notifies.
    await emitWebhookEvent("credit_note.issued", { id: result.id, number: result.number, total: result.total });
    return result;
  }).catch((err: any) => {
    // UNIQUE(org_id, number) violation → clean business error, not a raw 500.
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      throw new Error(`Credit note number already exists in this organization.`);
    }
    throw err;
  });
}

export async function applyCreditNote(
  creditNoteId: number,
  invoiceId: number,
  amountToApply: number
): Promise<{ creditNote: CreditNote; invoice: Invoice; application: CreditNoteApplication }> {
  const orgId = currentOrgId();
  // API sends dollars — convert ONCE; everything below is exact integer cents.
  amountToApply = toCents(amountToApply);
  if (amountToApply <= 0) throw new Error("Amount to apply must be greater than zero");

  return await db.transaction(async (tx) => {
    // CONCURRENCY FIX: the note and invoice are read INSIDE the transaction
    // with SELECT ... FOR UPDATE. Concurrent applies of the same note (or of
    // the same invoice) serialize on the row lock; the loser blocks, then
    // re-reads the state the winner committed, so the remaining-credit check
    // below can never pass on a stale snapshot and the note can never be
    // over-applied. Lock ORDER is fixed — note first, then invoice, the same
    // in applyDebitNote — so two applies can't deadlock by acquiring the two
    // rows in opposite order.
    const note = await tx
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.id, creditNoteId), eq(creditNotes.orgId, orgId)))
      .for("update")
      .then((r: any[]) => r[0]);
    if (!note) throw new Error("Credit note not found");
    if (note.status === "void") throw new Error(`Credit note ${note.number} is voided`);
    if (note.status === "draft") throw new Error(`Credit note ${note.number} has not been issued`);

    const inv = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
      .for("update")
      .then((r: any[]) => r[0]);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "void") throw new Error(`Invoice ${inv.number} is voided`);

    // A credit from Customer A can never pay down Customer B's invoice.
    if (inv.customerId !== note.customerId) {
      throw new Error(
        `Cannot apply credit note ${note.number} to invoice ${inv.number}: they belong to different customers`
      );
    }

    // Checked AFTER the lock is acquired: note.appliedAmount is the
    // serialized truth at this instant, not a pre-transaction snapshot.
    const remainingCredit = note.total - note.appliedAmount; // exact
    if (amountToApply > remainingCredit) { // exact
      throw new Error(
        `Cannot apply ${formatMoney(amountToApply)}: credit note ${note.number} has only ${formatMoney(remainingCredit)} remaining`
      );
    }
    const invoiceOutstanding = inv.total - inv.amountPaid; // exact
    if (amountToApply > invoiceOutstanding) { // exact
      throw new Error(
        `Cannot apply ${formatMoney(amountToApply)}: invoice ${inv.number} outstanding balance is only ${formatMoney(invoiceOutstanding)}`
      );
    }

    const application = await tx
      .insert(creditNoteApplications)
      .values({
        orgId,
        creditNoteId: note.id,
        invoiceId: inv.id,
        amountApplied: amountToApply,
        appliedBy: currentUserId() ?? null,
      })
      .returning().then((r) => r[0]);

    const newApplied = note.appliedAmount + amountToApply;
    const newRemaining = note.total - newApplied;
    const updatedNote = await tx
      .update(creditNotes)
      .set({
        appliedAmount: newApplied,
        remainingCredit: newRemaining,
        status: newRemaining === 0 ? "applied" : "issued", // exact
        updatedAt: sql`now()`, // in-tx; the old touch() helper ran on a SEPARATE pool connection and would deadlock against our own row lock
      })
      .where(eq(creditNotes.id, note.id))
      .returning().then((r) => r[0]);

    const newPaid = inv.amountPaid + amountToApply;
    const updatedInvoice = await tx
      .update(invoices)
      .set({
        amountPaid: newPaid,
        status: newPaid >= inv.total ? "paid" : inv.status,
      })
      .where(eq(invoices.id, inv.id))
      .returning().then((r) => r[0]);

    // NO journal entry here: A/R was already credited when the note was
    // issued. This is a sub-ledger allocation, not a GL event.
    storage.audit(
      "apply",
      "credit_note",
      note.id,
      `Applied ${formatMoney(amountToApply)} of ${note.number} to invoice ${inv.number}`
    );
    return { creditNote: updatedNote, invoice: updatedInvoice, application };
  });
}

// Un-apply a specific application — required before a partially/fully applied
// credit note can be voided ("must unapply first").
export async function unapplyCreditNote(creditNoteId: number, applicationId: number): Promise<CreditNote> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, creditNoteId), eq(creditNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) throw new Error("Credit note not found");
  const app = await db
    .select()
    .from(creditNoteApplications)
    .where(and(eq(creditNoteApplications.id, applicationId), eq(creditNoteApplications.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!app || app.creditNoteId !== note.id) throw new Error("Application not found on this credit note");

  const inv = await db.select().from(invoices).where(eq(invoices.id, app.invoiceId)).then((r: any[]) => r[0]);
  if (!inv) throw new Error("Invoice not found");

  return await db.transaction(async (tx) => {
    await tx.delete(creditNoteApplications).where(eq(creditNoteApplications.id, app.id));
    const newApplied = note.appliedAmount - app.amountApplied;
    const updatedNote = await tx
      .update(creditNotes)
      .set({
        appliedAmount: newApplied,
        remainingCredit: note.total - newApplied,
        status: "issued",
        updatedAt: sql`now()`,
      })
      .where(eq(creditNotes.id, note.id))
      .returning().then((r) => r[0]);
    const newPaid = inv.amountPaid - app.amountApplied;
    await tx.update(invoices)
      .set({ amountPaid: newPaid, status: newPaid >= inv.total ? "paid" : "open" })
      .where(eq(invoices.id, inv.id))
      ;
    storage.audit("unapply", "credit_note", note.id, `Unapplied ${formatMoney(app.amountApplied)} of ${note.number} from invoice ${inv.number}`);
    return updatedNote;
  });
}

export async function voidCreditNote(creditNoteId: number, reason: string): Promise<CreditNote> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, creditNoteId), eq(creditNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) throw new Error("Credit note not found");
  if (note.status === "void") return note; // idempotent, like voidInvoice
  if (note.appliedAmount > 0) { // exact
    throw new Error(
      `Cannot void ${note.number}: ${formatMoney(note.appliedAmount)} has been applied to invoices. Unapply first.`
    );
  }

  const ar = await requireAccount("1100", "Accounts Receivable");
  const lines = await db.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, note.id));
  const taxLiab =
    note.tax > 0
      ? await db.select().from(accounts).where(and(eq(accounts.code, "2100"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0])
      : undefined;

  return await db.transaction(async (tx) => {
    // Reversal JE: exact mirror of the issue entry.
    // Dr A/R total; Cr Revenue per account; Cr Sales Tax Payable.
    const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [
      { accountId: ar.id, debit: note.total, credit: 0, description: `Void credit note ${note.number}` },
    ];
    const revMap = new Map<number, number>();
    for (const l of lines) revMap.set(l.revenueAccountId, (revMap.get(l.revenueAccountId) || 0) + l.amount);
    for (const [acctId, amt] of revMap.entries()) {
      jeLines.push({ accountId: acctId, debit: 0, credit: amt, description: `Void credit note ${note.number}` });
    }
    if (note.tax > 0 && taxLiab) {
      jeLines.push({ accountId: taxLiab.id, debit: 0, credit: note.tax, description: `Void tax reversal ${note.number}` });
    }
    await storage.postJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      memo: `Void credit note ${note.number}: ${reason}`,
      reference: note.number,
      source: "credit_note_void",
      sourceId: note.id,
      lines: jeLines,
    }, { _tx: tx }); // was fire-and-forget on the OUTER db handle: a failed reversal JE could leave the note voided with the GL still carrying the credit
    const updated = await tx
      .update(creditNotes)
      .set({ status: "void", updatedAt: sql`now()` })
      .where(eq(creditNotes.id, note.id))
      .returning().then((r) => r[0]);
    storage.audit("void", "credit_note", note.id, `Voided credit note ${note.number} — ${reason}`);
    return updated;
  });
}

export async function listCreditNotes(filters: {
  customerId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<Array<CreditNote & { customerName: string; invoiceNumber: string | null }>> {
  const conds = [eq(creditNotes.orgId, currentOrgId())];
  if (filters.customerId) conds.push(eq(creditNotes.customerId, filters.customerId));
  if (filters.status) conds.push(eq(creditNotes.status, filters.status));
  if (filters.dateFrom) conds.push(gte(creditNotes.date, filters.dateFrom));
  if (filters.dateTo) conds.push(lte(creditNotes.date, filters.dateTo));

  const rows = await db
    .select({ note: creditNotes, customer: customers, invoice: invoices })
    .from(creditNotes)
    .innerJoin(customers, eq(creditNotes.customerId, customers.id))
    .leftJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
    .where(and(...conds))
    .orderBy(desc(creditNotes.date), desc(creditNotes.id))
    ;
  return rows.map((r) => ({
    ...r.note,
    customerName: r.customer.name,
    invoiceNumber: r.invoice?.number ?? null,
  }));
}

export async function getCreditNote(id: number):
  Promise<| (CreditNote & {
      lines: CreditNoteLine[];
      applications: Array<CreditNoteApplication & { invoiceNumber: string }>;
      customerName: string;
      invoiceNumber: string | null;
    })
  | undefined> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, id), eq(creditNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) return undefined;
  const lines = await db.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, id));
  const apps = await db
    .select({ app: creditNoteApplications, invoice: invoices })
    .from(creditNoteApplications)
    .innerJoin(invoices, eq(creditNoteApplications.invoiceId, invoices.id))
    .where(eq(creditNoteApplications.creditNoteId, id))
    ;
  const customer = await db.select().from(customers).where(eq(customers.id, note.customerId)).then((r: any[]) => r[0]);
  const linkedInvoice = note.invoiceId
    ? await db.select().from(invoices).where(eq(invoices.id, note.invoiceId)).then((r: any[]) => r[0])
    : undefined;
  return {
    ...note,
    lines,
    applications: apps.map((a) => ({ ...a.app, invoiceNumber: a.invoice.number })),
    customerName: customer?.name ?? "Unknown",
    invoiceNumber: linkedInvoice?.number ?? null,
  };
}

// Total unapplied credit for one customer — surfaced on the customer page and
// used by the AR aging report.
export async function customerCreditBalance(customerId: number): Promise<{ customerId: number; creditBalance: number; notes: Array<{ id: number; number: string; remainingCredit: number }> }> {
  const rows = await db
    .select()
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.orgId, currentOrgId()),
        eq(creditNotes.customerId, customerId),
        sql`${creditNotes.status} IN ('issued')`,
        sql`${creditNotes.remainingCredit} > 0`
      )
    )
    ;
  return {
    customerId,
    creditBalance: rows.reduce((s, n) => s + n.remainingCredit, 0), // exact integer cents
    notes: rows.map((n) => ({ id: n.id, number: n.number, remainingCredit: n.remainingCredit })),
  };
}

// Used by arAging(): every unapplied credit note in the org.
export async function unappliedCreditNotes(): Promise<CreditNote[]> {
  return db
    .select()
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.orgId, currentOrgId()),
        sql`${creditNotes.status} IN ('issued')`,
        sql`${creditNotes.remainingCredit} > 0`
      )
    )
    ;
}

// ===========================================================================
// DEBIT NOTES (AP) — mirror of the above
// ===========================================================================

export async function createDebitNote(input: CreateDebitNoteInput): Promise<DebitNote & {
  lines: DebitNoteLine[];
  journalEntryId: number;
}> {
  const orgId = currentOrgId();
  const ap = await requireAccount("2000", "Accounts Payable");

  const vendor = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!vendor) throw new Error("Vendor not found");

  for (const l of input.lines) {
    const acct = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, l.expenseAccountId), eq(accounts.orgId, orgId)))
      .then((r: any[]) => r[0]);
    if (!acct) throw new Error(`Expense account ${l.expenseAccountId} not found`);
    if (acct.type !== "expense") {
      throw new Error(`Account "${acct.name}" must be an expense account — got type "${acct.type}"`);
    }
  }

  if (input.billId !== undefined) {
    const bill = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, input.billId), eq(bills.orgId, orgId)))
      .then((r: any[]) => r[0]);
    if (!bill) throw new Error("Linked bill not found");
    if (bill.vendorId !== input.vendorId) {
      throw new Error(
        `Bill ${bill.number} belongs to a different vendor — a debit note must reference a bill of the same vendor`
      );
    }
    if (bill.status === "void") throw new Error(`Bill ${bill.number} is voided — cannot dispute it`);
  }

  // Integer cents per line: rate is a dollar unit-price input; exact from here on.
  const lineAmounts = input.lines.map((l) => Math.round(l.quantity * l.rate * 100));
  const subtotal = lineAmounts.reduce((s, a) => s + a, 0); // exact integer sum
  const tax = Math.round((subtotal * (input.taxRate || 0)) / 100); // integer cents
  const total = subtotal + tax; // exact
  if (total <= 0) throw new Error("Debit note total must be greater than zero");

  // Mirrors createBill: recoverable tax sits in Sales Tax Receivable (1150);
  // a debit note reverses it (credit side). Falls back to the first expense
  // account when 1150 doesn't exist — same fallback createBill uses.
  const taxAsset =
    tax > 0
      ? await db.select().from(accounts).where(and(eq(accounts.code, "1150"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0])
      : undefined;

  return await db.transaction(async (tx) => {
    const number = await nextNoteNumber("debit_notes", "DN");
    const note = await tx
      .insert(debitNotes)
      .values({
        orgId,
        number,
        vendorId: input.vendorId,
        billId: input.billId ?? null,
        date: input.date,
        status: "draft",
        reason: input.reason,
        subtotal,
        tax,
        total,
        appliedAmount: 0,
        remainingDebit: total,
        notes: input.notes ?? null,
        createdBy: currentUserId() ?? null,
      })
      .returning().then((r) => r[0]);

    const insertedLines: DebitNoteLine[] = [];
    for (let idx = 0; idx < input.lines.length; idx++) {
      const l = input.lines[idx];
      const inserted = await tx
        .insert(debitNoteLines)
        .values({
          orgId,
          debitNoteId: note.id,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: lineAmounts[idx],
          expenseAccountId: l.expenseAccountId,
        })
        .returning().then((r) => r[0]);
      insertedLines.push(inserted);
    }

    // GL: Dr A/P total; Cr Expense per account; Cr Sales Tax Receivable.
    // Never Cash — the debit note reduces the payable, it doesn't move money.
    const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [
      { accountId: ap.id, debit: total, credit: 0, description: `Debit note ${number}` },
    ];
    const expMap = new Map<number, number>();
    input.lines.forEach((l, idx) => {
      expMap.set(l.expenseAccountId, (expMap.get(l.expenseAccountId) || 0) + lineAmounts[idx]);
    });
    for (const [acctId, amt] of expMap.entries()) {
      jeLines.push({ accountId: acctId, debit: 0, credit: amt, description: `Debit note ${number}` });
    }
    if (tax > 0) {
      const taxAcctId = taxAsset?.id ?? [...expMap.keys()][0];
      jeLines.push({ accountId: taxAcctId, debit: 0, credit: tax, description: `Tax reversal on ${number}` });
    }

    const { entry } = await storage.postJournalEntry({
      date: input.date,
      memo: `Debit note ${number}: ${input.reason}`,
      reference: number,
      source: "debit_note",
      sourceId: note.id,
      lines: jeLines,
    }, { _tx: tx }); // join THIS transaction — note + JE commit or roll back together

    const sent = await tx
      .update(debitNotes)
      .set({ status: "sent", updatedAt: sql`now()` })
      .where(eq(debitNotes.id, note.id))
      .returning().then((r) => r[0]);

    storage.audit("create", "debit_note", note.id, `Sent debit note ${number} (${formatMoney(total)}) — ${input.reason}`);
    return { ...sent, lines: insertedLines, journalEntryId: entry.id };
  }).catch((err: any) => {
    // UNIQUE(org_id, number) violation → clean business error, not a raw 500.
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      throw new Error(`Debit note number already exists in this organization.`);
    }
    throw err;
  });
}

export async function applyDebitNote(
  debitNoteId: number,
  billId: number,
  amountToApply: number
): Promise<{ debitNote: DebitNote; bill: Bill; application: DebitNoteApplication }> {
  const orgId = currentOrgId();
  // API sends dollars — convert ONCE; everything below is exact integer cents.
  amountToApply = toCents(amountToApply);
  if (amountToApply <= 0) throw new Error("Amount to apply must be greater than zero");

  return await db.transaction(async (tx) => {
    // CONCURRENCY FIX — mirror of applyCreditNote: note and bill are read
    // INSIDE the transaction with SELECT ... FOR UPDATE, same lock order
    // (note first, then bill), and the remaining-debit check runs AFTER the
    // lock is held. Two concurrent applies serialize instead of over-applying.
    const note = await tx
      .select()
      .from(debitNotes)
      .where(and(eq(debitNotes.id, debitNoteId), eq(debitNotes.orgId, orgId)))
      .for("update")
      .then((r: any[]) => r[0]);
    if (!note) throw new Error("Debit note not found");
    if (note.status === "void") throw new Error(`Debit note ${note.number} is voided`);
    if (note.status === "draft") throw new Error(`Debit note ${note.number} has not been sent`);

    const bill = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.orgId, orgId)))
      .for("update")
      .then((r: any[]) => r[0]);
    if (!bill) throw new Error("Bill not found");
    if (bill.status === "void") throw new Error(`Bill ${bill.number} is voided`);
    if (bill.vendorId !== note.vendorId) {
      throw new Error(
        `Cannot apply debit note ${note.number} to bill ${bill.number}: they belong to different vendors`
      );
    }

    // Checked AFTER the lock is acquired: serialized truth, not a snapshot.
    const remainingDebit = note.total - note.appliedAmount; // exact
    if (amountToApply > remainingDebit) { // exact
      throw new Error(
        `Cannot apply ${formatMoney(amountToApply)}: debit note ${note.number} has only ${formatMoney(remainingDebit)} remaining`
      );
    }
    const billOutstanding = bill.total - bill.amountPaid; // exact
    if (amountToApply > billOutstanding) { // exact
      throw new Error(
        `Cannot apply ${formatMoney(amountToApply)}: bill ${bill.number} outstanding balance is only ${formatMoney(billOutstanding)}`
      );
    }

    const application = await tx
      .insert(debitNoteApplications)
      .values({
        orgId,
        debitNoteId: note.id,
        billId: bill.id,
        amountApplied: amountToApply,
        appliedBy: currentUserId() ?? null,
      })
      .returning().then((r) => r[0]);

    const newApplied = note.appliedAmount + amountToApply;
    const newRemaining = note.total - newApplied;
    const updatedNote = await tx
      .update(debitNotes)
      .set({
        appliedAmount: newApplied,
        remainingDebit: newRemaining,
        status: newRemaining === 0 ? "accepted" : "sent", // exact
        updatedAt: sql`now()`, // in-tx; cross-connection touch() would deadlock against our own row lock
      })
      .where(eq(debitNotes.id, note.id))
      .returning().then((r) => r[0]);

    const newPaid = bill.amountPaid + amountToApply;
    const updatedBill = await tx
      .update(bills)
      .set({
        amountPaid: newPaid,
        status: newPaid >= bill.total ? "paid" : bill.status,
      })
      .where(eq(bills.id, bill.id))
      .returning().then((r) => r[0]);

    // No JE — A/P was already debited when the note was created.
    storage.audit(
      "apply",
      "debit_note",
      note.id,
      `Applied ${formatMoney(amountToApply)} of ${note.number} to bill ${bill.number}`
    );
    return { debitNote: updatedNote, bill: updatedBill, application };
  });
}

export async function unapplyDebitNote(debitNoteId: number, applicationId: number): Promise<DebitNote> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(debitNotes)
    .where(and(eq(debitNotes.id, debitNoteId), eq(debitNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) throw new Error("Debit note not found");
  const app = await db
    .select()
    .from(debitNoteApplications)
    .where(and(eq(debitNoteApplications.id, applicationId), eq(debitNoteApplications.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!app || app.debitNoteId !== note.id) throw new Error("Application not found on this debit note");

  const bill = await db.select().from(bills).where(eq(bills.id, app.billId)).then((r: any[]) => r[0]);
  if (!bill) throw new Error("Bill not found");

  return await db.transaction(async (tx) => {
    await tx.delete(debitNoteApplications).where(eq(debitNoteApplications.id, app.id));
    const newApplied = note.appliedAmount - app.amountApplied;
    const updatedNote = await tx
      .update(debitNotes)
      .set({
        appliedAmount: newApplied,
        remainingDebit: note.total - newApplied,
        status: "sent",
        updatedAt: sql`now()`,
      })
      .where(eq(debitNotes.id, note.id))
      .returning().then((r) => r[0]);
    const newPaid = bill.amountPaid - app.amountApplied;
    await tx.update(bills)
      .set({ amountPaid: newPaid, status: newPaid >= bill.total ? "paid" : "open" })
      .where(eq(bills.id, bill.id))
      ;
    storage.audit("unapply", "debit_note", note.id, `Unapplied ${formatMoney(app.amountApplied)} of ${note.number} from bill ${bill.number}`);
    return updatedNote;
  });
}

export async function voidDebitNote(debitNoteId: number, reason: string): Promise<DebitNote> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(debitNotes)
    .where(and(eq(debitNotes.id, debitNoteId), eq(debitNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) throw new Error("Debit note not found");
  if (note.status === "void") return note;
  if (note.appliedAmount > 0) { // exact
    throw new Error(
      `Cannot void ${note.number}: ${formatMoney(note.appliedAmount)} has been applied to bills. Unapply first.`
    );
  }

  const ap = await requireAccount("2000", "Accounts Payable");
  const lines = await db.select().from(debitNoteLines).where(eq(debitNoteLines.debitNoteId, note.id));
  const taxAsset =
    note.tax > 0
      ? await db.select().from(accounts).where(and(eq(accounts.code, "1150"), eq(accounts.orgId, orgId))).then((r: any[]) => r[0])
      : undefined;

  return await db.transaction(async (tx) => {
    // Reversal: Cr A/P total; Dr Expense per account; Dr tax asset.
    const jeLines: Array<{ accountId: number; debit: number; credit: number; description?: string }> = [];
    const expMap = new Map<number, number>();
    for (const l of lines) expMap.set(l.expenseAccountId, (expMap.get(l.expenseAccountId) || 0) + l.amount);
    for (const [acctId, amt] of expMap.entries()) {
      jeLines.push({ accountId: acctId, debit: amt, credit: 0, description: `Void debit note ${note.number}` });
    }
    if (note.tax > 0) {
      const taxAcctId = taxAsset?.id ?? [...expMap.keys()][0];
      jeLines.push({ accountId: taxAcctId, debit: note.tax, credit: 0, description: `Void tax reversal ${note.number}` });
    }
    jeLines.push({ accountId: ap.id, debit: 0, credit: note.total, description: `Void debit note ${note.number}` });
    await storage.postJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      memo: `Void debit note ${note.number}: ${reason}`,
      reference: note.number,
      source: "debit_note_void",
      sourceId: note.id,
      lines: jeLines,
    }, { _tx: tx }); // was fire-and-forget on the OUTER db handle — see voidCreditNote
    const updated = await tx
      .update(debitNotes)
      .set({ status: "void", updatedAt: sql`now()` })
      .where(eq(debitNotes.id, note.id))
      .returning().then((r) => r[0]);
    storage.audit("void", "debit_note", note.id, `Voided debit note ${note.number} — ${reason}`);
    return updated;
  });
}

export async function listDebitNotes(filters: {
  vendorId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<Array<DebitNote & { vendorName: string; billNumber: string | null }>> {
  const conds = [eq(debitNotes.orgId, currentOrgId())];
  if (filters.vendorId) conds.push(eq(debitNotes.vendorId, filters.vendorId));
  if (filters.status) conds.push(eq(debitNotes.status, filters.status));
  if (filters.dateFrom) conds.push(gte(debitNotes.date, filters.dateFrom));
  if (filters.dateTo) conds.push(lte(debitNotes.date, filters.dateTo));

  const rows = await db
    .select({ note: debitNotes, vendor: vendors, bill: bills })
    .from(debitNotes)
    .innerJoin(vendors, eq(debitNotes.vendorId, vendors.id))
    .leftJoin(bills, eq(debitNotes.billId, bills.id))
    .where(and(...conds))
    .orderBy(desc(debitNotes.date), desc(debitNotes.id))
    ;
  return rows.map((r) => ({
    ...r.note,
    vendorName: r.vendor.name,
    billNumber: r.bill?.number ?? null,
  }));
}

export async function getDebitNote(id: number):
  Promise<| (DebitNote & {
      lines: DebitNoteLine[];
      applications: Array<DebitNoteApplication & { billNumber: string }>;
      vendorName: string;
      billNumber: string | null;
    })
  | undefined> {
  const orgId = currentOrgId();
  const note = await db
    .select()
    .from(debitNotes)
    .where(and(eq(debitNotes.id, id), eq(debitNotes.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!note) return undefined;
  const lines = await db.select().from(debitNoteLines).where(eq(debitNoteLines.debitNoteId, id));
  const apps = await db
    .select({ app: debitNoteApplications, bill: bills })
    .from(debitNoteApplications)
    .innerJoin(bills, eq(debitNoteApplications.billId, bills.id))
    .where(eq(debitNoteApplications.debitNoteId, id))
    ;
  const vendor = await db.select().from(vendors).where(eq(vendors.id, note.vendorId)).then((r: any[]) => r[0]);
  const linkedBill = note.billId ? await db.select().from(bills).where(eq(bills.id, note.billId)).then((r: any[]) => r[0]) : undefined;
  return {
    ...note,
    lines,
    applications: apps.map((a) => ({ ...a.app, billNumber: a.bill.number })),
    vendorName: vendor?.name ?? "Unknown",
    billNumber: linkedBill?.number ?? null,
  };
}

export async function vendorDebitBalance(vendorId: number): Promise<{ vendorId: number; debitBalance: number; notes: Array<{ id: number; number: string; remainingDebit: number }> }> {
  const rows = await db
    .select()
    .from(debitNotes)
    .where(
      and(
        eq(debitNotes.orgId, currentOrgId()),
        eq(debitNotes.vendorId, vendorId),
        sql`${debitNotes.status} IN ('sent')`,
        sql`${debitNotes.remainingDebit} > 0`
      )
    )
    ;
  return {
    vendorId,
    debitBalance: rows.reduce((s, n) => s + n.remainingDebit, 0), // exact integer cents
    notes: rows.map((n) => ({ id: n.id, number: n.number, remainingDebit: n.remainingDebit })),
  };
}

// Used by apAging(): every unapplied debit note in the org.
export async function unappliedDebitNotes(): Promise<DebitNote[]> {
  return db
    .select()
    .from(debitNotes)
    .where(
      and(
        eq(debitNotes.orgId, currentOrgId()),
        sql`${debitNotes.status} IN ('sent')`,
        sql`${debitNotes.remainingDebit} > 0`
      )
    )
    ;
}
