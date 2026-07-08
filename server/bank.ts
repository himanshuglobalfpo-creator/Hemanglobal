/**
 * server/bank.ts — Phase 5: bank reconciliation engine.
 *
 * Model: statement lines live in bank_transactions (signed cents, + = money
 * in). Clearing links them to journal entries via bank_matches — one line
 * can clear many entries (one deposit covering several invoice payments).
 * A match requires the entries' NET movement on that bank account to equal
 * the statement amount exactly; anything else stays unmatched and shows up
 * in the reconciliation report as an outstanding item.
 *
 * Reconciliation identity (the classic one):
 *   statement ending balance
 *     + deposits in transit  (ledger debits not yet on the statement)
 *     - outstanding checks   (ledger credits not yet on the statement)
 *     = ledger balance
 * equivalently: difference = statementEndingBalance - clearedBalance.
 */
import crypto from "node:crypto";
import { db } from "./db.js";
import { HttpError, accountById, audit, assertPeriodOpen, postJournalEntry } from "./storage.js";

export interface BankTxRow {
  id: number;
  org_id: number;
  account_id: number;
  date: string;
  description: string;
  amount: number;
  status: string;
}

export function bankImportHash(accountId: number, date: string, amount: number, description: string): string {
  return crypto
    .createHash("sha256")
    .update(`${accountId}|${date}|${amount}|${description.trim().toLowerCase()}`)
    .digest("hex");
}

function getBankTx(orgId: number, txId: number): BankTxRow {
  const tx = db.prepare("SELECT * FROM bank_transactions WHERE org_id = ? AND id = ?").get(orgId, txId) as
    | BankTxRow
    | undefined;
  if (!tx) throw new HttpError(404, "bank transaction not found");
  return tx;
}

/** Net ledger movement of one journal entry on one bank account (signed). */
function entryBankAmount(orgId: number, accountId: number, entryId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(debit - credit), 0) AS n FROM journal_lines WHERE org_id = ? AND entry_id = ? AND account_id = ?",
    )
    .get(orgId, entryId, accountId) as { n: number };
  return row.n;
}

