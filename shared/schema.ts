import { pgTable, text, integer, bigint, serial, boolean, doublePrecision, timestamp } from "drizzle-orm/pg-core";

// Re-export auth/multi-tenancy schema (organizations, users, sessions, memberships)
export * from "./auth-schema";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { DEPRECIATION_METHODS } from "./depreciation";
import { PAY_FREQUENCIES } from "./payroll";

// ============================================================================
// CHART OF ACCOUNTS
// ============================================================================
// Standard 5 account types in double-entry accounting
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Normal balance side per account type:
// asset/expense = debit normal; liability/equity/income = credit normal
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  // Per-tenant uniqueness only: migration 0000 enforces UNIQUE(org_id, code).
  // No column-level .unique() here — that would declare a conflicting GLOBAL
  // unique and break drizzle-kit push. createAccount() surfaces the friendly
  // per-org duplicate error.
  code: text("code").notNull(), // e.g. "1000"
  name: text("name").notNull(), // e.g. "Cash"
  type: text("type").notNull(), // AccountType
  subtype: text("subtype"), // e.g. "current_asset", "fixed_asset"
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});

// Recognized subtypes — used for cash flow classification and balance-sheet grouping.
// Not exhaustive (the schema column is free-text), but accounts created through the API
// will be validated against this list to prevent silent misclassification.
export const ACCOUNT_SUBTYPES = {
  asset: ["bank", "current_asset", "fixed_asset", "intangible_asset", "accumulated_depreciation", "accumulated_amortization", "other_asset"],
  liability: ["current_liability", "credit_card", "long_term_liability", "other_liability"],
  equity: ["equity"],
  income: ["operating_income", "other_income"],
  expense: ["cogs", "operating_expense", "depreciation_expense", "amortization_expense", "interest_expense", "tax_expense", "other_expense"],
} as const;

// Base schema (no refinement) so it can be safely .partial()'d for PATCH endpoints.
const baseAccountSchema = createInsertSchema(accounts)
  .omit({ id: true, orgId: true, updatedAt: true })
  .extend({
    type: z.enum(ACCOUNT_TYPES),
    subtype: z.string().nullable().optional(),
  });

// Refinement extracted as a function so it can be applied to both the full schema
// (for POST) and the partial schema (for PATCH).
function refineAccountShape(val: { type?: string; subtype?: string | null }, ctx: z.RefinementCtx) {
  // Subtype is REQUIRED for asset and liability accounts because the cash flow statement
  // classification depends on it. Without a subtype, the engine cannot tell a fixed asset
  // from a current asset, or long-term debt from accounts payable, and the report will
  // fail to reconcile silently.
  if (val.type === "asset" || val.type === "liability") {
    if (val.subtype === undefined) {
      // partial PATCH that didn't touch subtype — fine
    } else if (!val.subtype) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtype"],
        message: `Subtype is required for ${val.type} accounts. Use one of: ${ACCOUNT_SUBTYPES[val.type as "asset" | "liability"].join(", ")}`,
      });
      return;
    }
  }
  // Warn (but don't reject) on unrecognized subtypes — soft validation so downstream consumers
  // can still create custom subtypes if they really need to.
  if (val.subtype && val.type) {
    const allowed = (ACCOUNT_SUBTYPES as Record<string, readonly string[]>)[val.type];
    if (allowed && !allowed.includes(val.subtype)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtype"],
        message: `Subtype "${val.subtype}" is not a recognized ${val.type} subtype. Recognized: ${allowed.join(", ")}`,
      });
    }
  }
}

export const insertAccountSchema = baseAccountSchema.superRefine(refineAccountShape);
export const updateAccountSchema = baseAccountSchema.partial().superRefine(refineAccountShape);
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accounts.$inferSelect;

// ============================================================================
// CUSTOMERS
// ============================================================================
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  // Structured shipping destination — drives automated sales-tax calculation.
  // When shippingZip + shippingState are present, invoice creation calls TaxJar.
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"), // 2-char, e.g. "TX"
  shippingZip: text("shipping_zip"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  currency: text("currency"),
});

export const insertCustomerSchema = createInsertSchema(customers)
  .omit({ id: true, orgId: true, updatedAt: true })
  .extend({
    name: z.string().min(1, "Customer name is required").max(200),
    email: z.string().email("Invalid email address").or(z.literal("")).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    shippingCity: z.string().max(120).nullable().optional(),
    shippingState: z.string().regex(/^[A-Za-z]{2}$/, "Use a 2-letter state code, e.g. TX").nullable().optional(),
    shippingZip: z.string().regex(/^\d{5}(-\d{4})?$/, "Use a 5-digit ZIP (or ZIP+4)").nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").nullable().optional(),
  });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customers.$inferSelect;

// ============================================================================
// VENDORS
// ============================================================================
export const vendors = pgTable("vendors", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  currency: text("currency"),
});

export const insertVendorSchema = createInsertSchema(vendors)
  .omit({ id: true, orgId: true, updatedAt: true })
  .extend({
    name: z.string().min(1, "Vendor name is required").max(200),
    email: z.string().email("Invalid email address").or(z.literal("")).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").nullable().optional(),
  });
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

// ============================================================================
// SHARED VALIDATORS
// ============================================================================
// ISO date YYYY-MM-DD with calendar-validity check (rejects 2026-02-30 etc.)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a valid calendar date");

// Offset pagination contract shared by every list endpoint:
//   ?limit=<int 1..200, default 50>&offset=<int >= 0, default 0>
// z.coerce handles the string→number conversion from Express query params.
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// Standard envelope every paginated list endpoint returns.
export type Paginated<T> = { rows: T[]; total: number; limit: number; offset: number };

// Query for GET /api/settings/next-number — preview of the upcoming
// auto-number for a document kind (read-only, does not increment).
export const nextNumberQuerySchema = z.object({
  kind: z.enum(["invoice", "bill", "credit_note", "debit_note", "purchase_order", "estimate"]),
});

// ============================================================================
// JOURNAL ENTRIES (the heart of double-entry accounting)
// ============================================================================
// A journal entry is one transaction. It has 2+ lines that must net to zero.
export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  date: text("date").notNull(), // ISO date string YYYY-MM-DD
  memo: text("memo"),
  reference: text("reference"), // e.g. "INV-001", "BILL-042"
  source: text("source").notNull().default("manual"), // manual | invoice | bill | payment | deposit
  sourceId: integer("source_id"), // FK to invoice/bill if applicable
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});

export const insertJournalEntrySchema = createInsertSchema(journalEntries).omit({
  id: true,
  createdAt: true,
});
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntries.$inferSelect;

// Each line: amount goes to debit OR credit (not both)
export const journalLines = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  entryId: integer("entry_id").notNull(),
  accountId: integer("account_id").notNull(),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  debit: bigint("debit", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  credit: bigint("credit", { mode: "number" }).notNull().default(0),
  description: text("description"),
});

export const insertJournalLineSchema = createInsertSchema(journalLines).omit({ id: true });
export type InsertJournalLine = z.infer<typeof insertJournalLineSchema>;
export type JournalLine = typeof journalLines.$inferSelect;

// Combined schema for posting a journal entry with its lines
export const postJournalEntrySchema = z.object({
  date: isoDate,
  memo: z.string().max(500).optional(),
  reference: z.string().max(100).optional(),
  source: z.string().max(50).optional(),
  sourceId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        accountId: z.number().int().positive(),
        debit: z.number().min(0).default(0),
        credit: z.number().min(0).default(0),
        description: z.string().max(500).optional(),
      }).refine(
        (l) => !((l.debit || 0) > 0 && (l.credit || 0) > 0),
        { message: "A single line cannot have both a debit and a credit. Split into two lines." }
      ).refine(
        (l) => (l.debit || 0) > 0 || (l.credit || 0) > 0,
        { message: "Each line must have a debit OR a credit greater than zero." }
      )
    )
    .min(2, "Journal entry must have at least 2 lines")
    .refine(
      (lines) => {
        // Compare in INTEGER CENTS to match postJournalEntry() in storage.ts.
        // User input here is dollars (floats); exact float equality falsely
        // rejects balanced entries (0.1 + 0.2 !== 0.3 in IEEE-754). Rounding
        // each line to cents first — exactly as the route boundary does with
        // toCents() — makes this validator agree with the storage layer.
        const drCents = lines.reduce((s, l) => s + Math.round((l.debit || 0) * 100), 0);
        const crCents = lines.reduce((s, l) => s + Math.round((l.credit || 0) * 100), 0);
        return drCents === crCents && drCents > 0;
      },
      { message: "Debits must equal credits and the total must be greater than zero" }
    ),
});
export type PostJournalEntry = z.infer<typeof postJournalEntrySchema>;

