// ============================================================================
// AUTH ROUTES
// ============================================================================
// Wire into the main app via:
//   import { registerAuthRoutes } from "./auth-routes";
//   registerAuthRoutes(app);
//
// Routes:
//   POST   /api/auth/signup            { email, password, name, orgName }
//   POST   /api/auth/login             { email, password }
//   POST   /api/auth/logout
//   GET    /api/auth/me                returns { user, org, role, orgs[] }
//   POST   /api/auth/switch-org        { orgId }
//   POST   /api/auth/request-password-reset { email }
//   POST   /api/auth/reset-password    { token, newPassword }
//   POST   /api/orgs                   { name, slug }     create new org
//   POST   /api/orgs/:id/invite        { email, role }    invite member (role-gated)

import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  signupSchema, loginSchema, inviteUserSchema,
  requestPasswordResetSchema, resetPasswordSchema,
  insertOrgSchema, type OrgRole,
} from "@shared/schema";
import {
  createUser, getUserByEmail, getUserById, verifyPassword,
  createOrg, addMember, listOrgsForUser, getMembership,
  createSession, revokeSession, setActiveOrg,
  setSessionCookie, clearSessionCookie,
  recordFailedLogin, clearFailedLogins, isLocked,
  hashPassword,
} from "./auth";
import crypto from "node:crypto";
import { sendEmail, appBaseUrl } from "./email";
import { authLimiter } from "./rate-limit";
import { seedOrgDefaults } from "./storage";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateTotpSecret, verifyTotp, otpauthUri, generateRecoveryCodes } from "./totp";
import { encryptSecret, decryptSecret } from "./crypto-vault";
import { users, organizations, accounts } from "@shared/schema";
import { db, pool } from "./storage";
import { logger } from "./logger";

// Same patterns as routes.ts — keep duplicates minimal but localized.
function handle<T>(res: Response, fn: () => Promise<T> | T) {
  Promise.resolve()
    .then(fn)
    .then((out) => res.json(out))
    .catch((err: any) => {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Validation failed", details: err.errors });
        return;
      }
      const msg = err?.message || "Server error";
      const userError = /not found|missing|required|invalid|exists|locked|expired|incorrect/i.test(msg);
      res.status(userError ? 400 : 500).json({ error: msg });
      if (!userError) logger.error("Auth route error", { error: msg, stack: err?.stack?.split("\n").slice(0, 5).join(" | ") });
    });
}

// Slugify org name → URL-safe slug. Falls back to a random suffix if collision.
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "org"
  );
}

