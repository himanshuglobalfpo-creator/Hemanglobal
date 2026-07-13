// ============================================================================
// AUTH MODULE
// ============================================================================
// Provides:
//   - Password hashing (bcryptjs — pure JS, no native build)
//   - Session creation/lookup/revocation (server-side, stored in DB)
//   - Express middleware that injects req.user, req.org, req.session
//
// Required deps to add to package.json:
//   "bcryptjs": "^2.4.3"
//   "@types/bcryptjs": "^2.4.6"
//
// Until bcryptjs is installed, this module's import will fail at runtime.
// The code is otherwise complete.

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, lt, gt } from "drizzle-orm";
import {
  users, sessions, organizations, orgMemberships,
  type User, type Session, type Organization, type OrgRole,
} from "@shared/schema";
import { buildCsrfCookie, buildClearCsrfCookie, generateCsrfToken } from "./csrf";

// ----------------------------------------------------------------------------
// DB handle — the SHARED PostgreSQL pool from storage.ts. auth.ts must never
// open its own connection (one Pool singleton for the whole app).
// ----------------------------------------------------------------------------
import { db, pool } from "./storage";
import { logger } from "./logger";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
const BCRYPT_ROUNDS = 10;
const SESSION_TTL_DAYS = 30;
const SESSION_COOKIE = "ll_session";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// ----------------------------------------------------------------------------
// Password hashing
// ----------------------------------------------------------------------------
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ----------------------------------------------------------------------------
// User CRUD
// ----------------------------------------------------------------------------
export async function createUser(email: string, password: string, name: string): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.email, email)).then((r: any[]) => r[0]);
  if (existing) throw new Error("An account with this email already exists.");
  const passwordHash = await hashPassword(password);
  const verifyToken = crypto.randomBytes(24).toString("base64url");
  const u = await db
    .insert(users)
    .values({ email: email.toLowerCase(), passwordHash, name, emailVerifyToken: verifyToken })
    .returning().then((r) => r[0]);
  return u;
}

export async function getUserById(id: number): Promise<User | undefined> {
  return await db.select().from(users).where(eq(users.id, id)).then((r: any[]) => r[0]);
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  return await db.select().from(users).where(eq(users.email, email.toLowerCase())).then((r: any[]) => r[0]);
}

// ----------------------------------------------------------------------------
// Org membership
// ----------------------------------------------------------------------------
export async function createOrg(name: string, slug: string): Promise<Organization> {
  const exists = await db.select().from(organizations).where(eq(organizations.slug, slug)).then((r: any[]) => r[0]);
  if (exists) throw new Error(`Slug "${slug}" is already taken.`);
  return await db.insert(organizations).values({ name, slug }).returning().then((r) => r[0]);
}

export async function addMember(userId: number, orgId: number, role: OrgRole = "owner") {
  const existing = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (existing) {
    await db.update(orgMemberships)
      .set({ role })
      .where(eq(orgMemberships.id, existing.id))
      ;
    return existing;
  }
  return await db.insert(orgMemberships).values({ userId, orgId, role }).returning().then((r) => r[0]);
}

export async function listOrgsForUser(userId: number): Promise<Array<Organization & { role: OrgRole }>> {
  const rows = (await pool.query(`
      SELECT o.*, m.role AS role
      FROM organizations o
      JOIN org_memberships m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.name
    `, [userId])).rows as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    fiscalYearEndMonth: r.fy_end_month,
    fiscalYearEndDay: r.fy_end_day,
    baseCurrency: r.base_currency,
    timezone: r.timezone,
    stripeClearingAccountId: r.stripe_clearing_account_id ?? null,
    allowNegativeStock: r.allow_negative_stock ?? false,
    costingMethod: r.costing_method ?? "average",
    strictFutureDates: r.strict_future_dates ?? false,
    futureDatedGraceDays: r.future_dated_grace_days ?? 0,
    enableClassTracking: r.enable_class_tracking ?? false,
    enableLocationTracking: r.enable_location_tracking ?? false,
    enableProjectTracking: r.enable_project_tracking ?? false,
    addressCity: r.address_city ?? null,
    addressState: r.address_state ?? null,
    addressZip: r.address_zip ?? null,
    createdAt: r.created_at,
    role: r.role,
  }));
}

export async function getMembership(userId: number, orgId: number) {
  return db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)))
    .then((r: any[]) => r[0]);
}