// ============================================================================
// INVENTORY ITEMS
// ============================================================================
// A catalog item that invoice/bill lines can reference. Three kinds:
//   - 'inventory'    : stock-tracked. Purchases capitalize to the Inventory
//                      Asset account and raise quantity_on_hand at a
//                      WEIGHTED-AVERAGE cost; sales relieve inventory and post
//                      COGS (Dr COGS / Cr Inventory Asset). Requires
//                      inventory_asset_account_id.
//   - 'service'      : no stock. Sold from sales_account_id, bought to
//                      expense_account_id. inventory_asset_account_id is null.
//   - 'noninventory' : a physical good we don't track quantities for. Same GL
//                      wiring as a service.
// Money: avg_cost_cents is INTEGER CENTS (weighted-average unit cost).
// quantity_on_hand is WHOLE units. Both are server-maintained from
// inventory_movements — never accepted from a request body.
export const ITEM_TYPES = ["inventory", "service", "noninventory"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  // NOT NULL, no DB default (migration 0013). A forgotten orgId is a loud NOT
  // NULL violation instead of silently landing in org 1 — storage stamps
  // currentOrgId() on insert (same discipline as reconciliation_items).
  orgId: integer("org_id").notNull(),
  sku: text("sku").notNull(), // UNIQUE(org_id, sku) enforced in migration 0013
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(), // ItemType
  salesAccountId: integer("sales_account_id").notNull(),   // income credited on sale
  expenseAccountId: integer("expense_account_id").notNull(), // expense debited on a service/non-inventory purchase
  inventoryAssetAccountId: integer("inventory_asset_account_id"), // null for service/non-inventory
  cogsAccountId: integer("cogs_account_id").notNull(),     // COGS debited when inventory is sold
  quantityOnHand: integer("quantity_on_hand").notNull().default(0), // whole units
  // Weighted-average unit cost. Stored in cents (integer). $2.50 = 250. Never REAL.
  avgCostCents: bigint("avg_cost_cents", { mode: "number" }).notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type Item = typeof items.$inferSelect;

// Base (unrefined) so it can be .partial()'d for PATCH.
const baseItemSchema = createInsertSchema(items)
  // quantityOnHand + avgCostCents are DERIVED from movements; orgId is stamped
  // server-side. .omit them so a request body can neither set its tenant nor
  // forge stock levels (mass-assignment protection — tenancy test).
  .omit({ id: true, orgId: true, quantityOnHand: true, avgCostCents: true, updatedAt: true })
  .extend({
    sku: z.string().min(1, "SKU is required").max(60),
    name: z.string().min(1, "Item name is required").max(200),
    description: z.string().max(2000).nullable().optional(),
    type: z.enum(ITEM_TYPES),
    salesAccountId: z.number().int().positive(),
    expenseAccountId: z.number().int().positive(),
    inventoryAssetAccountId: z.number().int().positive().nullable().optional(),
    cogsAccountId: z.number().int().positive(),
    isActive: z.boolean().default(true),
  });

// Cross-field: an inventory item MUST have an inventory asset account (that is
// where purchases capitalize and sales relieve). On PATCH the rule only fires
// when `type` is present in the payload; storage re-validates the merged row.
function refineItemShape(v: { type?: string; inventoryAssetAccountId?: number | null }, ctx: z.RefinementCtx) {
  if (v.type === "inventory" && !v.inventoryAssetAccountId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inventoryAssetAccountId"],
      message: "Inventory items require an inventoryAssetAccountId (where stock is capitalized).",
    });
  }
}

export const insertItemSchema = baseItemSchema.superRefine(refineItemShape);
export const updateItemSchema = baseItemSchema.partial().superRefine(refineItemShape);
export type InsertItem = z.infer<typeof insertItemSchema>;
export type UpdateItem = z.infer<typeof updateItemSchema>;

// ============================================================================
// INVENTORY MOVEMENTS — the append-only ledger behind quantity_on_hand
// ============================================================================
// One row per stock change. qty_delta is SIGNED whole units (+ on purchase,
// - on sale). unit_cost_cents is the per-unit cost that drove the change (the
// landed cost on a purchase; the weighted-average cost at time of sale).
// entry_id links to the journal entry that posted the matching GL effect.
export const INVENTORY_MOVEMENT_SOURCES = ["bill", "invoice", "adjustment", "opening"] as const;
export type InventoryMovementSource = (typeof INVENTORY_MOVEMENT_SOURCES)[number];

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  itemId: integer("item_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  qtyDelta: integer("qty_delta").notNull(), // signed whole units
  // Stored in cents (integer). $2.50 = 250. Never use REAL for money.
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  source: text("source").notNull(), // InventoryMovementSource
  sourceId: integer("source_id"), // FK to the bill/invoice/etc. that caused it
  entryId: integer("entry_id"), // FK to journal_entries (the GL effect)
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type InventoryMovement = typeof inventoryMovements.$inferSelect;

// ============================================================================
// INVOICES (sales / accounts receivable)
// ============================================================================
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  number: text("number").notNull().unique(),
  customerId: integer("customer_id").notNull(),
  date: text("date").notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status").notNull().default("open"), // open | paid | void
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  tax: bigint("tax", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  total: bigint("total", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountPaid: bigint("amount_paid", { mode: "number" }).notNull().default(0),
  // Full tax-calculation audit record as JSON text (SQLite's JSONB equivalent):
  // { source, taxRate, taxAmountCents, breakdownCents, raw } — raw is the verbatim
  // TaxJar response when source is taxjar/taxjar_sandbox.
  taxBreakdown: text("tax_breakdown"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  currency: text("currency").notNull().default(""),
  fxRate: doublePrecision("fx_rate").notNull().default(1),
  foreignSubtotal: bigint("foreign_subtotal", { mode: "number" }).notNull().default(0),
  foreignTax: bigint("foreign_tax", { mode: "number" }).notNull().default(0),
  foreignTotal: bigint("foreign_total", { mode: "number" }).notNull().default(0),
  foreignAmountPaid: bigint("foreign_amount_paid", { mode: "number" }).notNull().default(0),
  estimateId: integer("estimate_id"), // set when this invoice was created by converting an estimate
});

export const insertInvoiceSchema = createInsertSchema(invoices).omit({
  id: true,
  amountPaid: true,
  status: true,
  updatedAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoices.$inferSelect;

export const invoiceLines = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  invoiceId: integer("invoice_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS as entered (may be sub-cent, e.g. $0.0025/unit). All LEDGER money derived from it is integer cents: amount = Math.round(quantity * rate * 100).
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  incomeAccountId: integer("income_account_id").notNull(), // which income account this line credits
  itemId: integer("item_id"), // optional link to a catalog item (drives income account + COGS)
});

export const insertInvoiceLineSchema = createInsertSchema(invoiceLines).omit({ id: true });
export type InsertInvoiceLine = z.infer<typeof insertInvoiceLineSchema>;
export type InvoiceLine = typeof invoiceLines.$inferSelect;

export const createInvoiceSchema = z.object({
  // Optional: when omitted, the server allocates the next per-org number
  // (e.g. INV-0001) via the atomic number_sequences allocator.
  number: z.string().min(1).max(50).optional(),
  // FX: omit for base-currency documents. When currency differs from the org
  // base, fxRate (base units per 1 foreign unit) is required and must be > 0
  // — enforced in storage where the org base is known.
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").optional(),
  fxRate: z.number().positive().optional(),
  customerId: z.number().int().positive(),
  date: isoDate,
  dueDate: isoDate,
  notes: z.string().max(2000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  taxCodeId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive("Quantity must be greater than 0"),
        rate: z.number().min(0),
        // Reference a catalog item (income account + COGS are derived from it)
        // OR name the income account directly. At least one is required.
        itemId: z.number().int().positive().optional(),
        incomeAccountId: z.number().int().positive().optional(),
      }).refine((l) => l.itemId !== undefined || l.incomeAccountId !== undefined, {
        message: "Each line must reference an itemId or an incomeAccountId",
        path: ["incomeAccountId"],
      })
    )
    .min(1, "Invoice must have at least one line"),
}).refine((v) => v.dueDate >= v.date, {
  message: "Due date must be on or after the invoice date",
  path: ["dueDate"],
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

// ============================================================================
// ESTIMATES (quotes) — a sales pre-document that converts into an invoice
// ============================================================================
// An estimate is a QUOTE: it posts NO GL entry. Its stored *_cents are a snapshot
// computed with the SAME per-line rounding + tax math the invoice uses, so a
// conversion (which runs through createInvoice) reproduces the totals exactly.
// estimate_lines mirror invoice_lines.
export const ESTIMATE_STATUSES = ["draft", "sent", "accepted", "declined", "expired", "invoiced"] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const estimates = pgTable("estimates", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  number: text("number").notNull(), // UNIQUE(org_id, number) via number_sequences 'estimate' → EST-0001
  customerId: integer("customer_id").notNull(),
  date: text("date").notNull(),
  expiryDate: text("expiry_date").notNull(),
  status: text("status").notNull().default("draft"), // EstimateStatus
  currency: text("currency").notNull().default(""),
  fxRate: doublePrecision("fx_rate").notNull().default(1),
  // Snapshot totals in the DOCUMENT currency. Stored in cents (integer). Never REAL.
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
  totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type Estimate = typeof estimates.$inferSelect;

export const estimateLines = pgTable("estimate_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  estimateId: integer("estimate_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS as entered
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  incomeAccountId: integer("income_account_id").notNull(),
  itemId: integer("item_id"), // optional catalog item (drives income account on convert)
});
export type EstimateLine = typeof estimateLines.$inferSelect;

// Public share tokens for the read-only /p/estimate/:token view (mirrors invoice_shares).
export const estimateShares = pgTable("estimate_shares", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  estimateId: integer("estimate_id").notNull(),
  token: text("token").notNull().unique(),
  recipientEmail: text("recipient_email"),
  viewedAt: text("viewed_at"),
  viewCount: integer("view_count").notNull().default(0),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type EstimateShare = typeof estimateShares.$inferSelect;

export const createEstimateSchema = z.object({
  number: z.string().min(1).max(50).optional(), // auto-allocated (EST-0001) when omitted
  customerId: z.number().int().positive(),
  date: isoDate,
  expiryDate: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").optional(),
  fxRate: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  taxCodeId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive("Quantity must be greater than 0"),
        rate: z.number().min(0),
        itemId: z.number().int().positive().optional(),
        incomeAccountId: z.number().int().positive().optional(),
      }).refine((l) => l.itemId !== undefined || l.incomeAccountId !== undefined, {
        message: "Each line must reference an itemId or an incomeAccountId",
        path: ["incomeAccountId"],
      })
    )
    .min(1, "Estimate must have at least one line"),
}).refine((v) => v.expiryDate >= v.date, {
  message: "Expiry date must be on or after the estimate date",
  path: ["expiryDate"],
});
export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;

// Header-only edits (allowed before conversion) + manual status transitions.
export const updateEstimateSchema = z.object({
  customerId: z.number().int().positive().optional(),
  date: isoDate.optional(),
  expiryDate: isoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(["draft", "sent", "accepted", "declined"]).optional(),
}).refine((v) => !v.date || !v.expiryDate || v.expiryDate >= v.date, {
  message: "Expiry date must be on or after the estimate date",
  path: ["expiryDate"],
});
export type UpdateEstimateInput = z.infer<typeof updateEstimateSchema>;

// Convert → invoice. Dates are optional (invoice inherits sensible defaults).
export const convertEstimateSchema = z.object({
  date: isoDate.optional(),   // invoice issue date (default: today)
  dueDate: isoDate.optional(), // invoice due date (default: issue date + 30 days)
}).refine((v) => !v.date || !v.dueDate || v.dueDate >= v.date, {
  message: "Due date must be on or after the invoice date",
  path: ["dueDate"],
});
export type ConvertEstimateInput = z.infer<typeof convertEstimateSchema>;

// ============================================================================
// FIXED ASSETS — register + automatic depreciation
// ============================================================================
// A capitalized asset that depreciates over a useful life. Depreciation is
// posted monthly as Dr Depreciation Expense / Cr Accumulated Depreciation. The
// schedule is computed in integer cents (see shared/depreciation.ts) with the
// last period absorbing the rounding remainder, so the asset is never over- or
// under-depreciated. depreciation_entries make each month's posting idempotent
// via UNIQUE(org_id, asset_id, period).
export const FIXED_ASSET_STATUSES = ["active", "disposed", "fully_depreciated"] as const;
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number];

