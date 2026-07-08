/**
 * server/auth.ts — session auth, role guard, and the TASK 2 MFA gate.
 * Sessions are opaque random tokens in the sessions table, sent as an
 * httpOnly cookie. No cookie library needed — we parse the one cookie we set.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db.js";
import type { Role } from "../shared/schema.js";

export interface AuthContext {
  userId: number;
  orgId: number;
  role: Role;
  email: string;
  totpEnabled: boolean;
  userCreatedAt: string;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx?: AuthContext;
  }
}

const SESSION_TTL_DAYS = 14;
export const SESSION_COOKIE = "ledgerlite_sid";

export function createSession(userId: number, orgId: number): string {
  // Opportunistic housekeeping: purge expired sessions and MFA challenges so
  // neither table grows without bound (cheap: both hit indexed/small tables).
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("DELETE FROM mfa_challenges WHERE expires_at <= datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id, org_id, expires_at) VALUES (?,?,?, datetime('now', ?))")
    .run(token, userId, orgId, `+${SESSION_TTL_DAYS} days`);
  return token;
}

export function destroySession(token: string): void {
  // Intentionally not org-scoped: sessions are keyed by a 256-bit opaque
  // token that is itself the credential (users/orgs are pre-auth tables).
  db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_DAYS * 24 * 3600 * 1000,
  });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      const raw = rest.join("=");
      // A malformed percent-sequence must not 500 every request: fall back
      // to the raw value (our tokens are hex and never need decoding anyway).
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

/** Attaches req.ctx when a valid session cookie is present. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();
  const row = db
    .prepare(
      `SELECT s.user_id, s.org_id, ou.role, u.email, u.totp_enabled, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN org_users ou ON ou.user_id = s.user_id AND ou.org_id = s.org_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as
    | { user_id: number; org_id: number; role: Role; email: string; totp_enabled: number; created_at: string }
    | undefined;
  if (row) {
    req.ctx = {
      userId: row.user_id,
      orgId: row.org_id,
      role: row.role,
      email: row.email,
      totpEnabled: row.totp_enabled === 1,
      userCreatedAt: row.created_at,
    };
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.ctx) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.ctx) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (!roles.includes(req.ctx.role)) {
      res.status(403).json({ error: `requires role: ${roles.join(" or ")}` });
      return;
    }
    next();
  };
}

const MFA_GRACE_DAYS = 7;

/**
 * TASK 2 enforcement — mirrors the email-verification gate pattern:
 * owners get a 7-day grace window from account creation; after that every
 * business API call returns 403 { code: "MFA_REQUIRED" } until TOTP is on.
 * Auth routes stay reachable so the owner can actually enroll.
 */
export function enforceOwnerMfa(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.ctx;
  if (!ctx || ctx.role !== "owner" || ctx.totpEnabled) return next();
  const createdMs = Date.parse(ctx.userCreatedAt.replace(" ", "T") + "Z");
  const graceEndsMs = createdMs + MFA_GRACE_DAYS * 24 * 3600 * 1000;
  if (Date.now() < graceEndsMs) return next();
  res.status(403).json({
    error: "multi-factor authentication is required for owner accounts",
    code: "MFA_REQUIRED",
  });
}
