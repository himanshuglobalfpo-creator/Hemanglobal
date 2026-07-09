// PDF generation helpers using pdfkit. Each helper returns a Buffer the route can pipe.
import PDFDocument from "pdfkit";
import type { Response } from "express";

// All ledger money arrives as INTEGER CENTS — fmt() is the display boundary.
import { formatMoney } from "@shared/money";
const fmt = formatMoney;
// Line `rate` is a dollar unit-price input (may be sub-cent, e.g. $0.0025) —
// it is NOT cents, so it gets its own formatter with up to 4 decimals.
function fmtRate(dollars: number): string {
  return "$" + dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function streamPdf(res: Response, doc: PDFKit.PDFDocument, filename: string) {
  // Sanitize filename: strip CR/LF (header injection), quotes, and any non-printable / path chars.
  const safe = filename
    .replace(/[\r\n"\\\/]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")    // strip non-ASCII to keep the legacy header valid
    .slice(0, 120) || "document.pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${safe}"`);
  doc.pipe(res);
  doc.end();
}

const BRAND = "LedgerLite";
const ACCENT = "#1E8E5E"; // matches primary green
const MUTED = "#6B7280";
const TEXT = "#0F172A";

function header(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  doc
    .fillColor(ACCENT)
    .fontSize(20)
    .font("Helvetica-Bold")
    .text(BRAND, 50, 50);
  doc
    .fillColor(TEXT)
    .fontSize(16)
    .font("Helvetica-Bold")
    .text(title, 50, 80);
  if (subtitle) {
    doc
      .fillColor(MUTED)
      .fontSize(10)
      .font("Helvetica")
      .text(subtitle, 50, 102);
  }
  doc.moveTo(50, 125).lineTo(545, 125).strokeColor("#E5E7EB").lineWidth(1).stroke();
  doc.y = 140;
}

function row(
  doc: PDFKit.PDFDocument,
  cols: Array<{ text: string; width: number; align?: "left" | "right" | "center"; bold?: boolean }>,
  y: number,
  opts: { fontSize?: number; color?: string; topPad?: number } = {}
): number {
  const fontSize = opts.fontSize ?? 10;
  const color = opts.color ?? TEXT;
  let x = 50;
  for (const c of cols) {
    doc
      .fillColor(color)
      .fontSize(fontSize)
      .font(c.bold ? "Helvetica-Bold" : "Helvetica")
      .text(c.text, x, y, { width: c.width, align: c.align ?? "left" });
    x += c.width;
  }
  return y + fontSize + 6;
}

function footerNote(doc: PDFKit.PDFDocument, note: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .font("Helvetica")
      .text(note, 50, 770, { width: 495, align: "center" });
  }
}

// ============================================================================
// INVOICE PDF
// ============================================================================
export function streamInvoicePdf(
  res: Response,
  data: {
    invoice: {
      number: string; date: string; dueDate: string; subtotal: number; tax: number; total: number; amountPaid: number; status: string; notes: string | null;
      // Multi-currency: when currency is set, the header figures below are
      // replaced by the foreign_* amounts and every money cell renders in the
      // DOCUMENT currency. Line rows already store document-currency cents.
      currency?: string;
      foreignSubtotal?: number; foreignTax?: number; foreignTotal?: number; foreignAmountPaid?: number;
    };
    customer: { name: string; email: string | null; address: string | null };
    lines: Array<{ description: string; quantity: number; rate: number; amount: number }>;
  }
) {
  const docCurrency = data.invoice.currency || "USD";
  const money = (c: number) => fmt(c, docCurrency);
  if (data.invoice.currency) {
    data = {
      ...data,
      invoice: {
        ...data.invoice,
        subtotal: data.invoice.foreignSubtotal ?? data.invoice.subtotal,
        tax: data.invoice.foreignTax ?? data.invoice.tax,
        total: data.invoice.foreignTotal ?? data.invoice.total,
        amountPaid: data.invoice.foreignAmountPaid ?? data.invoice.amountPaid,
      },
    };
  }
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  header(doc, `Invoice ${data.invoice.number}`, `Issued ${data.invoice.date}  ·  Due ${data.invoice.dueDate}`);

  // Bill To block
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("BILL TO", 50, doc.y);
  doc.fillColor(TEXT).fontSize(11).font("Helvetica-Bold").text(data.customer.name, 50, doc.y + 2);
  if (data.customer.email) doc.fontSize(10).font("Helvetica").text(data.customer.email);
  if (data.customer.address) doc.text(data.customer.address);
  doc.moveDown(1);

  // Line items table header
  let y = doc.y + 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DESCRIPTION", width: 250, bold: true },
      { text: "QTY", width: 50, align: "right", bold: true },
      { text: "RATE", width: 90, align: "right", bold: true },
      { text: "AMOUNT", width: 105, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );

  for (const l of data.lines) {
    y = row(
      doc,
      [
        { text: l.description, width: 250 },
        { text: String(l.quantity), width: 50, align: "right" },
        { text: fmtRate(l.rate), width: 90, align: "right" },
        { text: money(l.amount), width: 105, align: "right" },
      ],
      y
    );
  }

  y += 10;
  doc.moveTo(330, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;

  const totalsRows: Array<[string, number, boolean]> = [
    ["Subtotal", data.invoice.subtotal, false],
    ["Tax", data.invoice.tax, false],
    ["Total", data.invoice.total, true],
    ["Paid", data.invoice.amountPaid, false],
    ["Balance Due", data.invoice.total - data.invoice.amountPaid, true], // exact cents
  ];
  for (const [label, amount, bold] of totalsRows) {
    y = row(
      doc,
      [
        { text: "", width: 280 },
        { text: label, width: 110, align: "right", bold },
        { text: money(amount), width: 105, align: "right", bold },
      ],
      y,
      { fontSize: bold ? 11 : 10 }
    );
    if (bold) {
      doc.moveTo(330, y - 2).lineTo(545, y - 2).strokeColor("#E5E7EB").stroke();
    }
  }

  if (data.invoice.notes) {
    y += 12;
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("NOTES", 50, y);
    doc.fillColor(TEXT).fontSize(10).text(data.invoice.notes, 50, y + 14, { width: 495 });
  }

  footerNote(doc, "Thank you for your business — generated by LedgerLite");
  streamPdf(res, doc, `invoice-${data.invoice.number}.pdf`);
}

// ============================================================================
// BILL PDF
// ============================================================================
export function streamBillPdf(
  res: Response,
  data: {
    bill: {
      number: string; date: string; dueDate: string; subtotal: number; tax: number; total: number; amountPaid: number; status: string; notes: string | null;
      currency?: string;
      foreignSubtotal?: number; foreignTax?: number; foreignTotal?: number; foreignAmountPaid?: number;
    };
    vendor: { name: string; email: string | null; address: string | null };
    lines: Array<{ description: string; quantity: number; rate: number; amount: number }>;
  }
) {
  const docCurrency = data.bill.currency || "USD";
  const money = (c: number) => fmt(c, docCurrency);
  if (data.bill.currency) {
    data = {
      ...data,
      bill: {
        ...data.bill,
        subtotal: data.bill.foreignSubtotal ?? data.bill.subtotal,
        tax: data.bill.foreignTax ?? data.bill.tax,
        total: data.bill.foreignTotal ?? data.bill.total,
        amountPaid: data.bill.foreignAmountPaid ?? data.bill.amountPaid,
      },
    };
  }
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  header(doc, `Bill ${data.bill.number}`, `Received ${data.bill.date}  ·  Due ${data.bill.dueDate}`);

  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("VENDOR", 50, doc.y);
  doc.fillColor(TEXT).fontSize(11).font("Helvetica-Bold").text(data.vendor.name, 50, doc.y + 2);
  if (data.vendor.email) doc.fontSize(10).font("Helvetica").text(data.vendor.email);
  if (data.vendor.address) doc.text(data.vendor.address);
  doc.moveDown(1);

  let y = doc.y + 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DESCRIPTION", width: 250, bold: true },
      { text: "QTY", width: 50, align: "right", bold: true },
      { text: "RATE", width: 90, align: "right", bold: true },
      { text: "AMOUNT", width: 105, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );
  for (const l of data.lines) {
    y = row(
      doc,
      [
        { text: l.description, width: 250 },
        { text: String(l.quantity), width: 50, align: "right" },
        { text: fmtRate(l.rate), width: 90, align: "right" },
        { text: money(l.amount), width: 105, align: "right" },
      ],
      y
    );
  }

  y += 10;
  doc.moveTo(330, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;
  const totalsRows: Array<[string, number, boolean]> = [
    ["Subtotal", data.bill.subtotal, false],
    ["Tax", data.bill.tax, false],
    ["Total", data.bill.total, true],
    ["Paid", data.bill.amountPaid, false],
    ["Balance Due", data.bill.total - data.bill.amountPaid, true], // exact cents
  ];
  for (const [label, amount, bold] of totalsRows) {
    y = row(
      doc,
      [
        { text: "", width: 280 },
        { text: label, width: 110, align: "right", bold },
        { text: money(amount), width: 105, align: "right", bold },
      ],
      y,
      { fontSize: bold ? 11 : 10 }
    );
    if (bold) {
      doc.moveTo(330, y - 2).lineTo(545, y - 2).strokeColor("#E5E7EB").stroke();
    }
  }

  if (data.bill.notes) {
    y += 12;
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("NOTES", 50, y);
    doc.fillColor(TEXT).fontSize(10).text(data.bill.notes, 50, y + 14, { width: 495 });
  }

  footerNote(doc, "Generated by LedgerLite");
  streamPdf(res, doc, `bill-${data.bill.number}.pdf`);
}

// ============================================================================
// CUSTOMER STATEMENT PDF
// ============================================================================
// NOTE (multi-currency): statements aggregate documents that may be in mixed
// currencies; all figures here are the org BASE currency carrying amounts —
// the only coherent unit for a cross-document running balance.
export function streamCustomerStatementPdf(
  res: Response,
  data: {
    customer: { name: string; email: string | null; address: string | null };
    fromDate: string;
    toDate: string;
    openingBalance: number;
    activity: Array<{ date: string; type: string; reference: string; description: string; charge: number; payment: number; balance: number }>;
    totalCharges: number;
    totalPayments: number;
    closingBalance: number;
  }
) {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  header(doc, `Statement for ${data.customer.name}`, `Period ${data.fromDate} \u2014 ${data.toDate}`);

  let y = doc.y;
  if (data.customer.email) {
    doc.fillColor(MUTED).fontSize(10).font("Helvetica").text(data.customer.email, 50, y);
    y += 14;
  }
  if (data.customer.address) {
    doc.fillColor(MUTED).fontSize(10).font("Helvetica").text(data.customer.address, 50, y);
    y += 14;
  }

  y += 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DATE", width: 70, bold: true },
      { text: "REF", width: 80, bold: true },
      { text: "DESCRIPTION", width: 195, bold: true },
      { text: "CHARGE", width: 70, align: "right", bold: true },
      { text: "PAYMENT", width: 70, align: "right", bold: true },
      { text: "BALANCE", width: 80, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );

  // Opening
  y = row(
    doc,
    [
      { text: data.fromDate, width: 70 },
      { text: "—", width: 80 },
      { text: "Opening balance", width: 195, bold: true },
      { text: "", width: 70, align: "right" },
      { text: "", width: 70, align: "right" },
      { text: fmt(data.openingBalance), width: 80, align: "right", bold: true },
    ],
    y
  );

  for (const a of data.activity) {
    y = row(
      doc,
      [
        { text: a.date, width: 70 },
        { text: a.reference, width: 80 },
        { text: a.description, width: 195 },
        { text: a.charge ? fmt(a.charge) : "", width: 70, align: "right" },
        { text: a.payment ? fmt(a.payment) : "", width: 70, align: "right" },
        { text: fmt(a.balance), width: 80, align: "right" },
      ],
      y
    );
    if (y > 720) {
      doc.addPage();
      y = 50;
    }
  }

  y += 10;
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;

  y = row(
    doc,
    [
      { text: "Totals", width: 345, align: "right", bold: true },
      { text: fmt(data.totalCharges), width: 70, align: "right", bold: true },
      { text: fmt(data.totalPayments), width: 70, align: "right", bold: true },
      { text: fmt(data.closingBalance), width: 80, align: "right", bold: true },
    ],
    y,
    { fontSize: 11 }
  );

  footerNote(doc, "Generated by LedgerLite");
  streamPdf(res, doc, `statement-${data.customer.name.replace(/\s+/g, "-")}.pdf`);
}

// ============================================================================
// VENDOR STATEMENT PDF
// ============================================================================
// NOTE (multi-currency): base-currency carrying amounts (see customer note).
export function streamVendorStatementPdf(
  res: Response,
  data: {
    vendor: { name: string; email: string | null; address: string | null };
    fromDate: string;
    toDate: string;
    openingBalance: number;
    activity: Array<{ date: string; type: string; reference: string; description: string; charge: number; payment: number; balance: number }>;
    totalCharges: number;
    totalPayments: number;
    closingBalance: number;
  }
) {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  header(doc, `Statement \u2014 ${data.vendor.name}`, `Period ${data.fromDate} \u2014 ${data.toDate}`);

  let y = doc.y;
  if (data.vendor.email) {
    doc.fillColor(MUTED).fontSize(10).font("Helvetica").text(data.vendor.email, 50, y);
    y += 14;
  }

  y += 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DATE", width: 70, bold: true },
      { text: "REF", width: 80, bold: true },
      { text: "DESCRIPTION", width: 195, bold: true },
      { text: "BILL", width: 70, align: "right", bold: true },
      { text: "PAYMENT", width: 70, align: "right", bold: true },
      { text: "BALANCE", width: 80, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );

  y = row(
    doc,
    [
      { text: data.fromDate, width: 70 },
      { text: "—", width: 80 },
      { text: "Opening balance", width: 195, bold: true },
      { text: "", width: 70, align: "right" },
      { text: "", width: 70, align: "right" },
      { text: fmt(data.openingBalance), width: 80, align: "right", bold: true },
    ],
    y
  );

  for (const a of data.activity) {
    y = row(
      doc,
      [
        { text: a.date, width: 70 },
        { text: a.reference, width: 80 },
        { text: a.description, width: 195 },
        { text: a.charge ? fmt(a.charge) : "", width: 70, align: "right" },
        { text: a.payment ? fmt(a.payment) : "", width: 70, align: "right" },
        { text: fmt(a.balance), width: 80, align: "right" },
      ],
      y
    );
    if (y > 720) {
      doc.addPage();
      y = 50;
    }
  }

  y += 10;
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;
  y = row(
    doc,
    [
      { text: "Totals", width: 345, align: "right", bold: true },
      { text: fmt(data.totalCharges), width: 70, align: "right", bold: true },
      { text: fmt(data.totalPayments), width: 70, align: "right", bold: true },
      { text: fmt(data.closingBalance), width: 80, align: "right", bold: true },
    ],
    y,
    { fontSize: 11 }
  );

  footerNote(doc, "Generated by LedgerLite");
  streamPdf(res, doc, `vendor-statement-${data.vendor.name.replace(/\s+/g, "-")}.pdf`);
}

// ============================================================================
// CREDIT NOTE PDF
// ============================================================================
export function streamCreditNotePdf(
  res: Response,
  data: {
    note: { number: string; date: string; status: string; reason: string; subtotal: number; tax: number; total: number; appliedAmount: number; remainingCredit: number; notes: string | null };
    customer: { name: string; email: string | null; address: string | null };
    invoiceNumber: string | null; // original invoice this credit is against
    lines: Array<{ description: string; quantity: number; rate: number; amount: number }>;
  }
) {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  const sub = data.invoiceNumber
    ? `Issued ${data.note.date}  ·  Against invoice ${data.invoiceNumber}`
    : `Issued ${data.note.date}`;
  header(doc, `Credit Note ${data.note.number}`, sub);

  // Credit To block
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("CREDIT TO", 50, doc.y);
  doc.fillColor(TEXT).fontSize(11).font("Helvetica-Bold").text(data.customer.name, 50, doc.y + 2);
  if (data.customer.email) doc.fontSize(10).font("Helvetica").text(data.customer.email);
  if (data.customer.address) doc.text(data.customer.address);
  doc.moveDown(0.6);

  // Reason — required on every credit note
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("REASON", 50, doc.y + 4);
  doc.fillColor(TEXT).fontSize(10).font("Helvetica").text(data.note.reason, 50, doc.y + 2, { width: 495 });
  doc.moveDown(1);

  // Line items
  let y = doc.y + 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DESCRIPTION", width: 250, bold: true },
      { text: "QTY", width: 50, align: "right", bold: true },
      { text: "RATE", width: 90, align: "right", bold: true },
      { text: "AMOUNT", width: 105, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );
  for (const l of data.lines) {
    y = row(
      doc,
      [
        { text: l.description, width: 250 },
        { text: String(l.quantity), width: 50, align: "right" },
        { text: fmtRate(l.rate), width: 90, align: "right" },
        { text: fmt(l.amount), width: 105, align: "right" },
      ],
      y
    );
  }

  y += 10;
  doc.moveTo(330, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;

  const totalsRows: Array<[string, number, boolean]> = [
    ["Subtotal", data.note.subtotal, false],
    ["Tax", data.note.tax, false],
    ["Total Credit", data.note.total, true],
    ["Applied to Invoices", data.note.appliedAmount, false],
    ["Remaining Credit", data.note.remainingCredit, true],
  ];
  for (const [label, amount, bold] of totalsRows) {
    y = row(
      doc,
      [
        { text: "", width: 280 },
        { text: label, width: 110, align: "right", bold },
        { text: fmt(amount), width: 105, align: "right", bold },
      ],
      y,
      { fontSize: bold ? 11 : 10 }
    );
    if (bold) {
      doc.moveTo(330, y - 2).lineTo(545, y - 2).strokeColor("#E5E7EB").stroke();
    }
  }

  if (data.note.notes) {
    y += 12;
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("NOTES", 50, y);
    doc.fillColor(TEXT).fontSize(10).text(data.note.notes, 50, y + 14, { width: 495 });
  }

  footerNote(doc, "Credit note — reduces the balance owed to us · generated by LedgerLite");
  streamPdf(res, doc, `credit-note-${data.note.number}.pdf`);
}

// ============================================================================
// DEBIT NOTE PDF
// ============================================================================
export function streamDebitNotePdf(
  res: Response,
  data: {
    note: { number: string; date: string; status: string; reason: string; subtotal: number; tax: number; total: number; appliedAmount: number; remainingDebit: number; notes: string | null };
    vendor: { name: string; email: string | null; address: string | null };
    billNumber: string | null;
    lines: Array<{ description: string; quantity: number; rate: number; amount: number }>;
  }
) {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  const sub = data.billNumber
    ? `Issued ${data.note.date}  ·  Against bill ${data.billNumber}`
    : `Issued ${data.note.date}`;
  header(doc, `Debit Note ${data.note.number}`, sub);

  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("TO VENDOR", 50, doc.y);
  doc.fillColor(TEXT).fontSize(11).font("Helvetica-Bold").text(data.vendor.name, 50, doc.y + 2);
  if (data.vendor.email) doc.fontSize(10).font("Helvetica").text(data.vendor.email);
  if (data.vendor.address) doc.text(data.vendor.address);
  doc.moveDown(0.6);

  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("REASON", 50, doc.y + 4);
  doc.fillColor(TEXT).fontSize(10).font("Helvetica").text(data.note.reason, 50, doc.y + 2, { width: 495 });
  doc.moveDown(1);

  let y = doc.y + 6;
  doc.rect(50, y - 4, 495, 22).fillColor("#F3F4F6").fill();
  y = row(
    doc,
    [
      { text: "DESCRIPTION", width: 250, bold: true },
      { text: "QTY", width: 50, align: "right", bold: true },
      { text: "RATE", width: 90, align: "right", bold: true },
      { text: "AMOUNT", width: 105, align: "right", bold: true },
    ],
    y,
    { fontSize: 9, color: MUTED }
  );
  for (const l of data.lines) {
    y = row(
      doc,
      [
        { text: l.description, width: 250 },
        { text: String(l.quantity), width: 50, align: "right" },
        { text: fmtRate(l.rate), width: 90, align: "right" },
        { text: fmt(l.amount), width: 105, align: "right" },
      ],
      y
    );
  }

  y += 10;
  doc.moveTo(330, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
  y += 8;

  const totalsRows: Array<[string, number, boolean]> = [
    ["Subtotal", data.note.subtotal, false],
    ["Tax", data.note.tax, false],
    ["Total Debit", data.note.total, true],
    ["Applied to Bills", data.note.appliedAmount, false],
    ["Remaining Debit", data.note.remainingDebit, true],
  ];
  for (const [label, amount, bold] of totalsRows) {
    y = row(
      doc,
      [
        { text: "", width: 280 },
        { text: label, width: 110, align: "right", bold },
        { text: fmt(amount), width: 105, align: "right", bold },
      ],
      y,
      { fontSize: bold ? 11 : 10 }
    );
    if (bold) {
      doc.moveTo(330, y - 2).lineTo(545, y - 2).strokeColor("#E5E7EB").stroke();
    }
  }

  if (data.note.notes) {
    y += 12;
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("NOTES", 50, y);
    doc.fillColor(TEXT).fontSize(10).text(data.note.notes, 50, y + 14, { width: 495 });
  }

  footerNote(doc, "Debit note — reduces the balance we owe · generated by LedgerLite");
  streamPdf(res, doc, `debit-note-${data.note.number}.pdf`);
}