export const fixedAssets = pgTable("fixed_assets", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  name: text("name").notNull(),
  assetAccountId: integer("asset_account_id").notNull(),                      // where the asset is capitalized (asset)
  accumDepAccountId: integer("accum_dep_account_id").notNull(),               // contra-asset (accumulated depreciation)
  depreciationExpenseAccountId: integer("depreciation_expense_account_id").notNull(), // expense
  acquisitionDate: text("acquisition_date").notNull(), // YYYY-MM-DD
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  costCents: bigint("cost_cents", { mode: "number" }).notNull(),
  salvageCents: bigint("salvage_cents", { mode: "number" }).notNull().default(0),
  usefulLifeMonths: integer("useful_life_months").notNull(),
  method: text("method").notNull(), // DepreciationMethod
  status: text("status").notNull().default("active"), // FixedAssetStatus
  disposedDate: text("disposed_date"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type FixedAsset = typeof fixedAssets.$inferSelect;

// One row per posted (or recorded-zero) period. The UNIQUE constraint on
// (org_id, asset_id, period) is what makes POST .../post-depreciation idempotent.
export const depreciationEntries = pgTable("depreciation_entries", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  assetId: integer("asset_id").notNull(),
  period: text("period").notNull(), // YYYY-MM
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  entryId: integer("entry_id"), // FK to journal_entries (null for a recorded zero-amount period)
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type DepreciationEntry = typeof depreciationEntries.$inferSelect;

const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be YYYY-MM");

const baseFixedAssetSchema = z.object({
  name: z.string().min(1, "Asset name is required").max(200),
  assetAccountId: z.number().int().positive(),
  accumDepAccountId: z.number().int().positive(),
  depreciationExpenseAccountId: z.number().int().positive(),
  acquisitionDate: isoDate,
  // INTEGER CENTS — the client converts user dollars at the API boundary.
  costCents: z.number().int().positive("Cost must be greater than zero"),
  salvageCents: z.number().int().min(0).default(0),
  usefulLifeMonths: z.number().int().min(1).max(1200),
  method: z.enum(DEPRECIATION_METHODS),
});
function refineFixedAsset(v: { costCents?: number; salvageCents?: number }, ctx: z.RefinementCtx) {
  if (v.costCents !== undefined && v.salvageCents !== undefined && v.salvageCents >= v.costCents) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salvageCents"], message: "Salvage value must be less than cost" });
  }
}
export const createFixedAssetSchema = baseFixedAssetSchema.superRefine(refineFixedAsset);
export type CreateFixedAssetInput = z.infer<typeof createFixedAssetSchema>;

// PATCH: the depreciable inputs (cost/salvage/life/method/acquisition) are frozen
// once depreciation has been posted (enforced in storage); accounts + name are
// always editable.
export const updateFixedAssetSchema = baseFixedAssetSchema.partial().superRefine(refineFixedAsset);
export type UpdateFixedAssetInput = z.infer<typeof updateFixedAssetSchema>;

export const postDepreciationQuerySchema = z.object({ period: isoMonth });

export const disposeFixedAssetSchema = z.object({
  date: isoDate,
  // Sale proceeds in INTEGER CENTS (0 for a scrap/write-off).
  proceedsCents: z.number().int().min(0).default(0),
  // Bank/receivable account the proceeds land in (required when proceeds > 0).
  proceedsAccountId: z.number().int().positive().optional(),
  // Where the gain or loss on disposal is booked (income or expense account).
  gainLossAccountId: z.number().int().positive(),
}).refine((v) => v.proceedsCents === 0 || v.proceedsAccountId !== undefined, {
  message: "proceedsAccountId is required when proceedsCents > 0",
  path: ["proceedsAccountId"],
});
export type DisposeFixedAssetInput = z.infer<typeof disposeFixedAssetSchema>;

// ============================================================================
// FX REVALUATION (period-end unrealized foreign-currency adjustment)
// ============================================================================
// The ledger books REALIZED FX on payment (see 4950 FX Gain / 6950 FX Loss).
// This adds UNREALIZED FX: at period end, the base-currency carrying value of an
// OPEN foreign invoice/bill is remeasured at the as-of-date rate, and the
// difference is posted to Unrealized FX Gain/Loss against A/R (1100) or A/P
// (2000). Unrealized revaluations REVERSE at the start of the next period (only
// realized FX is permanent), so each run is stored and can be reversed.
export const FX_REVALUATION_STATUSES = ["posted", "reversed"] as const;
export type FxRevaluationStatus = (typeof FX_REVALUATION_STATUSES)[number];

export const fxRevaluations = pgTable("fx_revaluations", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  asOfDate: text("as_of_date").notNull(), // YYYY-MM-DD
  currency: text("currency"), // null = all foreign currencies in this run
  entryId: integer("entry_id"), // the adjusting JE (null when nothing needed adjusting)
  reversalEntryId: integer("reversal_entry_id"), // the reversing JE (set once reversed)
  reversalDate: text("reversal_date"),
  status: text("status").notNull().default("posted"), // FxRevaluationStatus
  // Stored in cents (integer). Never use REAL for money.
  totalGainCents: bigint("total_gain_cents", { mode: "number" }).notNull().default(0),
  totalLossCents: bigint("total_loss_cents", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type FxRevaluation = typeof fxRevaluations.$inferSelect;

// Per-document detail of a revaluation run (audit trail + explainability).
export const fxRevaluationLines = pgTable("fx_revaluation_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  revaluationId: integer("revaluation_id").notNull(),
  docType: text("doc_type").notNull(), // 'invoice' | 'bill'
  docId: integer("doc_id").notNull(),
  currency: text("currency").notNull(),
  rate: doublePrecision("rate").notNull(), // as-of-date rate, base units per 1 foreign unit
  foreignOutstandingCents: bigint("foreign_outstanding_cents", { mode: "number" }).notNull(),
  bookingBaseCents: bigint("booking_base_cents", { mode: "number" }).notNull(),   // carrying value before revaluation
  revaluedBaseCents: bigint("revalued_base_cents", { mode: "number" }).notNull(), // carrying value at the as-of rate
  diffCents: bigint("diff_cents", { mode: "number" }).notNull(),                  // revalued - booking (signed)
});
export type FxRevaluationLine = typeof fxRevaluationLines.$inferSelect;

export const revalueFxSchema = z.object({
  asOfDate: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").optional(),
});
export type RevalueFxInput = z.infer<typeof revalueFxSchema>;

// ============================================================================
// PAYROLL — employees, pay runs, and automatic GL posting (QBO-style)
// ============================================================================
// A pay run computes each employee's gross, employee-withheld taxes, employer
// taxes, and net pay (see shared/payroll.ts) and posts ONE balanced journal
// entry: Dr Wages Expense + Dr Payroll Tax Expense, Cr Payroll Taxes Payable,
// Cr Payroll Deductions Payable, Cr the bank account for net pay. All integer
// cents; annual wage-base caps use posted year-to-date wages.
export const EMPLOYEE_PAY_TYPES = ["salary", "hourly"] as const;
export type EmployeePayType = (typeof EMPLOYEE_PAY_TYPES)[number];
export const EMPLOYEE_STATUSES = ["active", "inactive"] as const;
export const PAYROLL_RUN_STATUSES = ["draft", "posted", "void"] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  name: text("name").notNull(),
  email: text("email"),
  payType: text("pay_type").notNull(), // salary | hourly
  // Salary: ANNUAL salary in cents. Hourly: hourly rate in cents. Never REAL.
  payRateCents: bigint("pay_rate_cents", { mode: "number" }).notNull(),
  payFrequency: text("pay_frequency").notNull(), // PayFrequency
  federalWithholdingRate: doublePrecision("federal_withholding_rate").notNull().default(0),
  stateWithholdingRate: doublePrecision("state_withholding_rate").notNull().default(0),
  status: text("status").notNull().default("active"), // active | inactive
  hireDate: text("hire_date"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type Employee = typeof employees.$inferSelect;

export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  payDate: text("pay_date").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  status: text("status").notNull().default("draft"), // draft | posted | void
  bankAccountId: integer("bank_account_id").notNull(), // net pay is drawn from here
  entryId: integer("entry_id"), // FK to journal_entries once posted
  // All integer cents.
  totalGrossCents: bigint("total_gross_cents", { mode: "number" }).notNull().default(0),
  totalEmployeeTaxCents: bigint("total_employee_tax_cents", { mode: "number" }).notNull().default(0),
  totalEmployerTaxCents: bigint("total_employer_tax_cents", { mode: "number" }).notNull().default(0),
  totalDeductionsCents: bigint("total_deductions_cents", { mode: "number" }).notNull().default(0),
  totalNetCents: bigint("total_net_cents", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type PayrollRun = typeof payrollRuns.$inferSelect;

export const payrollItems = pgTable("payroll_items", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  runId: integer("run_id").notNull(),
  employeeId: integer("employee_id").notNull(),
  hours: doublePrecision("hours"), // hourly employees only
  // All integer cents.
  grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
  preTaxDeductionCents: bigint("pretax_deduction_cents", { mode: "number" }).notNull().default(0),
  postTaxDeductionCents: bigint("posttax_deduction_cents", { mode: "number" }).notNull().default(0),
  fedWithholdingCents: bigint("fed_withholding_cents", { mode: "number" }).notNull().default(0),
  stateWithholdingCents: bigint("state_withholding_cents", { mode: "number" }).notNull().default(0),
  ssEmployeeCents: bigint("ss_employee_cents", { mode: "number" }).notNull().default(0),
  medicareEmployeeCents: bigint("medicare_employee_cents", { mode: "number" }).notNull().default(0),
  additionalMedicareCents: bigint("additional_medicare_cents", { mode: "number" }).notNull().default(0),
  ssEmployerCents: bigint("ss_employer_cents", { mode: "number" }).notNull().default(0),
  medicareEmployerCents: bigint("medicare_employer_cents", { mode: "number" }).notNull().default(0),
  futaCents: bigint("futa_cents", { mode: "number" }).notNull().default(0),
  sutaCents: bigint("suta_cents", { mode: "number" }).notNull().default(0),
  employeeTaxCents: bigint("employee_tax_cents", { mode: "number" }).notNull().default(0),
  employerTaxCents: bigint("employer_tax_cents", { mode: "number" }).notNull().default(0),
  netCents: bigint("net_cents", { mode: "number" }).notNull().default(0),
});
export type PayrollItem = typeof payrollItems.$inferSelect;

const baseEmployeeSchema = z.object({
  name: z.string().min(1, "Employee name is required").max(200),
  email: z.string().email("Invalid email address").or(z.literal("")).nullable().optional(),
  payType: z.enum(EMPLOYEE_PAY_TYPES),
  // INTEGER CENTS — annual salary (salary) or hourly rate (hourly). Client converts at the boundary.
  payRateCents: z.number().int().positive("Pay rate must be greater than zero"),
  payFrequency: z.enum(PAY_FREQUENCIES),
  federalWithholdingRate: z.number().min(0).max(1).default(0),
  stateWithholdingRate: z.number().min(0).max(1).default(0),
  status: z.enum(EMPLOYEE_STATUSES).default("active"),
  hireDate: isoDate.nullable().optional(),
});
export const createEmployeeSchema = baseEmployeeSchema;
export const updateEmployeeSchema = baseEmployeeSchema.partial();
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const createPayrollRunSchema = z.object({
  payDate: isoDate,
  periodStart: isoDate,
  periodEnd: isoDate,
  bankAccountId: z.number().int().positive(),
  lines: z.array(z.object({
    employeeId: z.number().int().positive(),
    hours: z.number().min(0).max(2000).optional(), // required for hourly (validated in storage)
    additionalPayCents: z.number().int().min(0).default(0), // bonus/overtime dollars already in cents
    preTaxDeductionCents: z.number().int().min(0).default(0),
    postTaxDeductionCents: z.number().int().min(0).default(0),
  })).min(1, "A pay run needs at least one employee"),
}).refine((v) => v.periodEnd >= v.periodStart, {
  message: "Period end must be on or after period start",
  path: ["periodEnd"],
});
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>;

// ---- Paying payroll liabilities (remittance to tax agencies, QBO "Pay Taxes") ----
// Running payroll accrues Payroll Taxes Payable / Deductions Payable. Remitting
// them posts Dr <liability account> / Cr Bank, closing the loop.
export const payrollLiabilityPayments = pgTable("payroll_liability_payments", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  payDate: text("pay_date").notNull(),
  bankAccountId: integer("bank_account_id").notNull(),
  entryId: integer("entry_id"), // the remittance JE
  memo: text("memo"),
  totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type PayrollLiabilityPayment = typeof payrollLiabilityPayments.$inferSelect;

export const payrollLiabilityPaymentLines = pgTable("payroll_liability_payment_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  paymentId: integer("payment_id").notNull(),
  accountId: integer("account_id").notNull(), // the payroll-liability account being remitted
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
});
export type PayrollLiabilityPaymentLine = typeof payrollLiabilityPaymentLines.$inferSelect;

export const payPayrollLiabilitiesSchema = z.object({
  payDate: isoDate,
  bankAccountId: z.number().int().positive(),
  memo: z.string().max(500).optional(),
  lines: z.array(z.object({
    accountId: z.number().int().positive(),
    // INTEGER CENTS — the amount remitted for this liability account.
    amountCents: z.number().int().positive("Remittance amount must be greater than zero"),
  })).min(1, "Provide at least one liability to pay"),
});
export type PayPayrollLiabilitiesInput = z.infer<typeof payPayrollLiabilitiesSchema>;

// ============================================================================
// BILLS (purchases / accounts payable)
// ============================================================================
export const bills = pgTable("bills", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  number: text("number").notNull().unique(),
  vendorId: integer("vendor_id").notNull(),
  date: text("date").notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status").notNull().default("open"), // open | paid | void
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  tax: bigint("tax", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  total: bigint("total", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountPaid: bigint("amount_paid", { mode: "number" }).notNull().default(0),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  currency: text("currency").notNull().default(""),
  fxRate: doublePrecision("fx_rate").notNull().default(1),
  foreignSubtotal: bigint("foreign_subtotal", { mode: "number" }).notNull().default(0),
  foreignTax: bigint("foreign_tax", { mode: "number" }).notNull().default(0),
  foreignTotal: bigint("foreign_total", { mode: "number" }).notNull().default(0),
  foreignAmountPaid: bigint("foreign_amount_paid", { mode: "number" }).notNull().default(0),
  poId: integer("po_id"), // set when this bill was generated by receiving a purchase order
});

export const insertBillSchema = createInsertSchema(bills).omit({
  id: true,
  amountPaid: true,
  status: true,
  updatedAt: true,
});
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof bills.$inferSelect;

export const billLines = pgTable("bill_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  billId: integer("bill_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS as entered (may be sub-cent, e.g. $0.0025/unit). All LEDGER money derived from it is integer cents: amount = Math.round(quantity * rate * 100).
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  expenseAccountId: integer("expense_account_id").notNull(),
  itemId: integer("item_id"), // optional link to a catalog item (drives GL account + stock)
});

export const insertBillLineSchema = createInsertSchema(billLines).omit({ id: true });
export type InsertBillLine = z.infer<typeof insertBillLineSchema>;
export type BillLine = typeof billLines.$inferSelect;

export const createBillSchema = z.object({
  // Optional: when omitted, the server allocates the next per-org number
  // (e.g. BILL-0001) via the atomic number_sequences allocator.
  number: z.string().min(1).max(50).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").optional(),
  fxRate: z.number().positive().optional(),
  vendorId: z.number().int().positive(),
  date: isoDate,
  dueDate: isoDate,
  notes: z.string().max(2000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  taxCodeId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive("Quantity must be greater than 0"),
        rate: z.number().min(0),
        // Reference a catalog item (GL account is derived from it: inventory
        // items capitalize to the Inventory Asset account and raise stock;
        // service/non-inventory items expense) OR name the expense account.
        itemId: z.number().int().positive().optional(),
        expenseAccountId: z.number().int().positive().optional(),
      }).refine((l) => l.itemId !== undefined || l.expenseAccountId !== undefined, {
        message: "Each line must reference an itemId or an expenseAccountId",
        path: ["expenseAccountId"],
      })
    )
    .min(1, "Bill must have at least one line"),
}).refine((v) => v.dueDate >= v.date, {
  message: "Due date must be on or after the bill date",
  path: ["dueDate"],
});
export type CreateBillInput = z.infer<typeof createBillSchema>;

// ============================================================================
// PURCHASE ORDERS (AP pre-document that converts into a bill)
// ============================================================================
// A PO is a COMMITMENT to buy — it posts NO journal entry (it is not a GL
// event). Receiving a PO (fully or in part) creates a bill for the received
// portion via createBill(), which is where the GL effect (Dr Expense/Inventory,
// Cr A/P) and any inventory movements actually happen. Over-receipt is blocked:
// a line's received quantity can never exceed the ordered quantity.
export const PO_STATUSES = ["open", "partial", "received", "closed", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(), // NOT NULL, no DB default — storage stamps currentOrgId()
  number: text("number").notNull(), // UNIQUE(org_id, number) — allocated via number_sequences 'purchase_order'
  vendorId: integer("vendor_id").notNull(),
  date: text("date").notNull(), // order date YYYY-MM-DD
  expectedDate: text("expected_date"), // expected delivery date
  status: text("status").notNull().default("open"), // PurchaseOrderStatus
  currency: text("currency").notNull().default(""),
  fxRate: doublePrecision("fx_rate").notNull().default(1),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  poId: integer("po_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1), // ordered quantity
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS (sub-cent allowed)
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountCents: bigint("amount_cents", { mode: "number" }).notNull().default(0), // round(quantity * rate * 100)
  expenseAccountId: integer("expense_account_id").notNull(),
  itemId: integer("item_id"), // optional link to a catalog item (drives GL account + stock on receipt)
  qtyReceived: integer("qty_received").notNull().default(0), // whole units received so far
});
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;

const poLineInputSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive("Quantity must be greater than 0"),
  rate: z.number().min(0),
  // Reference a catalog item (GL account derived on receipt) OR name the expense account.
  itemId: z.number().int().positive().optional(),
  expenseAccountId: z.number().int().positive().optional(),
}).refine((l) => l.itemId !== undefined || l.expenseAccountId !== undefined, {
  message: "Each line must reference an itemId or an expenseAccountId",
  path: ["expenseAccountId"],
});