function entryAlreadyCleared(orgId: number, accountId: number, entryId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM bank_matches bm JOIN bank_transactions bt ON bt.id = bm.bank_transaction_id
       WHERE bm.org_id = ? AND bm.entry_id = ? AND bt.account_id = ?`,
    )
    .get(orgId, entryId, accountId);
}

/* --------------------------- suggestions --------------------------- */

export interface MatchSuggestion {
  bankTransactionId: number;
  date: string;
  description: string;
  amount: number;
  candidates: Array<{ entryId: number; date: string; memo: string; amount: number }>;
}

/** Exact-amount candidates within ±7 days for every unmatched line. */
export function suggestMatches(orgId: number, accountId: number): MatchSuggestion[] {
  const txs = db
    .prepare(
      "SELECT * FROM bank_transactions WHERE org_id = ? AND account_id = ? AND status = 'unmatched' ORDER BY date, id",
    )
    .all(orgId, accountId) as BankTxRow[];
  const candStmt = db.prepare(
    `SELECT je.id AS entryId, je.date, je.memo, SUM(jl.debit - jl.credit) AS amount
     FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id AND jl.org_id = je.org_id
     WHERE je.org_id = ? AND jl.account_id = ?
       AND je.date BETWEEN date(?, '-7 days') AND date(?, '+7 days')
       AND NOT EXISTS (
         SELECT 1 FROM bank_matches bm JOIN bank_transactions bt ON bt.id = bm.bank_transaction_id
         WHERE bm.entry_id = je.id AND bt.account_id = ?
       )
     GROUP BY je.id HAVING amount = ?`,
  );
  return txs.map((tx) => ({
    bankTransactionId: tx.id,
    date: tx.date,
    description: tx.description,
    amount: tx.amount,
    candidates: candStmt.all(orgId, accountId, tx.date, tx.date, accountId, tx.amount) as MatchSuggestion["candidates"],
  }));
}

/* ----------------------------- matching ---------------------------- */

export function matchBankTransaction(orgId: number, userId: number, txId: number, entryIds: number[]): void {
  const tx = getBankTx(orgId, txId);
  if (tx.status !== "unmatched") throw new HttpError(409, `transaction is ${tx.status}`);
  if (entryIds.length === 0) throw new HttpError(400, "entryIds required");
  if (new Set(entryIds).size !== entryIds.length) throw new HttpError(400, "duplicate entryIds");

  let sum = 0;
  for (const entryId of entryIds) {
    const entry = db.prepare("SELECT 1 FROM journal_entries WHERE org_id = ? AND id = ?").get(orgId, entryId);
    if (!entry) throw new HttpError(404, `journal entry ${entryId} not found`);
    if (entryAlreadyCleared(orgId, tx.account_id, entryId)) {
      throw new HttpError(409, `journal entry ${entryId} is already cleared against this account`);
    }
    const amount = entryBankAmount(orgId, tx.account_id, entryId);
    if (amount === 0) throw new HttpError(400, `journal entry ${entryId} has no movement on this bank account`);
    sum += amount;
  }
  if (sum !== tx.amount) {
    throw new HttpError(
      400,
      `entries net ${(sum / 100).toFixed(2)} but statement line is ${(tx.amount / 100).toFixed(2)} — amounts must match exactly`,
    );
  }
  const run = db.transaction(() => {
    const ins = db.prepare("INSERT INTO bank_matches (org_id, bank_transaction_id, entry_id) VALUES (?,?,?)");
    for (const entryId of entryIds) ins.run(orgId, tx.id, entryId);
    db.prepare("UPDATE bank_transactions SET status = 'matched', reconciled = 1 WHERE id = ? AND org_id = ?").run(tx.id, orgId);
    audit(orgId, userId, "match", "bank_transaction", tx.id, `Matched ${tx.date} ${(tx.amount / 100).toFixed(2)} to JE ${entryIds.join(",")}`);
  });
  run();
}

export function unmatchBankTransaction(orgId: number, userId: number, txId: number): void {
  const tx = getBankTx(orgId, txId);
  const run = db.transaction(() => {
    db.prepare("DELETE FROM bank_matches WHERE org_id = ? AND bank_transaction_id = ?").run(orgId, txId);
    db.prepare("UPDATE bank_transactions SET status = 'unmatched', reconciled = 0 WHERE id = ? AND org_id = ?").run(txId, orgId);
    audit(orgId, userId, "unmatch", "bank_transaction", txId, `Unmatched ${tx.date} ${(tx.amount / 100).toFixed(2)}`);
  });
  run();
}

/** Mark a duplicate/erroneous statement line so reconciliation ignores it. */
export function excludeBankTransaction(orgId: number, userId: number, txId: number): void {
  const tx = getBankTx(orgId, txId);
  if (tx.status === "matched") throw new HttpError(409, "unmatch before excluding");
  db.prepare("UPDATE bank_transactions SET status = 'excluded' WHERE id = ? AND org_id = ?").run(txId, orgId);
  audit(orgId, userId, "exclude", "bank_transaction", txId, `Excluded ${tx.date} ${(tx.amount / 100).toFixed(2)} ${tx.description}`);
}

/* --------------------------- categorize ---------------------------- */

export interface SplitLine {
  accountId: number;
  /** signed cents in the SAME sign space as the statement amount; must sum to it */
  amount: number;
}

/**
 * Create the journal entry a statement line represents and clear it in one
 * step. Splits let one line hit several accounts — e.g. a card settlement of
 * +$96.80 categorized as sales +$100.00 and merchant fees -$3.20, or a
 * transfer out of -$250.00 split entirely to the other bank account.
 * JE construction: bank line takes the statement side (DR when money in);
 * each split posts the opposite side for positive amounts and the same side
 * for negative amounts, so the entry always balances by construction.
 */
export function categorizeBankTransaction(orgId: number, userId: number, txId: number, memo: string, splits: SplitLine[]): number {
  const tx = getBankTx(orgId, txId);
  if (tx.status !== "unmatched") throw new HttpError(409, `transaction is ${tx.status}`);
  if (splits.length === 0) throw new HttpError(400, "at least one split required");
  assertPeriodOpen(orgId, tx.date);
  const total = splits.reduce((s, l) => s + l.amount, 0);
  if (total !== tx.amount) {
    throw new HttpError(400, `splits sum to ${(total / 100).toFixed(2)} but the statement line is ${(tx.amount / 100).toFixed(2)}`);
  }
  const lines = [
    { accountId: tx.account_id, debit: Math.max(tx.amount, 0), credit: Math.max(-tx.amount, 0) },
  ];
  for (const s of splits) {
    if (s.amount === 0) throw new HttpError(400, "split amounts must be non-zero");
    if (!accountById(orgId, s.accountId)) throw new HttpError(400, `split account ${s.accountId} not in org`);
    if (s.accountId === tx.account_id) throw new HttpError(400, "split cannot target the same bank account");
    // Uniform counterpart rule (independent of the statement line's sign):
    // a positive split posts a CREDIT, a negative split posts a DEBIT.
    // Proof it balances: bank line net = tx.amount (debit-positive); split
    // net = -Σ(s.amount) = -tx.amount, so every entry sums to zero.
    lines.push({ accountId: s.accountId, debit: s.amount < 0 ? -s.amount : 0, credit: s.amount > 0 ? s.amount : 0 });
  }
  const run = db.transaction((): number => {
    const entryId = postJournalEntry(orgId, tx.date, memo || `Bank: ${tx.description}`, "bank_categorize", tx.id, lines);
    db.prepare("INSERT INTO bank_matches (org_id, bank_transaction_id, entry_id) VALUES (?,?,?)").run(orgId, tx.id, entryId);
    db.prepare("UPDATE bank_transactions SET status = 'matched', reconciled = 1 WHERE id = ? AND org_id = ?").run(tx.id, orgId);
    audit(orgId, userId, "categorize", "bank_transaction", tx.id, `Categorized ${(tx.amount / 100).toFixed(2)} into ${splits.length} split(s)`);
    return entryId;
  });
  return run();
}

/* -------------------------- reconciliation ------------------------- */

export interface OutstandingItem {
  entryId: number;
  date: string;
  memo: string;
  source: string;
  amount: number; // signed ledger movement on the bank account
}

export interface ReconciliationReport {
  accountId: number;
  statementDate: string;
  statementEndingBalance: number;
  ledgerBalance: number;
  clearedBalance: number;
  depositsInTransit: number;
  outstandingChecks: number;
  outstandingItems: OutstandingItem[];
  unmatchedBankLines: Array<{ id: number; date: string; description: string; amount: number }>;
  difference: number;
  reconciled: boolean;
}

export function reconcileAccount(
  orgId: number,
  userId: number,
  accountId: number,
  statementDate: string,
  statementEndingBalance: number,
  complete: boolean,
): ReconciliationReport {
  const acct = accountById(orgId, accountId);
  if (!acct || acct.subtype !== "bank") throw new HttpError(400, "accountId must be a bank account in this org");

  const ledgerBalance = (db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS n FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
       WHERE jl.org_id = ? AND jl.account_id = ? AND je.date <= ?`,
    )
    .get(orgId, accountId, statementDate) as { n: number }).n;

  // Ledger entries through the statement date not yet cleared by any
  // statement line: money out = outstanding checks, money in = deposits in
  // transit. A voided check appears as +check/-reversal and nets to zero.
  const outstanding = db
    .prepare(
      `SELECT je.id AS entryId, je.date, je.memo, je.source, SUM(jl.debit - jl.credit) AS amount
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id AND jl.org_id = je.org_id
       WHERE je.org_id = ? AND jl.account_id = ? AND je.date <= ?
         AND NOT EXISTS (
           SELECT 1 FROM bank_matches bm JOIN bank_transactions bt ON bt.id = bm.bank_transaction_id
           WHERE bm.entry_id = je.id AND bt.account_id = ?
         )
       GROUP BY je.id HAVING amount != 0 ORDER BY je.date, je.id`,
    )
    .all(orgId, accountId, statementDate, accountId) as OutstandingItem[];

  const depositsInTransit = outstanding.filter((o) => o.amount > 0).reduce((s, o) => s + o.amount, 0);
  const outstandingChecks = outstanding.filter((o) => o.amount < 0).reduce((s, o) => s - o.amount, 0);
  const clearedBalance = ledgerBalance - depositsInTransit + outstandingChecks;

  const unmatchedBankLines = db
    .prepare(
      `SELECT id, date, description, amount FROM bank_transactions
       WHERE org_id = ? AND account_id = ? AND status = 'unmatched' AND date <= ? ORDER BY date, id`,
    )
    .all(orgId, accountId, statementDate) as ReconciliationReport["unmatchedBankLines"];

  const difference = statementEndingBalance - clearedBalance;
  const reconciled = difference === 0;

  if (complete) {
    if (!reconciled) throw new HttpError(409, `cannot complete: difference of ${(difference / 100).toFixed(2)} remains`);
    db.prepare(
      `INSERT INTO reconciliations (org_id, account_id, statement_date, statement_ending_balance, cleared_balance, difference, completed_by)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(orgId, accountId, statementDate, statementEndingBalance, clearedBalance, difference, userId);
    audit(orgId, userId, "reconcile", "bank_transaction", accountId, `Reconciled ${acct.code} through ${statementDate} at ${(statementEndingBalance / 100).toFixed(2)}`);
  }

  return {
    accountId, statementDate, statementEndingBalance, ledgerBalance, clearedBalance,
    depositsInTransit, outstandingChecks, outstandingItems: outstanding,
    unmatchedBankLines, difference, reconciled,
  };
}
