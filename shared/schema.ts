/**
 * shared/schema.ts
 * Single source of truth for validation (Zod) and domain constants.
 * GLOBAL RULES: all money is integer cents; all dates are TEXT "YYYY-MM-DD";
 * every business row is org-scoped by org_id.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Domain constants                                                    */
/* ------------------------------------------------------------------ */

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  "bank",
  "accounts_receivable",
  "current_asset",
  "fixed_asset",
  "accounts_payable",
  "credit_card",
  "current_liability",
  "long_term_liability",
  "equity",
  "sales",
  "other_income",
  "cost_of_goods_sold",
  "operating_expense",
  "other_expense",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const ROLES = ["owner", "admin", "accountant", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** ISO-4217 codes we accept. Extend freely; the GL is always org base currency. */
export const CURRENCY_CODES = [
  "USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CHF", "CNY", "SGD",
  "AED", "NZD", "SEK", "NOK", "DKK", "HKD", "MXN", "BRL", "ZAR", "PLN",
] as const;
export const currencyCode = z.enum(CURRENCY_CODES);
export type CurrencyCode = z.infer<typeof currencyCode>;

export const WEBHOOK_EVENTS = [
  "invoice.created",
  "invoice.paid",
  "invoice.voided",
  "bill.created",
  "bill.paid",
  "credit_note.issued",
  "period.closed",
  "ping",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const ATTACHMENT_ENTITY_TYPES = ["invoice", "bill", "bank_transaction", "journal_entry"] as const;
export const ATTACHMENT_MIME_WHITELIST: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // documented 10 MB limit

/* ------------------------------------------------------------------ */
/* Field primitives                                                    */
/* ------------------------------------------------------------------ */

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(d + "T00:00:00Z")), "invalid calendar date");

export const cents = z.number().int("money must be integer cents");
export const posCents = cents.nonnegative();
export const fxRate = z.number().finite().positive("fx rate must be > 0");

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
  orgName: z.string().min(1).max(120),
  baseCurrency: currencyCode.default("USD"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const mfaEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const mfaDisableSchema = z.object({
  password: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export const mfaVerifySchema = z
  .object({
    mfaToken: z.string().min(10),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(8).max(40).optional(),
  })
  .refine((v) => !!v.code || !!v.recoveryCode, "code or recoveryCode required");

/* ------------------------------------------------------------------ */
/* Master data                                                         */
/* ------------------------------------------------------------------ */

export const insertAccountSchema = z.object({
  code: z.string().regex(/^\d{4}$/, "account code is 4 digits"),
  name: z.string().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES),
});

export const insertCustomerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  shippingCity: z.string().max(120).optional().nullable(),
  shippingState: z.string().max(120).optional().nullable(),
  shippingZip: z.string().max(20).optional().nullable(),
  /** TASK 1: NULL/omitted means "org base currency". */
  currency: currencyCode.optional().nullable(),
});

export const insertVendorSchema = insertCustomerSchema;

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const invoiceLineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().finite().positive(),
  /** unit rate in cents of the DOCUMENT currency */
  rate: posCents,
  accountId: z.number().int().positive(),
  taxRate: z.number().min(0).max(100).default(0),
});

export const insertInvoiceSchema = z.object({
  customerId: z.number().int().positive(),
  date: isoDate,
  dueDate: isoDate,
  number: z.string().max(40).optional(),
  lines: z.array(invoiceLineSchema).min(1),
  /** TASK 1: optional document currency; fxRate required when != org base */
  currency: currencyCode.optional(),
  fxRate: fxRate.optional(),
});

export const insertBillSchema = z.object({
  vendorId: z.number().int().positive(),
  date: isoDate,
  dueDate: isoDate,
  number: z.string().max(40).optional(),
  lines: z.array(invoiceLineSchema).min(1),
  currency: currencyCode.optional(),
  fxRate: fxRate.optional(),
});

export const paymentSchema = z.object({
  date: isoDate,
  /** base-currency cents; for FX documents pass foreignAmount + fxRate instead */
  amount: posCents.optional(),
  bankAccountId: z.number().int().positive(),
  /** TASK 1: foreign cents applied to an FX document */
  foreignAmount: posCents.optional(),
  fxRate: fxRate.optional(),
});

export const insertCreditNoteSchema = z.object({
  customerId: z.number().int().positive(),
  invoiceId: z.number().int().positive().optional().nullable(),
  date: isoDate,
  lines: z.array(invoiceLineSchema).min(1),
});

/* ------------------------------------------------------------------ */
/* TASK 1: FX rates                                                    */
/* ------------------------------------------------------------------ */

export const fxRateUpsertSchema = z.object({
  date: isoDate,
  fromCode: currencyCode,
  toCode: currencyCode,
  rate: fxRate,
  source: z.string().max(60).default("manual"),
});
export const fxRatesPutSchema = z.object({ rates: z.array(fxRateUpsertSchema).min(1).max(1000) });

/* ------------------------------------------------------------------ */
/* TASK 4d: Budgets                                                    */
/* ------------------------------------------------------------------ */

export const insertBudgetSchema = z.object({
  name: z.string().min(1).max(120),
  fiscalYear: z.number().int().min(1900).max(3000),
});

export const budgetLineSchema = z.object({
  accountId: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  amount: cents, // cents; income budgets positive = expected income
});
export const putBudgetLinesSchema = z.object({ lines: z.array(budgetLineSchema).max(2400) });

/* ------------------------------------------------------------------ */
/* TASK 6: Webhooks                                                    */
/* ------------------------------------------------------------------ */

export const insertWebhookSchema = z.object({
  url: z.string().url().max(2000).refine((u) => u.startsWith("http://") || u.startsWith("https://"), "http(s) only"),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  isActive: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* TASK 5: Import                                                      */
/* ------------------------------------------------------------------ */

export const openingBalanceMetaSchema = z.object({
  asOfDate: isoDate,
});

export interface ImportRowError {
  row: number;
  message: string;
}
export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: ImportRowError[];
  dryRun: boolean;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export const auditQuerySchema = z.object({
  entityType: z.string().max(60).optional(),
  entityId: z.coerce.number().int().optional(),
  userId: z.coerce.number().int().optional(),
  action: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(["json", "csv"]).default("json"),
});

export const reportRangeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

export const budgetVsActualQuerySchema = reportRangeSchema.extend({
  budgetId: z.coerce.number().int().positive(),
});