export const createPurchaseOrderSchema = z.object({
  number: z.string().min(1).max(50).optional(), // auto-allocated (PO-0001) when omitted
  vendorId: z.number().int().positive(),
  date: isoDate,
  expectedDate: isoDate.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR").optional(),
  fxRate: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineInputSchema).min(1, "Purchase order must have at least one line"),
}).refine((v) => !v.expectedDate || v.expectedDate >= v.date, {
  message: "Expected date must be on or after the order date",
  path: ["expectedDate"],
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

// Header-only edits (allowed while the PO is still open). Lines are replaced via
// the `lines` field only when nothing has been received yet (enforced in storage).
export const updatePurchaseOrderSchema = z.object({
  vendorId: z.number().int().positive().optional(),
  date: isoDate.optional(),
  expectedDate: isoDate.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  fxRate: z.number().positive().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Manual status transitions: close a fully/partly received PO, or cancel one
  // that has not been received. 'open'/'partial'/'received' are derived on receipt.
  status: z.enum(["closed", "cancelled"]).optional(),
  lines: z.array(poLineInputSchema).min(1).optional(),
});
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

// Receive per-line quantities. Each entry names a PO line and the WHOLE units
// received now; storage rejects over-receipt and builds a bill for this receipt.
export const receivePurchaseOrderSchema = z.object({
  date: isoDate, // receipt / bill date
  dueDate: isoDate.optional(), // bill due date (defaults to the receipt date)
  lines: z.array(z.object({
    poLineId: z.number().int().positive(),
    quantity: z.number().int().positive("Received quantity must be a positive whole number"),
  })).min(1, "Provide at least one line to receive"),
}).refine((v) => !v.dueDate || v.dueDate >= v.date, {
  message: "Due date must be on or after the receipt date",
  path: ["dueDate"],
});
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>;

// ============================================================================
// PAYMENTS (against invoice or bill)
// ============================================================================
export const payInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
  date: isoDate,
  // Base-currency amount. For FX documents this is ignored (0 is fine) and
  // foreignAmount + fxRate drive the payment instead — see the refine below.
  amount: z.number().min(0),
  bankAccountId: z.number().int().positive(),
  memo: z.string().max(500).optional(),
  // FX documents only: the amount tendered in the DOCUMENT currency plus the
  // rate at PAYMENT date. Base `amount` is ignored for FX documents.
  foreignAmount: z.number().positive().optional(),
  fxRate: z.number().positive().optional(),
}).refine((v) => v.amount >= 0.01 || (v.foreignAmount !== undefined && v.foreignAmount > 0), {
  message: "Provide amount (base currency) or foreignAmount (for FX documents)",
  path: ["amount"],
});
export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;

