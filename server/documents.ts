/**
 * server/documents.ts — printable invoice documents and customer statements.
 * TASK 1: the DOCUMENT currency is threaded through formatMoney() here, so a
 * EUR invoice renders €-amounts while the GL stays base currency. (Documents
 * are print-ready HTML; the browser's print-to-PDF produces the PDF, which
 * keeps the server dependency-free.)
 */
import { db } from "./db.js";
import { formatMoney } from "../shared/money.js";
import { getOrg, getInvoice, HttpError } from "./storage.js";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

const page = (title: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 40px; color: #111; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; }
  td.num, th.num { text-align: right; }
  .totals td { border: none; }
  h1 { font-size: 22px; } .muted { color: #666; }
</style></head><body>${body}</body></html>`;

export function invoiceDocumentHtml(orgId: number, invoiceId: number): string {
  const org = getOrg(orgId);
  const invoice = getInvoice(orgId, invoiceId);
  const customer = db.prepare("SELECT * FROM customers WHERE org_id = ? AND id = ?").get(orgId, invoice.customer_id) as
    | Record<string, unknown>
    | undefined;
  const lines = db.prepare("SELECT * FROM invoice_lines WHERE org_id = ? AND invoice_id = ?").all(orgId, invoiceId) as Array<
    Record<string, unknown>
  >;
  // Document currency: '' sentinel means the org base currency.
  const cur = invoice.currency || org.base_currency;
  const isForeign = invoice.currency !== "";
  const subtotal = isForeign ? invoice.foreign_subtotal : invoice.subtotal;
  const tax = isForeign ? invoice.foreign_tax : invoice.tax;
  const total = isForeign ? invoice.foreign_total : invoice.total;
  const paid = isForeign ? invoice.foreign_amount_paid : invoice.amount_paid;

  const rows = lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td>` +
        `<td class="num">${formatMoney(l.rate as number, cur)}</td><td class="num">${formatMoney(l.amount as number, cur)}</td></tr>`,
    )
    .join("");

  return page(
    `Invoice ${invoice.number}`,
    `<h1>Invoice ${esc(invoice.number)}</h1>
     <p class="muted">${esc(org.name)} &middot; issued ${esc(invoice.date)} &middot; due ${esc(invoice.due_date)}
     ${isForeign ? `&middot; currency ${esc(cur)} @ ${esc(invoice.fx_rate)} ${esc(org.base_currency)}` : ""}</p>
     <p><strong>Bill to:</strong> ${esc(customer?.name)}<br>${esc(customer?.address ?? "")}</p>
     <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
     <tbody>${rows}</tbody></table>
     <table class="totals" style="max-width:320px;margin-left:auto">
       <tr><td>Subtotal</td><td class="num">${formatMoney(subtotal, cur)}</td></tr>
       <tr><td>Tax</td><td class="num">${formatMoney(tax, cur)}</td></tr>
       <tr><td><strong>Total</strong></td><td class="num"><strong>${formatMoney(total, cur)}</strong></td></tr>
       <tr><td>Paid</td><td class="num">${formatMoney(paid, cur)}</td></tr>
       <tr><td><strong>Balance due</strong></td><td class="num"><strong>${formatMoney(total - paid, cur)}</strong></td></tr>
     </table>`,
  );
}

export function customerStatementHtml(orgId: number, customerId: number): string {
  const org = getOrg(orgId);
  const customer = db.prepare("SELECT * FROM customers WHERE org_id = ? AND id = ?").get(orgId, customerId) as
    | { name: string; currency: string | null }
    | undefined;
  if (!customer) throw new HttpError(404, "customer not found");
  const invoices = db
    .prepare("SELECT * FROM invoices WHERE org_id = ? AND customer_id = ? AND status != 'void' ORDER BY date, id")
    .all(orgId, customerId) as Array<Record<string, unknown> & { currency: string }>;

  const rows = invoices
    .map((inv) => {
      const cur = (inv.currency as string) || org.base_currency;
      const isForeign = inv.currency !== "";
      const total = (isForeign ? inv.foreign_total : inv.total) as number;
      const paid = (isForeign ? inv.foreign_amount_paid : inv.amount_paid) as number;
      return `<tr><td>${esc(inv.date)}</td><td>${esc(inv.number)}</td><td>${esc(cur)}</td>
        <td class="num">${formatMoney(total, cur)}</td><td class="num">${formatMoney(paid, cur)}</td>
        <td class="num">${formatMoney(total - paid, cur)}</td><td>${esc(inv.status)}</td></tr>`;
    })
    .join("");

  return page(
    `Statement — ${customer.name}`,
    `<h1>Statement of account</h1>
     <p class="muted">${esc(org.name)} &middot; customer: <strong>${esc(customer.name)}</strong> &middot; generated ${new Date().toISOString().slice(0, 10)}</p>
     <table><thead><tr><th>Date</th><th>Invoice</th><th>Currency</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
     <tbody>${rows || `<tr><td colspan="7" class="muted">No invoices</td></tr>`}</tbody></table>`,
  );
}