// ----------------------------------------------------------------------------
// Sessions
// ----------------------------------------------------------------------------
export async function createSession(userId: number, orgId: number | null, req: Request): Promise<Session> {
  const id = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86400_000);
  return db
    .insert(sessions)
    .values({
      id,
      userId,
      activeOrgId: orgId,
      expiresAt: expires.toISOString(),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: (req.get("user-agent") || "").slice(0, 500),
    })
    .returning().then((r) => r[0]);
}

export async function getSession(id: string): Promise<Session | undefined> {
  if (!id || typeof id !== "string") return undefined;
  const s = await db.select().from(sessions).where(eq(sessions.id, id)).then((r: any[]) => r[0]);
  if (!s) return undefined;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    // Expired — delete and return nothing
    await db.delete(sessions).where(eq(sessions.id, id));
    return undefined;
  }
  return s;
}

export async function touchSession(id: string) {
  await db.update(sessions).set({ lastSeenAt: new Date().toISOString() }).where(eq(sessions.id, id));
}

export async function revokeSession(id: string) {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function revokeAllSessionsForUser(userId: number) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function setActiveOrg(sessionId: string, orgId: number) {
  await db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, sessionId));
}

// Periodic cleanup: delete expired sessions hourly
export function startSessionCleanup() {
  const interval = setInterval(() => {
    db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).catch((e) => logger.warn("[auth] session cleanup failed", { error: e?.message }));
  }, 3600_000);
  if (typeof interval.unref === "function") interval.unref();
}

// ----------------------------------------------------------------------------
// Account lockout (brute-force protection)
// ----------------------------------------------------------------------------
export async function recordFailedLogin(userId: number) {
  const u = await getUserById(userId);
  if (!u) return;
  const fails = (u.failedLoginAttempts || 0) + 1;
  const updates: any = { failedLoginAttempts: fails };
  if (fails >= MAX_FAILED_LOGINS) {
    updates.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
  }
  await db.update(users).set(updates).where(eq(users.id, userId));
}

export async function clearFailedLogins(userId: number) {
  await db.update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date().toISOString() })
    .where(eq(users.id, userId))
    ;
}

export function isLocked(user: User): boolean {
  if (!user.lockedUntil) return false;
  return new Date(user.lockedUntil).getTime() > Date.now();
}

// ----------------------------------------------------------------------------
// Express middleware
// ----------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      session?: Session;
      user?: User;
      org?: Organization;
      role?: OrgRole;
    }
  }
}

// Reads session ID from cookie or Authorization: Bearer header.
function readSessionId(req: Request): string | undefined {
  // Prefer cookie (browser flow)
  const cookies = req.headers.cookie || "";
  const m = cookies.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (m) return decodeURIComponent(m[1]);
  // Fallback: Bearer token (for API clients / tests)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

// Sets the session cookie. Secure flag in production.
// ALSO issues the CSRF double-submit cookie: every response that establishes a
// session must give the client a fresh readable token (see server/csrf.ts).
export function setSessionCookie(res: Response, sessionId: string) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_TTL_DAYS * 86400}`,
    "SameSite=Lax",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", [parts.join("; "), buildCsrfCookie(generateCsrfToken())]);
}

export function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    buildClearCsrfCookie(),
  ]);
}

// Loads session/user/org if present, but does NOT enforce auth.
// Use for routes that have both authenticated and anonymous flows.
export async function attachSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const id = readSessionId(req);
    if (!id) return next();
    const s = await getSession(id);
    if (!s) return next();
    req.session = s;
    const u = await getUserById(s.userId);
    if (!u) return next();
    req.user = u;
    if (s.activeOrgId) {
      const o = await db.select().from(organizations).where(eq(organizations.id, s.activeOrgId)).then((r: any[]) => r[0]);
      if (o) {
        req.org = o;
        const m = await getMembership(u.id, o.id);
        if (m) req.role = m.role as OrgRole;
      }
    }
    // Touch the session in the background — we don't block the request on it
    touchSession(s.id).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

// Hard guard: 401 if not logged in.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

// Hard guard: 401 if not logged in, 403 if no active org.
export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!req.org) {
    res.status(403).json({ error: "No active organization. Pick one with POST /api/auth/switch-org." });
    return;
  }
  next();
}

// Role-based guard. Use AFTER requireOrg.
export function requireRole(...allowed: OrgRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.role || !allowed.includes(req.role)) {
      res.status(403).json({ error: `This action requires one of: ${allowed.join(", ")}` });
      return;
    }
    next();
  };
}