export const payBillSchema = z.object({
  billId: z.number().int().positive(),
  date: isoDate,
  amount: z.number().min(0),
  bankAccountId: z.number().int().positive(),
  memo: z.string().max(500).optional(),
  // FX documents only: the amount tendered in the DOCUMENT currency plus the
  // rate at PAYMENT date. Base `amount` is ignored for FX documents.
  foreignAmount: z.number().positive().optional(),
  fxRate: z.number().positive().optional(),
}).refine((v) => v.amount >= 0.01 || (v.foreignAmount !== undefined && v.foreignAmount > 0), {
  message: "Provide amount (base currency) or foreignAmount (for FX documents)",
  path: ["amount"],
});
export type PayBillInput = z.infer<typeof payBillSchema>;

// ============================================================================
// BANK TRANSACTIONS (imported or manually entered bank-side records)
// ============================================================================
// A bank_transactions row represents a single line on a bank statement.
// It can be in one of these states:
//   - 'unmatched' : imported but not yet posted to GL
//   - 'matched'   : confirmed and a journal entry exists (entryId is set)
//   - 'ignored'   : user said "skip this"
export const bankTransactions = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  bankAccountId: integer("bank_account_id").notNull(), // FK to accounts (the bank GL account)
  date: text("date").notNull(),
  description: text("description").notNull(),
  // amount is signed: positive = money in (deposit), negative = money out (withdrawal)
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull(),
  status: text("status").notNull().default("unmatched"), // unmatched | matched | ignored
  entryId: integer("entry_id"), // FK to journal_entries when matched
  externalId: text("external_id"), // e.g. Plaid transaction_id for dedupe
  source: text("source").notNull().default("manual"), // manual | csv | plaid
  importedAt: timestamp("imported_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});

export const insertBankTransactionSchema = createInsertSchema(bankTransactions).omit({
  id: true,
  importedAt: true,
  status: true,
  entryId: true,
  updatedAt: true,
});
export type InsertBankTransaction = z.infer<typeof insertBankTransactionSchema>;
export type BankTransaction = typeof bankTransactions.$inferSelect;

// Manual bank-transaction posting: user just specifies what kind of transaction it is
export const postBankTransactionSchema = z.object({
  bankAccountId: z.number().int().positive(),
  date: isoDate,
  description: z.string().min(1).max(500),
  amount: z.number(), // signed
  kind: z.enum(["deposit", "withdrawal", "transfer"]),
  categoryAccountId: z.number().int().positive().optional(),
  transferAccountId: z.number().int().positive().optional(),
}).refine((v) => v.amount !== 0, {
  message: "Amount cannot be zero",
  path: ["amount"],
});
export type PostBankTransactionInput = z.infer<typeof postBankTransactionSchema>;

// CSV/Plaid import
export const importBankTransactionsSchema = z.object({
  bankAccountId: z.number().int().positive(),
  source: z.enum(["csv", "plaid"]).default("csv"),
  transactions: z
    .array(
      z.object({
        date: isoDate,
        description: z.string().min(1).max(500),
        amount: z.number(),
        externalId: z.string().max(200).optional(),
      })
    )
    .min(1)
    .max(10000, "Cannot import more than 10,000 transactions at once"),
});
export type ImportBankTransactionsInput = z.infer<typeof importBankTransactionsSchema>;

// Confirm a match for an imported bank transaction
export const matchBankTransactionSchema = z.object({
  bankTransactionId: z.number(),
  // Match it to one of:
  matchType: z.enum(["invoice_payment", "bill_payment", "categorize", "transfer", "ignore"]),
  invoiceId: z.number().optional(),
  billId: z.number().optional(),
  categoryAccountId: z.number().optional(),
  transferAccountId: z.number().optional(),
});
export type MatchBankTransactionInput = z.infer<typeof matchBankTransactionSchema>;

// ============================================================================
// BANK RULES — auto-categorize imported bank transactions
// ============================================================================
// A rule says: when an imported tx matches these conditions, auto-post it as X.
// Conditions: description contains text (case-insensitive), and/or amount comparator.
// Action: mark it 'matched' with an auto-generated journal entry against an account.
export const bankRules = pgTable("bank_rules", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(100), // lower = runs first
  isActive: boolean("is_active").notNull().default(true),
  // Filters (all that are non-null must match)
  bankAccountId: integer("bank_account_id"), // null = any bank account
  descriptionContains: text("description_contains"), // case-insensitive substring
  amountComparator: text("amount_comparator"), // 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'between'
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountMin: bigint("amount_min", { mode: "number" }),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountMax: bigint("amount_max", { mode: "number" }),
  direction: text("direction"), // 'in' (deposits) | 'out' (withdrawals) | null = either
  // Action: how to post it
  actionType: text("action_type").notNull(), // 'categorize' | 'transfer' | 'ignore'
  categoryAccountId: integer("category_account_id"),
  transferAccountId: integer("transfer_account_id"),
  autoPost: boolean("auto_post").notNull().default(true), // if false, just suggest
  hits: integer("hits").notNull().default(0), // counter
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});

