// ============================================================================
// AUTH & MULTI-TENANCY
// ============================================================================
// Drop-in addendum to shared/schema.ts. Add the contents of this file just
// before the existing exports begin (after the imports), and `export *` from
// the main schema file.

import { pgTable, text, integer, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";

// ---------- ORGS ----------
// One row per tenant. Every business-data table gains an `org_id` column that
// FKs here. Reports and queries scope to a single org via middleware.
export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),  // URL-safe identifier
  fiscalYearEndMonth: integer("fy_end_month").notNull().default(12),  // 1-12
  fiscalYearEndDay: integer("fy_end_day").notNull().default(31),
  baseCurrency: text("base_currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("UTC"),
  // Ship-from address for sales-tax calculation (TaxJar from_* params).
  addressCity: text("address_city"),
  addressState: text("address_state"), // 2-char, e.g. "TX"
  addressZip: text("address_zip"),
  // Bank-subtype asset account that Stripe payments settle into. NULLABLE:
  // when unset, online payments are disabled and the Stripe webhook fails
  // loudly rather than guessing an account (see server/stripe.ts).
  stripeClearingAccountId: integer("stripe_clearing_account_id"),
  // Inventory policy: when false (default), selling a stock item below zero
  // on-hand is BLOCKED. When true, the sale is allowed and the resulting
  // negative stock surfaces as a warning on the inventory-valuation report.
  allowNegativeStock: boolean("allow_negative_stock").notNull().default(false),
  // Future-dated document policy (BUG-005). A document (invoice/bill/journal
  // entry) dated more than `futureDatedGraceDays` beyond today is flagged.
  // strictFutureDates=false → the API returns a `warnings` array the client can
  // surface; strictFutureDates=true → the write is rejected outright.
  strictFutureDates: boolean("strict_future_dates").notNull().default(false),
  futureDatedGraceDays: integer("future_dated_grace_days").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type Organization = typeof organizations.$inferSelect;

// ---------- USERS ----------
// Auth identity. A user can belong to multiple orgs via `org_memberships`.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),  // bcrypt
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerifyToken: text("email_verify_token"),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpires: text("password_reset_expires"),
  // MFA: secret in crypto-vault v1 format; recovery_codes = JSON array of
  // bcrypt hashes, each removed on use (single-use by construction).
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  recoveryCodes: text("recovery_codes"),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),  // ISO datetime; null = not locked
  lastLoginAt: text("last_login_at"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type User = typeof users.$inferSelect;

// ---------- ORG MEMBERSHIPS ----------
// Many-to-many between users and orgs, with role.
export const ORG_ROLES = ["owner", "admin", "accountant", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const orgMemberships = pgTable("org_memberships", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  orgId: integer("org_id").notNull(),
  role: text("role").notNull().default("owner"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
export type OrgMembership = typeof orgMemberships.$inferSelect;

// ---------- SESSIONS ----------
// Server-side session table (we do not want JWT here — accounting data deserves
// the ability to revoke sessions instantly, e.g. when an employee leaves).
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),  // 32-byte random hex
  userId: integer("user_id").notNull(),
  activeOrgId: integer("active_org_id"),  // currently selected org for this session
  expiresAt: text("expires_at").notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  lastSeenAt: text("last_seen_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});
export type Session = typeof sessions.$inferSelect;

// ---------- ZOD SCHEMAS ----------
// ---------------------------------------------------------------------------
// PASSWORD COMPLEXITY (shared by signup and password reset):
//   - minimum 10 characters
//   - at least 3 of the 4 character classes: lowercase, uppercase, digit, symbol
// Signup additionally rejects passwords that contain the email's local part
// (case-insensitive) — "alice" must not be inside alice@example.com's password.
// ---------------------------------------------------------------------------
const PASSWORD_COMPLEXITY_MESSAGE =
  "Password must be at least 10 characters and include at least 3 of: lowercase letter, uppercase letter, digit, symbol";

function passwordMeetsComplexity(pw: string): boolean {
  if (pw.length < 10) return false;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  return classes >= 3;
}

const complexPassword = z
  .string()
  .max(200)
  .refine(passwordMeetsComplexity, { message: PASSWORD_COMPLEXITY_MESSAGE });

export const signupSchema = z
  .object({
    email: z.string().email().max(200),
    password: complexPassword,
    name: z.string().min(1).max(200),
    orgName: z.string().min(1).max(200),
  })
  .superRefine((data, ctx) => {
    // Email-containment check needs both fields → superRefine on the object.
    const localPart = data.email.split("@")[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && data.password.toLowerCase().includes(localPart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Password must not contain your email address",
      });
    }
  });
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: complexPassword,
});

export const insertOrgSchema = createInsertSchema(organizations)
  .omit({ id: true, createdAt: true })
  .extend({
    name: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "lowercase letters, numbers, hyphens; cannot start/end with hyphen").max(60),
    fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
    fiscalYearEndDay: z.number().int().min(1).max(31).default(31),
  });
export type InsertOrg = z.infer<typeof insertOrgSchema>;