export function registerAuthRoutes(app: Express) {
  // ------ SIGNUP -------------------------------------------------------------
  // Creates user + org + owner membership in a single transaction.
  // Sends the verify-email message for a freshly created (or resend-requested)
  // user. Fire-and-forget like the reset flow: send failures are logged, never
  // surfaced. Non-production logs the token so local flows work without SMTP.
  async function sendVerificationEmail(u: { id: number; email: string; name: string | null; emailVerifyToken: string | null }) {
    if (!u.emailVerifyToken) return;
    const verifyUrl = `${appBaseUrl()}/#/verify-email?token=${encodeURIComponent(u.emailVerifyToken)}`;
    sendEmail({
      to: u.email,
      subject: "Verify your LedgerLite email",
      text: [
        `Hi ${u.name || ""},`,
        ``,
        `Welcome to LedgerLite. Please verify your email address:`,
        ``,
        verifyUrl,
        ``,
        `You have 24 hours of full access before verification is required.`,
      ].join("\n"),
    }).then((r) => {
      if (!r.ok) logger.error("[verify email] send failed", { userId: u.id, error: r.error });
    });
    if (process.env.NODE_ENV !== "production") {
      logger.info("[verify email] token issued (dev)", { email: u.email, token: u.emailVerifyToken });
    }
  }

  app.post("/api/auth/signup", authLimiter, (req, res) =>
    handle(res, async () => {
      const data = signupSchema.parse(req.body);
      const u = await createUser(data.email, data.password, data.name);
      await sendVerificationEmail(u);
      let slug = slugify(data.orgName);
      // Cheap collision avoidance: append random suffix if slug taken
      try {
        const o = await createOrg(data.orgName, slug);
        await addMember(u.id, o.id, "owner");
        await seedOrgDefaults(o.id);
        const s = await createSession(u.id, o.id, req);
        setSessionCookie(res, s.id);
        return { user: { id: u.id, email: u.email, name: u.name }, org: { id: o.id, name: o.name, slug: o.slug }, role: "owner" };
      } catch (e: any) {
        if (/slug.*taken/i.test(e?.message || "")) {
          slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
          const o = await createOrg(data.orgName, slug);
          await addMember(u.id, o.id, "owner");
          await seedOrgDefaults(o.id);
          const s = await createSession(u.id, o.id, req);
          setSessionCookie(res, s.id);
          return { user: { id: u.id, email: u.email, name: u.name }, org: { id: o.id, name: o.name, slug: o.slug }, role: "owner" };
        }
        throw e;
      }
    })
  );

  // ------ LOGIN --------------------------------------------------------------
  app.post("/api/auth/login", authLimiter, (req, res) =>
    handle(res, async () => {
      const data = loginSchema.parse(req.body);
      const u = await getUserByEmail(data.email);
      // Generic error: do not leak whether the email exists
      const generic = "Email or password is incorrect";
      if (!u) throw new Error(generic);
      if (isLocked(u)) {
        throw new Error(`Account temporarily locked due to failed login attempts. Try again in a few minutes.`);
      }
      const ok = await verifyPassword(data.password, u.passwordHash);
      if (!ok) {
        await recordFailedLogin(u.id);
        throw new Error(generic);
      }
      await clearFailedLogins(u.id);
      // MFA branch: correct password but TOTP enabled → hand back a short-lived
      // single-use challenge token instead of a session. The challenge is NOT
      // a session — it can only be exchanged at /api/auth/mfa/verify.
      if (u.totpEnabled) {
        const mfaToken = crypto.randomBytes(24).toString("base64url");
        const expires = new Date(Date.now() + 5 * 60_000).toISOString(); // 5 minutes
        await pool.query(
          `INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES ($1, $2, $3)`,
          [mfaToken, u.id, expires]
        );
        return { mfaRequired: true, mfaToken };
      }
      // Pick the user's first org (or null if none)
      const orgs = await listOrgsForUser(u.id);
      const activeOrg = orgs[0] || null;
      const s = await createSession(u.id, activeOrg?.id ?? null, req);
      setSessionCookie(res, s.id);
      return {
        user: { id: u.id, email: u.email, name: u.name },
        org: activeOrg ? { id: activeOrg.id, name: activeOrg.name, slug: activeOrg.slug } : null,
        role: activeOrg?.role ?? null,
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
      };
    })
  );

  // ------ MFA (TOTP) ----------------------------------------------------------
  // Setup: mint a secret, store it ENCRYPTED but PENDING (totp_enabled stays
  // false until the user proves possession by submitting a valid code).
  app.post("/api/auth/mfa/setup", (req, res) =>
    handle(res, async () => {
      if (!req.user) { res.status(401).json({ error: "Authentication required." }); return; }
      const secret = generateTotpSecret();
      await db.update(users)
        .set({ totpSecret: encryptSecret(secret), totpEnabled: false })
        .where(eq(users.id, req.user.id))
        ;
      return {
        secret, // manual-entry key for the authenticator app
        otpauthUri: otpauthUri(secret, req.user.email),
        message: "Scan or enter the secret in your authenticator, then confirm a code at /api/auth/mfa/enable.",
      };
    })
  );

  // Enable: verify a live code against the pending secret; on success persist
  // totp_enabled and return the 8 recovery codes IN PLAINTEXT — the only time
  // they are ever visible. We store only bcrypt hashes.
  app.post("/api/auth/mfa/enable", (req, res) =>
    handle(res, async () => {
      if (!req.user) { res.status(401).json({ error: "Authentication required." }); return; }
      const code = String(req.body?.code || "");
      const fresh = await getUserById(req.user.id);
      if (!fresh?.totpSecret) throw new Error("Run /api/auth/mfa/setup first.");
      if (fresh.totpEnabled) throw new Error("MFA is already enabled.");
      const secret = decryptSecret(fresh.totpSecret);
      if (!verifyTotp(secret, code)) throw new Error("Invalid authenticator code. Check your device clock and try again.");
      const recovery = generateRecoveryCodes(8);
      const hashes = await Promise.all(recovery.map((c) => bcrypt.hash(c, 10)));
      await db.update(users)
        .set({ totpEnabled: true, recoveryCodes: JSON.stringify(hashes) })
        .where(eq(users.id, req.user.id))
        ;
      return {
        ok: true,
        recoveryCodes: recovery,
        message: "MFA enabled. Store these recovery codes now — they will not be shown again.",
      };
    })
  );

  // Disable: requires BOTH the password and a live code (or a recovery code)
  // so a hijacked session alone cannot strip MFA.
  app.post("/api/auth/mfa/disable", (req, res) =>
    handle(res, async () => {
      if (!req.user) { res.status(401).json({ error: "Authentication required." }); return; }
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "");
      const fresh = await getUserById(req.user.id);
      if (!fresh?.totpEnabled || !fresh.totpSecret) throw new Error("MFA is not enabled.");
      if (!(await verifyPassword(password, fresh.passwordHash))) throw new Error("Password is incorrect.");
      const secret = decryptSecret(fresh.totpSecret);
      let codeOk = verifyTotp(secret, code);
      if (!codeOk && fresh.recoveryCodes) {
        const hashes: string[] = JSON.parse(fresh.recoveryCodes);
        for (const h of hashes) if (await bcrypt.compare(code, h)) { codeOk = true; break; }
      }
      if (!codeOk) throw new Error("Invalid authenticator or recovery code.");
      await db.update(users)
        .set({ totpEnabled: false, totpSecret: null, recoveryCodes: null })
        .where(eq(users.id, req.user.id))
        ;
      return { ok: true, message: "MFA disabled." };
    })
  );

  // Verify: exchanges a login challenge + code (or single-use recovery code)
  // for a real session. Per-token attempt cap = 5 (the token also dies after
  // 5 minutes), satisfying the 5/min-per-token rate limit by construction.
  app.post("/api/auth/mfa/verify", authLimiter, (req, res) =>
    handle(res, async () => {
      const mfaToken = String(req.body?.mfaToken || "");
      const code = String(req.body?.code || req.body?.recoveryCode || "");
      if (!mfaToken || !code) throw new Error("mfaToken and code are required.");
      const ch = (await pool.query(
        `UPDATE mfa_challenges SET attempts = attempts + 1
          WHERE id = $1 AND expires_at > now()
          RETURNING user_id, attempts`,
        [mfaToken]
      )).rows[0] as { user_id: number; attempts: number } | undefined;
      if (!ch) throw new Error("Invalid or expired MFA challenge. Log in again.");
      if (ch.attempts > 5) {
        await pool.query(`DELETE FROM mfa_challenges WHERE id = $1`, [mfaToken]);
        throw new Error("Too many attempts on this challenge. Log in again.");
      }
      const u = await getUserById(ch.user_id);
      if (!u?.totpEnabled || !u.totpSecret) throw new Error("MFA is not enabled for this account.");
      const secret = decryptSecret(u.totpSecret);
      let ok = verifyTotp(secret, code);
      if (!ok && u.recoveryCodes) {
        // Recovery path: compare against every remaining hash; on match REMOVE
        // that hash so the code is single-use.
        const hashes: string[] = JSON.parse(u.recoveryCodes);
        for (let i = 0; i < hashes.length; i++) {
          if (await bcrypt.compare(code.toUpperCase(), hashes[i]) || await bcrypt.compare(code, hashes[i])) {
            hashes.splice(i, 1);
            await db.update(users).set({ recoveryCodes: JSON.stringify(hashes) }).where(eq(users.id, u.id));
            ok = true;
            break;
          }
        }
      }
      if (!ok) throw new Error("Invalid authenticator or recovery code.");
      // Success: burn the challenge, mint the real session.
      await pool.query(`DELETE FROM mfa_challenges WHERE id = $1`, [mfaToken]);
      const orgs = await listOrgsForUser(u.id);
      const activeOrg = orgs[0] || null;
      const s = await createSession(u.id, activeOrg?.id ?? null, req);
      setSessionCookie(res, s.id);
      return {
        user: { id: u.id, email: u.email, name: u.name },
        org: activeOrg ? { id: activeOrg.id, name: activeOrg.name, slug: activeOrg.slug } : null,
        role: activeOrg?.role ?? null,
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
      };
    })
  );

  // ------ LOGOUT -------------------------------------------------------------
  app.post("/api/auth/logout", (req, res) =>
    handle(res, async () => {
      const sid = req.session?.id;
      if (sid) await revokeSession(sid);
      clearSessionCookie(res);
      return { ok: true };
    })
  );

  // ------ ME -----------------------------------------------------------------
  app.get("/api/auth/me", (req, res) =>
    handle(res, async () => {
      if (!req.user) return { user: null, org: null, role: null, orgs: [] };
      const orgs = await listOrgsForUser(req.user.id);
      return {
        user: {
          id: req.user.id,
          email: req.user.email,
          name: req.user.name,
          // Client mirrors the server's 24h-grace verification rule with these:
          emailVerified: req.user.emailVerified,
          createdAt: req.user.createdAt,
        },
        org: req.org
          ? {
              id: req.org.id,
              name: req.org.name,
              slug: req.org.slug,
              addressCity: (req.org as any).addressCity ?? null,
              addressState: (req.org as any).addressState ?? null,
              addressZip: (req.org as any).addressZip ?? null,
              stripeClearingAccountId: (req.org as any).stripeClearingAccountId ?? null,
            }
          : null,
        role: req.role ?? null,
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
      };
    })
  );

  // ------ SWITCH ORG ---------------------------------------------------------
  app.post("/api/auth/switch-org", (req, res) =>
    handle(res, async () => {
      if (!req.user || !req.session) throw new Error("Authentication required");
      const orgId = Number(req.body?.orgId);
      if (!Number.isInteger(orgId) || orgId <= 0) throw new Error("Invalid orgId");
      const m = await getMembership(req.user.id, orgId);
      if (!m) throw new Error("You are not a member of this organization.");
      await setActiveOrg(req.session.id, orgId);
      return { ok: true, orgId };
    })
  );

  // ------ PASSWORD RESET REQUEST --------------------------------------------
  // Always returns success to avoid leaking which emails exist.
  app.post("/api/auth/request-password-reset", authLimiter, (req, res) =>
    handle(res, async () => {
      const data = requestPasswordResetSchema.parse(req.body);
      const u = await getUserByEmail(data.email);
      if (u) {
        const token = crypto.randomBytes(24).toString("base64url");
        const expires = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour
        await db.update(users)
          .set({ passwordResetToken: token, passwordResetExpires: expires })
          .where(eq(users.id, u.id))
          ;
        const resetUrl = `${appBaseUrl()}/#/reset-password?token=${encodeURIComponent(token)}`;
        // Fire-and-forget: the response must not reveal whether the email exists,
        // so we never surface a send failure to the caller — just log it.
        sendEmail({
          to: u.email,
          subject: "Reset your LedgerLite password",
          text: [
            `Hi ${u.name || ""},`,
            ``,
            `Someone (hopefully you) requested a password reset for your LedgerLite account.`,
            `Reset it here (link expires in 1 hour):`,
            ``,
            resetUrl,
            ``,
            `If you didn't request this, you can safely ignore this email.`,
          ].join("\n"),
        }).then((r) => {
          if (!r.ok) logger.error("[password reset] email send failed", { userId: u.id, error: r.error });
        });
        if (process.env.NODE_ENV !== "production") {
          logger.info("[password reset] token issued (dev)", { email: u.email, token });
        }
      }
      return { ok: true, message: "If that email is registered, a reset link has been sent." };
    })
  );

  // ------ PASSWORD RESET -----------------------------------------------------
  app.post("/api/auth/reset-password", authLimiter, (req, res) =>
    handle(res, async () => {
      const data = resetPasswordSchema.parse(req.body);
      const u = await db.select().from(users).where(eq(users.passwordResetToken, data.token)).then((r: any[]) => r[0]);
      if (!u) throw new Error("Invalid or expired reset token");
      if (!u.passwordResetExpires || new Date(u.passwordResetExpires).getTime() < Date.now()) {
        throw new Error("Reset token has expired");
      }
      const newHash = await hashPassword(data.newPassword);
      await db.update(users)
        .set({
          passwordHash: newHash,
          passwordResetToken: null,
          passwordResetExpires: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, u.id))
        ;
      // Revoke all existing sessions — force re-login on every device
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
      return { ok: true, message: "Password reset. Please log in." };
    })
  );

  // ------ EMAIL VERIFICATION -------------------------------------------------
  app.post("/api/auth/verify-email", authLimiter, (req, res) =>
    handle(res, async () => {
      const token = String(req.body?.token || "");
      if (!token) throw new Error("Verification token is required");
      const u = await db.select().from(users).where(eq(users.emailVerifyToken, token)).then((r: any[]) => r[0]);
      if (!u) throw new Error("Invalid or expired verification token");
      await db.update(users)
        .set({ emailVerified: true, emailVerifyToken: null })
        .where(eq(users.id, u.id))
        ;
      return { ok: true, message: "Email verified. Thanks!" };
    })
  );

  // Authenticated resend: regenerates the token (invalidates the old link) and
  // re-sends. authLimiter keeps this from becoming an email cannon.
  app.post("/api/auth/resend-verification", authLimiter, (req, res) =>
    handle(res, async () => {
      if (!req.user) { res.status(401).json({ error: "Authentication required." }); return; }
      if (req.user.emailVerified) return { ok: true, message: "Email is already verified." };
      const newToken = crypto.randomBytes(24).toString("base64url");
      await db.update(users)
        .set({ emailVerifyToken: newToken })
        .where(eq(users.id, req.user.id))
        ;
      await sendVerificationEmail({ id: req.user.id, email: req.user.email, name: req.user.name, emailVerifyToken: newToken });
      return { ok: true, message: "Verification email sent." };
    })
  );

  // ------ CREATE ORG ---------------------------------------------------------
  app.post("/api/orgs", (req, res) =>
    handle(res, async () => {
      if (!req.user) throw new Error("Authentication required");
      const data = insertOrgSchema.parse(req.body);
      const o = await createOrg(data.name, data.slug);
      await addMember(req.user.id, o.id, "owner");
      await seedOrgDefaults(o.id);
      return o;
    })
  );

  // ------ UPDATE ORG SETTINGS -------------------------------------------------
  // Owner/admin. Currently: ship-from address (required for TaxJar calculations).
  app.patch("/api/orgs/:id", (req, res) =>
    handle(res, async () => {
      if (!req.user || !req.org) throw new Error("Authentication required");
      const orgId = Number(req.params.id);
      if (orgId !== req.org.id) throw new Error("Can only update your active org");
      if (req.role !== "owner" && req.role !== "admin") throw new Error("Owner/admin only");
      const schema = z.object({
        name: z.string().min(1).max(200).optional(),
        addressCity: z.string().max(120).nullable().optional(),
        addressState: z.string().regex(/^[A-Za-z]{2}$/, "Use a 2-letter state code").nullable().optional(),
        addressZip: z.string().regex(/^\d{5}(-\d{4})?$/, "Use a 5-digit ZIP").nullable().optional(),
        // Stripe clearing account — where online payments settle. null clears
        // the setting (which DISABLES online payments; the webhook refuses to
        // guess an account).
        stripeClearingAccountId: z.number().int().positive().nullable().optional(),
      });
      const data = schema.parse(req.body);
      const updates: Record<string, unknown> = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.addressCity !== undefined) updates.addressCity = data.addressCity;
      if (data.addressState !== undefined) updates.addressState = data.addressState ? data.addressState.toUpperCase() : data.addressState;
      if (data.addressZip !== undefined) updates.addressZip = data.addressZip;
      if (data.stripeClearingAccountId !== undefined) {
        if (data.stripeClearingAccountId !== null) {
          // Must be a bank-subtype asset account in THIS org. Validating here
          // (not only at webhook time) means a misconfiguration is caught by
          // the person clicking Save, not by a failing payment at 2am.
          const acct = await db
            .select()
            .from(accounts)
            .where(and(eq(accounts.id, data.stripeClearingAccountId), eq(accounts.orgId, orgId)))
            .then((r: any[]) => r[0]);
          if (!acct) throw new Error("Stripe clearing account not found in this organization");
          if (acct.type !== "asset" || acct.subtype !== "bank") {
            throw new Error(
              `Stripe clearing account must be a bank-subtype asset account — "${acct.code} ${acct.name}" is ${acct.type}/${acct.subtype}`
            );
          }
        }
        updates.stripeClearingAccountId = data.stripeClearingAccountId;
      }
      if (Object.keys(updates).length === 0) throw new Error("No fields to update");
      const row = await db.update(organizations).set(updates).where(eq(organizations.id, orgId)).returning().then((r: any[]) => r[0]);
      return row;
    })
  );

  // ------ INVITE MEMBER ------------------------------------------------------
  // Owner/admin only. Creates a placeholder user if email isn't registered yet.
  app.post("/api/orgs/:id/invite", (req, res) =>
    handle(res, async () => {
      if (!req.user || !req.org) throw new Error("Authentication required");
      const orgId = Number(req.params.id);
      if (orgId !== req.org.id) throw new Error("Can only invite to your active org");
      if (req.role !== "owner" && req.role !== "admin") throw new Error("Owner/admin only");
      const data = inviteUserSchema.parse(req.body);
      let u = await getUserByEmail(data.email);
      if (!u) {
        // Create a placeholder user with a random password — they'll set it via password reset flow
        const tempPw = crypto.randomBytes(16).toString("base64url");
        u = await createUser(data.email, tempPw, data.email.split("@")[0]);
        // Generate password-reset token immediately so the invite email has a link
        const token = crypto.randomBytes(24).toString("base64url");
        const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
        await db.update(users)
          .set({ passwordResetToken: token, passwordResetExpires: expires })
          .where(eq(users.id, u.id))
          ;
        const setupUrl = `${appBaseUrl()}/#/reset-password?token=${encodeURIComponent(token)}`;
        const inviteSend = await sendEmail({
          to: data.email,
          subject: `You've been invited to ${req.org.name} on LedgerLite`,
          text: [
            `${req.user.name || req.user.email} invited you to join "${req.org.name}" on LedgerLite as ${data.role}.`,
            ``,
            `Set your password to get started (link expires in 7 days):`,
            ``,
            setupUrl,
          ].join("\n"),
        });
        if (!inviteSend.ok) {
          logger.error("[invite] email send failed", { email: data.email, error: inviteSend.error });
        }
        if (process.env.NODE_ENV !== "production") {
          logger.info("[invite] setup token issued (dev)", { email: data.email, org: req.org.name, token });
        }
      } else {
        // Existing user: notify them they've been added (no credential link needed)
        sendEmail({
          to: data.email,
          subject: `You've been added to ${req.org.name} on LedgerLite`,
          text: `${req.user.name || req.user.email} added you to "${req.org.name}" on LedgerLite as ${data.role}. Log in at ${appBaseUrl()} and switch organizations to access it.`,
        }).then((r) => {
          if (!r.ok) logger.error("[invite] notification send failed", { email: data.email, error: r.error });
        });
      }
      const m = await addMember(u.id, orgId, data.role);
      return { membership: m, userExisted: !u.emailVerifyToken };
    })
  );
}