const bankRuleBaseSchema = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(10000).default(100),
  isActive: z.boolean().default(true),
  bankAccountId: z.number().int().positive().nullable().optional(),
  descriptionContains: z.string().max(500).optional(),
  amountComparator: z.enum(["eq", "gt", "lt", "gte", "lte", "between"]).optional(),
  amountMin: z.number().optional(),
  amountMax: z.number().optional(),
  direction: z.enum(["in", "out"]).nullable().optional(),
  actionType: z.enum(["categorize", "transfer", "ignore"]),
  categoryAccountId: z.number().int().positive().nullable().optional(),
  transferAccountId: z.number().int().positive().nullable().optional(),
  autoPost: z.boolean().default(true),
});

// Cross-field rules. On PATCH (partial), each rule only fires when the fields it
// depends on are present in the payload — the merged record is re-validated in storage.
function refineBankRule(v: Partial<z.infer<typeof bankRuleBaseSchema>>, ctx: z.RefinementCtx) {
  // If actionType is 'categorize', categoryAccountId must be set
  if (v.actionType === "categorize" && !v.categoryAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["categoryAccountId"],
      message: "categoryAccountId is required when actionType is 'categorize'" });
  }
  // If 'transfer', transferAccountId required
  if (v.actionType === "transfer" && !v.transferAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferAccountId"],
      message: "transferAccountId is required when actionType is 'transfer'" });
  }
  // If 'between', both bounds required and min < max
  if (v.amountComparator === "between") {
    if (v.amountMin === undefined || v.amountMax === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountComparator"],
        message: "Both amountMin and amountMax are required for 'between'" });
    } else if (v.amountMin >= v.amountMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountMax"],
        message: "amountMax must be greater than amountMin" });
    }
  }
}

export const bankRuleSchema = bankRuleBaseSchema.superRefine(refineBankRule);
export const bankRuleUpdateSchema = bankRuleBaseSchema.partial().superRefine(refineBankRule);
export type BankRuleInput = z.infer<typeof bankRuleSchema>;
export type BankRuleUpdateInput = z.infer<typeof bankRuleUpdateSchema>;
export type BankRule = typeof bankRules.$inferSelect;

