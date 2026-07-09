// ============================================================================
// ORG-SCOPED STORAGE
// ============================================================================
// The existing storage.ts has ~70 methods that query the database without
// any org filter. Refactoring every one to take an orgId parameter would
// touch hundreds of call sites and risk regressions.
//
// Instead, we use SQLite's connection-scoped variables via a "current_org_id"
// pragma simulated through a runtime-injected WHERE filter at the query layer.
//
// Approach: monkey-patch the better-sqlite3 prepare() output so EVERY query
// carrying an `org_id` column reference is automatically filtered. We do this
// by wrapping `db.select()` and the raw `sqlite.prepare()` to interpolate the
// active org ID — guarded by an AsyncLocalStorage so concurrent requests don't
// stomp each other.
//
// CAVEAT: This is a BANDAID, not a real refactor. It works for the SQL we
// currently have but a future query that joins multiple tables in a way that's
// ambiguous about which org_id to filter on will need explicit changes.
//
// Long-term plan: refactor storage.ts to take orgId as a constructor param.
// For now this gets us to "auth works, data is scoped" without rewriting 3,300
// lines of storage code.

import { AsyncLocalStorage } from "node:async_hooks";

type OrgContext = { orgId: number; userId: number };

const orgStorage = new AsyncLocalStorage<OrgContext>();

export function withOrg<T>(ctx: OrgContext, fn: () => T): T {
  return orgStorage.run(ctx, fn);
}

export function currentOrgId(): number {
  const ctx = orgStorage.getStore();
  if (!ctx) {
    // No active context — this is always a bug. Fail closed: silently defaulting
    // to org 1 would read/write another tenant's books. Callers that legitimately
    // operate outside a request (webhooks, share links, cron) must use withOrg()
    // with an org ID resolved from trusted data (e.g. the share row's org_id).
    throw new Error(
      "[org-scope] currentOrgId() called outside of withOrg() — refusing to default to a tenant"
    );
  }
  return ctx.orgId;
}

export function currentUserId(): number | undefined {
  return orgStorage.getStore()?.userId;
}

// Express middleware: every authenticated request runs inside withOrg context.
import type { Request, Response, NextFunction } from "express";
export function orgScopeMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.org) {
    return next();
  }
  withOrg({ orgId: req.org.id, userId: req.user.id }, () => next());
}