// ============================================================================
// BANK RECONCILIATION
// ============================================================================
// A reconciliation = the act of matching the bank statement to the books for one period.
// User picks: bank account, statement date, ending statement balance.
// Then ticks off bank_transactions as 'cleared'.
// Difference = (book balance + sum of cleared deposits - sum of cleared withdrawals) - statement balance
// When difference == 0, lock the reconciliation. Cleared txs become permanent.
export const reconciliations = pgTable("reconciliations", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  bankAccountId: integer("bank_account_id").notNull(),
  statementDate: text("statement_date").notNull(), // YYYY-MM-DD
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  beginningBalance: bigint("beginning_balance", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  endingBalance: bigint("ending_balance", { mode: "number" }).notNull(),
  status: text("status").notNull().default("in_progress"), // in_progress | completed
  completedAt: text("completed_at"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type Reconciliation = typeof reconciliations.$inferSelect;

// Per-tx cleared status. We use a separate join table so non-matched txs can also be cleared
// (some banks just show "deposit $5000" with no invoice attached).
export const reconciliationItems = pgTable("reconciliation_items", {
  id: serial("id").primaryKey(),
  // No .default(1): migration 0003 dropped the DB default after backfilling.
  // Every insert must set orgId explicitly — a forgotten orgId is now a
  // loud NOT NULL violation instead of silently landing in org 1 (bug M3).
  orgId: integer("org_id").notNull(),
  reconciliationId: integer("reconciliation_id").notNull(),
  bankTransactionId: integer("bank_transaction_id").notNull(),
  cleared: boolean("cleared").notNull().default(true),
});
export type ReconciliationItem = typeof reconciliationItems.$inferSelect;

export const startReconciliationSchema = z.object({
  bankAccountId: z.number().int().positive(),
  statementDate: isoDate,
  beginningBalance: z.number(),
  endingBalance: z.number(),
});
export type StartReconciliationInput = z.infer<typeof startReconciliationSchema>;

export const toggleReconItemSchema = z.object({
  bankTransactionId: z.number().int().positive(),
  cleared: z.boolean(),
});
export type ToggleReconItemInput = z.infer<typeof toggleReconItemSchema>;

// ============================================================================
// RECURRING TRANSACTIONS
// ============================================================================
// A template + a schedule. "Every month, on the 1st, post: rent bill of $2500 to WeWork."
// Catch-up scheduler runs on app load: checks if any templates are due, posts them.
export const RECURRING_KINDS = ["invoice", "bill", "journal"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];

export const RECURRING_FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurringFreq = (typeof RECURRING_FREQS)[number];

export const recurringTemplates = pgTable("recurring_templates", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  name: text("name").notNull(), // e.g. "WeWork monthly rent"
  kind: text("kind").notNull(), // RecurringKind
  frequency: text("frequency").notNull(), // RecurringFreq
  intervalCount: integer("interval_count").notNull().default(1), // every N units (e.g. every 2 weeks)
  startDate: text("start_date").notNull(), // first date to post
  endDate: text("end_date"), // null = forever
  maxOccurrences: integer("max_occurrences"), // null = unlimited
  occurrencesPosted: integer("occurrences_posted").notNull().default(0),
  nextRunDate: text("next_run_date").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  // Template payload as JSON (depending on kind)
  // For 'invoice': { customerId, dueDateOffsetDays, taxRate, lines: [{description, quantity, rate, incomeAccountId}] }
  // For 'bill':    { vendorId,   dueDateOffsetDays, taxRate, lines: [{description, quantity, rate, expenseAccountId}] }
  // For 'journal': { memo, lines: [{accountId, debit, credit, description}] }
  payload: text("payload").notNull(), // JSON string
  lastRunAt: text("last_run_at"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type RecurringTemplate = typeof recurringTemplates.$inferSelect;

const recurringBaseSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(RECURRING_KINDS),
  frequency: z.enum(RECURRING_FREQS),
  intervalCount: z.number().int().min(1).max(365).default(1),
  startDate: isoDate,
  endDate: isoDate.optional(),
  maxOccurrences: z.number().int().positive().max(10000).optional(),
  isActive: z.boolean().default(true),
  payload: z.any(),
});
const recurringDateRule = (v: { startDate?: string; endDate?: string }) =>
  !v.endDate || !v.startDate || v.endDate >= v.startDate;

export const createRecurringSchema = recurringBaseSchema.refine(recurringDateRule, {
  message: "End date must be on or after start date",
  path: ["endDate"],
});
export const updateRecurringSchema = recurringBaseSchema.partial().refine(recurringDateRule, {
  message: "End date must be on or after start date",
  path: ["endDate"],
});
export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;

// ============================================================================
// SALES TAX CODES (Sprint C)
// ============================================================================
// A tax code is a named reusable rate (e.g. "NY State 8.875%") that points at a
// liability account where collected tax accrues. Invoices reference a taxCodeId
// instead of (or in addition to) a free-form taxRate.
export const taxCodes = pgTable("tax_codes", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  name: text("name").notNull(),
  rate: doublePrecision("rate").notNull(), // percentage, e.g. 8.875
  agency: text("agency"), // "NY Dept of Taxation"
  liabilityAccountId: integer("liability_account_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export const taxCodeSchema = z.object({
  name: z.string().min(1).max(100),
  rate: z.number().min(0).max(100),
  agency: z.string().max(200).optional(),
  liabilityAccountId: z.number().int().positive(),
  isActive: z.boolean().default(true),
});
export type TaxCodeInput = z.infer<typeof taxCodeSchema>;
export type TaxCode = typeof taxCodes.$inferSelect;

// ============================================================================
// SALES-TAX NEXUS
// ============================================================================
// States where the org has a tax obligation (physical or economic nexus).
// The TaxJar integration only calculates tax for destinations in this list;
// everywhere else the obligation is 0 by rule.
export const orgNexusStates = pgTable("org_nexus_states", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  stateCode: text("state_code").notNull(), // 2-char, stored uppercase
  registrationNumber: text("registration_number"), // state sales-tax permit #
  effectiveDate: text("effective_date"), // ISO date nexus began
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});

export const nexusStateSchema = z.object({
  stateCode: z.string().regex(/^[A-Za-z]{2}$/, "Use a 2-letter state code, e.g. TX"),
  registrationNumber: z.string().max(100).nullable().optional(),
  effectiveDate: isoDate.nullable().optional(),
});
export type NexusStateInput = z.infer<typeof nexusStateSchema>;
export type OrgNexusState = typeof orgNexusStates.$inferSelect;

// ============================================================================
// PERIOD LOCKS (Sprint C)
// ============================================================================
// When a period is closed, transactions on or before that date can no longer be
// edited / posted. lockDate = inclusive cutoff (YYYY-MM-DD). Year-end close also
// posts a JE that zeroes income/expense accounts into Retained Earnings.
export const periodLocks = pgTable("period_locks", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  lockDate: text("lock_date").notNull(), // inclusive: no postings <= this date
  reason: text("reason"),
  isYearEnd: boolean("is_year_end").notNull().default(false),
  closingEntryId: integer("closing_entry_id"), // year-end: FK to journal_entries
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type PeriodLock = typeof periodLocks.$inferSelect;

export const closePeriodSchema = z.object({
  lockDate: isoDate,
  reason: z.string().max(500).optional(),
});
export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;

export const yearEndCloseSchema = z.object({
  fiscalYearEnd: isoDate,
  fiscalYearStart: isoDate.optional(),
}).refine((v) => !v.fiscalYearStart || v.fiscalYearStart < v.fiscalYearEnd, {
  message: "Fiscal year start must be before year end",
  path: ["fiscalYearStart"],
});
export type YearEndCloseInput = z.infer<typeof yearEndCloseSchema>;

// ============================================================================
// AUDIT LOG (Sprint C)
// ============================================================================
// Every mutating action (create/update/delete/post/void/match/etc.) writes an
// audit row. Single-tenant for now so user is just "system" or whoever logs in later.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  ts: timestamp("ts", { mode: "string" }).notNull().defaultNow(),
  user: text("user").notNull().default("system"),
  action: text("action").notNull(), // "create" | "update" | "delete" | "post" | "void" | "pay" | "match" | "close" | "send" | ...
  entityType: text("entity_type").notNull(), // "invoice" | "bill" | "journal_entry" | "payment" | ...
  entityId: integer("entity_id"),
  summary: text("summary").notNull(), // human-readable
  metadata: text("metadata"), // optional JSON blob for before/after diffs
});
export type AuditEntry = typeof auditLog.$inferSelect;

// ============================================================================
// INVOICE SHARE TOKENS (Sprint C)
// ============================================================================
// One row per share. Token is a long random URL-safe string. Public route
// /p/invoice/:token returns read-only invoice HTML / PDF.
export const invoiceShares = pgTable("invoice_shares", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  invoiceId: integer("invoice_id").notNull(),
  token: text("token").notNull().unique(),
  recipientEmail: text("recipient_email"),
  sentAt: text("sent_at"), // null until actually sent
  emailStatus: text("email_status"), // null | "sent" | "failed" | "queued"
  emailError: text("email_error"),
  viewedAt: text("viewed_at"),
  viewCount: integer("view_count").notNull().default(0),
  expiresAt: text("expires_at"), // ISO datetime; null = never expires (legacy rows)
  revokedAt: text("revoked_at"), // ISO datetime; non-null = invalidated
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type InvoiceShare = typeof invoiceShares.$inferSelect;

export const sendInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
  to: z.string().email().optional(),
  cc: z.string().email().or(z.literal("")).optional(),
  subject: z.string().max(200).optional(),
  body: z.string().max(10000).optional(),
});
export type SendInvoiceInput = z.infer<typeof sendInvoiceSchema>;

// ============================================================================
// BATCH RECLASSIFICATION
// ============================================================================
export const reclassifySchema = z.object({
  lineIds: z.array(z.number().int().positive()).max(10000).optional(),
  filter: z
    .object({
      fromAccountId: z.number().int().positive(),
      fromDate: isoDate.optional(),
      toDate: isoDate.optional(),
      side: z.enum(["debit", "credit", "both"]).default("both"),
      descriptionContains: z.string().max(500).optional(),
    })
    .optional(),
  toAccountId: z.number().int().positive(),
  memo: z.string().max(500).optional(),
}).refine((d) => d.lineIds || d.filter, { message: "Provide lineIds or filter" })
  .refine((d) => d.lineIds === undefined || d.lineIds.length > 0, { message: "lineIds cannot be empty" });
export type ReclassifyInput = z.infer<typeof reclassifySchema>;

// ============================================================================
// CREDIT NOTES (AR) & DEBIT NOTES (AP)
// ============================================================================
// A credit note reduces what a customer owes (AR) — issued for returns,
// pricing errors, undelivered services. It posts its own GL entry
// (Dr Revenue / Cr A/R) and can later be APPLIED against open invoices.
// A debit note is the mirror on the purchasing side: it reduces what we owe
// a vendor (Dr A/P / Cr Expense) and can be applied against open bills.
//
// NOTE ON UNITS: the original design brief called for INTEGER cents, but this
// codebase stores every monetary value (invoices, bills, journal lines) as
// REAL dollars rounded to 2dp. Credit/debit notes MUST interoperate with
// invoice.amountPaid and the GL, so they follow the same dollar convention.
// Mixing cents and dollars in one ledger would corrupt every report.

export const CREDIT_NOTE_STATUSES = ["draft", "issued", "applied", "void"] as const;
export const DEBIT_NOTE_STATUSES = ["draft", "sent", "accepted", "void"] as const;

export const creditNotes = pgTable("credit_notes", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  number: text("number").notNull(), // CN-0001, per org
  customerId: integer("customer_id").notNull(),
  invoiceId: integer("invoice_id"), // optional: which invoice this credit is against
  date: text("date").notNull(),
  status: text("status").notNull().default("draft"), // draft | issued | applied | void
  reason: text("reason").notNull(),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  tax: bigint("tax", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  total: bigint("total", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  appliedAmount: bigint("applied_amount", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  remainingCredit: bigint("remaining_credit", { mode: "number" }).notNull().default(0), // total - appliedAmount
  notes: text("notes"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type CreditNote = typeof creditNotes.$inferSelect;

export const creditNoteLines = pgTable("credit_note_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  creditNoteId: integer("credit_note_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS as entered (may be sub-cent, e.g. $0.0025/unit). All LEDGER money derived from it is integer cents: amount = Math.round(quantity * rate * 100).
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  revenueAccountId: integer("revenue_account_id").notNull(), // income (or expense for returns)
});
export type CreditNoteLine = typeof creditNoteLines.$inferSelect;

export const creditNoteApplications = pgTable("credit_note_applications", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  creditNoteId: integer("credit_note_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountApplied: bigint("amount_applied", { mode: "number" }).notNull(),
  appliedAt: timestamp("applied_at", { mode: "string" }).notNull().defaultNow(),
  appliedBy: integer("applied_by"),
});
export type CreditNoteApplication = typeof creditNoteApplications.$inferSelect;

export const debitNotes = pgTable("debit_notes", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  number: text("number").notNull(), // DN-0001, per org
  vendorId: integer("vendor_id").notNull(),
  billId: integer("bill_id"), // optional: which bill this debit note disputes
  date: text("date").notNull(),
  status: text("status").notNull().default("draft"), // draft | sent | accepted | void
  reason: text("reason").notNull(),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  tax: bigint("tax", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  total: bigint("total", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  appliedAmount: bigint("applied_amount", { mode: "number" }).notNull().default(0),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  remainingDebit: bigint("remaining_debit", { mode: "number" }).notNull().default(0),
  notes: text("notes"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
});
export type DebitNote = typeof debitNotes.$inferSelect;

export const debitNoteLines = pgTable("debit_note_lines", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  debitNoteId: integer("debit_note_id").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0), // unit price in DOLLARS as entered (may be sub-cent, e.g. $0.0025/unit). All LEDGER money derived from it is integer cents: amount = Math.round(quantity * rate * 100).
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  expenseAccountId: integer("expense_account_id").notNull(), // must be type expense
});
export type DebitNoteLine = typeof debitNoteLines.$inferSelect;

export const debitNoteApplications = pgTable("debit_note_applications", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().default(1),
  debitNoteId: integer("debit_note_id").notNull(),
  billId: integer("bill_id").notNull(),
  // Stored in cents (integer). $10.99 = 1099. Never use REAL for money.
  amountApplied: bigint("amount_applied", { mode: "number" }).notNull(),
  appliedAt: timestamp("applied_at", { mode: "string" }).notNull().defaultNow(),
  appliedBy: integer("applied_by"),
});
export type DebitNoteApplication = typeof debitNoteApplications.$inferSelect;

// ---- Input validation ----
export const createCreditNoteSchema = z.object({
  customerId: z.number().int().positive(),
  invoiceId: z.number().int().positive().optional(),
  date: isoDate,
  reason: z.string().min(1, "Reason is required").max(500),
  notes: z.string().max(2000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive("Quantity must be greater than 0"),
        rate: z.number().min(0),
        revenueAccountId: z.number().int().positive(),
      })
    )
    .min(1, "Credit note must have at least one line"),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

export const createDebitNoteSchema = z.object({
  vendorId: z.number().int().positive(),
  billId: z.number().int().positive().optional(),
  date: isoDate,
  reason: z.string().min(1, "Reason is required").max(500),
  notes: z.string().max(2000).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive("Quantity must be greater than 0"),
        rate: z.number().min(0),
        expenseAccountId: z.number().int().positive(),
      })
    )
    .min(1, "Debit note must have at least one line"),
});
export type CreateDebitNoteInput = z.infer<typeof createDebitNoteSchema>;

export const applyCreditNoteSchema = z.object({
  invoiceId: z.number().int().positive(),
  amountToApply: z.number().min(0.01, "Amount to apply must be greater than zero"),
});
export type ApplyCreditNoteInput = z.infer<typeof applyCreditNoteSchema>;

export const applyDebitNoteSchema = z.object({
  billId: z.number().int().positive(),
  amountToApply: z.number().min(0.01, "Amount to apply must be greater than zero"),
});
export type ApplyDebitNoteInput = z.infer<typeof applyDebitNoteSchema>;

export const voidNoteSchema = z.object({
  reason: z.string().min(1, "A void reason is required").max(500),
});
export type VoidNoteInput = z.infer<typeof voidNoteSchema>;


// ---------------------------------------------------------------------------
// FX RATES (manual rate management) — rate is base units per 1 foreign unit.
// ---------------------------------------------------------------------------
export const upsertFxRateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  fromCode: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR"),
  toCode: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. EUR"),
  rate: z.number().positive(),
  source: z.string().max(50).optional(),
});
export type UpsertFxRateInput = z.infer<typeof upsertFxRateSchema>;


// ---------------------------------------------------------------------------
// BUDGETS
// ---------------------------------------------------------------------------
export const createBudgetSchema = z.object({
  name: z.string().min(1).max(200),
  fiscalYear: z.number().int().min(2000).max(2100),
});
export const setBudgetLinesSchema = z.object({
  lines: z.array(z.object({
    accountId: z.number().int().positive(),
    month: z.number().int().min(1).max(12),
    amount: z.number().int(), // INTEGER CENTS — client converts at the boundary
  })).min(1).max(600),
});

// Report range query (shared by the Phase-3 report endpoints).
export const reportRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(["json", "csv"]).default("json"),
});


// ---------------------------------------------------------------------------
// WEBHOOKS
// ---------------------------------------------------------------------------
export const WEBHOOK_EVENT_NAMES = [
  "invoice.created", "invoice.paid", "invoice.voided",
  "bill.created", "bill.paid", "credit_note.issued", "period.closed",
] as const;
export const createWebhookSchema = z.object({
  url: z.string().url().max(500),
  secret: z.string().min(16, "Webhook secret must be at least 16 characters").max(200),
  events: z.array(z.enum(WEBHOOK_EVENT_NAMES)).min(1),
  isActive: z.boolean().default(true),
});
export const updateWebhookSchema = createWebhookSchema.partial();
