// ============================================================================
// FIRM LAYER — accountant/bookkeeper access to client organizations
// ============================================================================
// A firm is an organization flagged is_firm. Its accountant/admin/owner members
// reach client orgs through firm_client_access grants (never org_memberships),
// so a client's member list stays clean and access is revocable in one place.
//
// Route groups:
//   Firm-context (requireFirmContext — active org must BE a firm):
//     GET  /api/firm/clients              client list + status tiles + pending
//     POST /api/firm/clients/invite       invite a client owner by email
//     POST /api/firm/clients/:id/revoke   firm ends its own access
//   Client-context / any-auth:
//     GET  /api/firm/invite/:token        invite details for the approval screen
//     POST /api/firm/invite/:token/approve  client owner grants access
//     GET  /api/firm/my-accountants       "Your accountant" (owner/admin)
//     POST /api/firm/my-accountants/:id/revoke  client revokes access
//
// Access itself is resolved per-request in server/auth.ts (resolveOrgAccess),
// so nothing here needs to touch sessions — flipping a grant to 'revoked' cuts
// access on the very next request.
// ============================================================================

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { firmInviteSchema, firmApproveSchema } from "@shared/schema";
import { pool } from "./storage";
import { getMembership } from "./auth";
import { requireAuth, requireOrg, requireRole } from "./auth";
import { currentOrgId } from "./org-scope";
import { sendEmail, appBaseUrl } from "./email";
import { logger } from "./logger";

// Firm-only guard: the active org must be a firm AND the caller an
// accountant/admin/owner of it. This is what stops non-firm users (and firm
// members whose active org is a client) from hitting the management endpoints.
export function requireFirmContext(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({ error: "Authentication required" }); return; }
  if (!req.org || !(req.org as any).isFirm) {
    res.status(403).json({ error: "Firm area: switch to your firm organization to manage clients." });
    return;
  }
  if (!req.role || !["owner", "admin", "accountant"].includes(req.role)) {
    res.status(403).json({ error: "This action requires an accountant, admin or owner role in the firm." });
    return;
  }
  next();
}

function handle<T>(res: Response, fn: () => Promise<T> | T) {
  Promise.resolve().then(fn).then((out) => res.json(out)).catch((err: any) => {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Validation failed", details: err.errors }); return; }
    const msg = err?.message || "Server error";
    const userError = /not found|missing|required|invalid|exists|locked|expired|incorrect|access|permission|already/i.test(msg);
    res.status(userError ? 400 : 500).json({ error: msg });
    if (!userError) logger.error("Firm route error", { error: msg, stack: err?.stack?.split("\n").slice(0, 5).join(" | ") });
  });
}

// Direct audit write to a specific org's log, attributed to a specific user —
// used for cross-org events (grant/revoke) where currentOrgId() is the OTHER org.
async function auditFor(orgId: number, userId: number, action: string, entityId: number | null, summary: string) {
  await pool.query(
    `INSERT INTO audit_log (org_id, ts, "user", action, entity_type, entity_id, summary)
     VALUES ($1, now(), $2, $3, 'firm_access', $4, $5)`,
    [orgId, String(userId), action, entityId, summary]
  ).catch((e) => logger.warn("firm audit write failed", { error: e?.message }));
}

// Per-client status tiles for the firm dashboard. Explicit org_id everywhere,
// so this is safe to run outside the client's org-scope context.
export async function clientTiles(clientOrgId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + "01";
  const [unrec, overdue, lastClose] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM bank_transactions WHERE org_id = $1 AND status = 'unmatched'`, [clientOrgId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE org_id = $1 AND status = 'open' AND due_date < $2`, [clientOrgId, today]),
    pool.query(`SELECT MAX(lock_date) AS d FROM period_locks WHERE org_id = $1`, [clientOrgId]),
  ]);
  const lastCloseDate: string | null = lastClose.rows[0]?.d ?? null;
  return {
    unreconciledBankLines: unrec.rows[0].c as number,
    overdueInvoices: overdue.rows[0].c as number,
    lastCloseDate,
    // The current month is "open" until it (or a later date) has been closed.
    currentPeriodOpen: lastCloseDate === null || lastCloseDate < firstOfMonth,
  };
}

export function registerFirmRoutes(app: Express) {
  // -------------------------------------------------------------------------
  // FIRM CONTEXT — manage clients
  // -------------------------------------------------------------------------
  app.get("/api/firm/clients", requireAuth, requireFirmContext, (_req, res) =>
    handle(res, async () => {
      const firmId = currentOrgId();
      const active = (await pool.query(
        `SELECT fca.id, fca.client_org_id AS "clientOrgId", fca.granted_role AS "grantedRole",
                fca.approved_at AS "approvedAt", o.name AS "clientName", o.slug AS "clientSlug"
           FROM firm_client_access fca
           JOIN organizations o ON o.id = fca.client_org_id
          WHERE fca.firm_org_id = $1 AND fca.status = 'active'
          ORDER BY o.name`,
        [firmId]
      )).rows as any[];
      const clients = await Promise.all(active.map(async (c) => ({ ...c, tiles: await clientTiles(c.clientOrgId) })));
      const pending = (await pool.query(
        `SELECT id, invite_email AS "inviteEmail", granted_role AS "grantedRole", created_at AS "createdAt"
           FROM firm_client_access WHERE firm_org_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
        [firmId]
      )).rows;
      return { clients, pending };
    })
  );

  app.post("/api/firm/clients/invite", requireAuth, requireFirmContext, (req, res) =>
    handle(res, async () => {
      const data = firmInviteSchema.parse(req.body);
      const firmId = currentOrgId();
      const firm = (await pool.query(`SELECT name FROM organizations WHERE id = $1`, [firmId])).rows[0] as { name: string };
      const token = crypto.randomBytes(24).toString("base64url");
      const row = (await pool.query(
        `INSERT INTO firm_client_access (firm_org_id, granted_role, status, invite_email, invite_token, invited_by_user_id)
         VALUES ($1, $2, 'pending', $3, $4, $5) RETURNING id`,
        [firmId, data.grantedRole, data.email.toLowerCase(), token, req.user!.id]
      )).rows[0] as { id: number };
      const link = `${appBaseUrl()}/#/firm-invite?token=${encodeURIComponent(token)}`;
      sendEmail({
        to: data.email,
        subject: `${firm.name} would like to access your books on LedgerLite`,
        text: [
          `Hi,`,
          ``,
          `${firm.name} (an accounting firm on LedgerLite) is requesting ${data.grantedRole} access to one of your organizations.`,
          `If you recognize this firm, approve the request here:`,
          ``,
          link,
          ``,
          `You choose which organization to grant, and you can revoke access at any time from Settings → Your accountant.`,
          `If you don't recognize this firm, ignore this email — no access is granted until you approve.`,
        ].join("\n"),
      }).then((r) => { if (!r.ok) logger.error("[firm invite] email failed", { error: r.error }); });
      await auditFor(firmId, req.user!.id, "firm_invite", row.id, `Invited ${data.email} to grant ${data.grantedRole} access`);
      if (process.env.NODE_ENV !== "production") logger.info("[firm invite] token issued (dev)", { email: data.email, token });
      return { ok: true, id: row.id, message: `Invitation sent to ${data.email}.` };
    })
  );

  app.post("/api/firm/clients/:id/revoke", requireAuth, requireFirmContext, (req, res) =>
    handle(res, async () => {
      const firmId = currentOrgId();
      const id = Number(req.params.id);
      const grant = (await pool.query(
        `SELECT id, client_org_id FROM firm_client_access WHERE id = $1 AND firm_org_id = $2 AND status IN ('active','pending')`,
        [id, firmId]
      )).rows[0] as { id: number; client_org_id: number | null } | undefined;
      if (!grant) throw new Error("Grant not found");
      await pool.query(`UPDATE firm_client_access SET status = 'revoked', revoked_at = now() WHERE id = $1`, [grant.id]);
      await auditFor(firmId, req.user!.id, "firm_revoke", grant.id, `Firm ended its own access (grant #${grant.id})`);
      if (grant.client_org_id) await auditFor(grant.client_org_id, req.user!.id, "firm_revoke", grant.id, `Firm ended its access to this organization`);
      return { ok: true };
    })
  );

  // -------------------------------------------------------------------------
  // CLIENT CONTEXT — approve invite / manage "Your accountant"
  // -------------------------------------------------------------------------
  app.get("/api/firm/invite/:token", requireAuth, (req, res) =>
    handle(res, async () => {
      const token = String(req.params.token);
      const grant = (await pool.query(
        `SELECT fca.id, fca.granted_role AS "grantedRole", fca.invite_email AS "inviteEmail", fca.status,
                f.name AS "firmName"
           FROM firm_client_access fca JOIN organizations f ON f.id = fca.firm_org_id
          WHERE fca.invite_token = $1`,
        [token]
      )).rows[0] as any;
      if (!grant || grant.status !== "pending") throw new Error("This invitation is no longer valid.");
      // Orgs the logged-in user OWNS (only an owner can attach an outside firm).
      const myOrgs = (await pool.query(
        `SELECT o.id, o.name, o.slug FROM organizations o
           JOIN org_memberships m ON m.org_id = o.id AND m.user_id = $1
          WHERE m.role = 'owner' AND o.is_firm = false ORDER BY o.name`,
        [req.user!.id]
      )).rows;
      return { firmName: grant.firmName, grantedRole: grant.grantedRole, inviteEmail: grant.inviteEmail, myOrgs };
    })
  );

  app.post("/api/firm/invite/:token/approve", requireAuth, (req, res) =>
    handle(res, async () => {
      const token = String(req.params.token);
      const { orgId } = firmApproveSchema.parse(req.body);
      const grant = (await pool.query(
        `SELECT id, firm_org_id, granted_role FROM firm_client_access WHERE invite_token = $1 AND status = 'pending'`,
        [token]
      )).rows[0] as { id: number; firm_org_id: number; granted_role: string } | undefined;
      if (!grant) throw new Error("This invitation is no longer valid.");
      // Only an OWNER of the target org may attach an outside firm to it.
      const m = await getMembership(req.user!.id, orgId);
      if (!m || m.role !== "owner") throw new Error("You must be an owner of that organization to approve access.");
      // A firm cannot be its own client, and only one live grant per firm↔client.
      if (grant.firm_org_id === orgId) throw new Error("A firm cannot grant access to itself.");
      const dup = (await pool.query(
        `SELECT 1 FROM firm_client_access WHERE firm_org_id = $1 AND client_org_id = $2 AND status IN ('active','pending') AND id <> $3`,
        [grant.firm_org_id, orgId, grant.id]
      )).rows[0];
      if (dup) throw new Error("This firm already has access to that organization.");
      await pool.query(
        `UPDATE firm_client_access SET client_org_id = $1, status = 'active', approved_by_user_id = $2, approved_at = now() WHERE id = $3`,
        [orgId, req.user!.id, grant.id]
      );
      const firm = (await pool.query(`SELECT name FROM organizations WHERE id = $1`, [grant.firm_org_id])).rows[0] as { name: string };
      await auditFor(orgId, req.user!.id, "firm_grant", grant.id, `Granted ${grant.granted_role} access to firm "${firm.name}"`);
      return { ok: true, firmName: firm.name };
    })
  );

  app.post("/api/firm/invite/:token/decline", requireAuth, (req, res) =>
    handle(res, async () => {
      const token = String(req.params.token);
      await pool.query(`UPDATE firm_client_access SET status = 'declined' WHERE invite_token = $1 AND status = 'pending'`, [token]);
      return { ok: true };
    })
  );

  // "Your accountant" — active firms attached to the CURRENT (client) org.
  app.get("/api/firm/my-accountants", requireAuth, requireOrg, requireRole("owner", "admin"), (_req, res) =>
    handle(res, async () => {
      const clientId = currentOrgId();
      const rows = (await pool.query(
        `SELECT fca.id, fca.granted_role AS "grantedRole", fca.approved_at AS "approvedAt", f.name AS "firmName"
           FROM firm_client_access fca JOIN organizations f ON f.id = fca.firm_org_id
          WHERE fca.client_org_id = $1 AND fca.status = 'active' ORDER BY fca.approved_at DESC`,
        [clientId]
      )).rows;
      return { accountants: rows };
    })
  );

  app.post("/api/firm/my-accountants/:id/revoke", requireAuth, requireOrg, requireRole("owner", "admin"), (req, res) =>
    handle(res, async () => {
      const clientId = currentOrgId();
      const id = Number(req.params.id);
      const grant = (await pool.query(
        `SELECT id, firm_org_id FROM firm_client_access WHERE id = $1 AND client_org_id = $2 AND status = 'active'`,
        [id, clientId]
      )).rows[0] as { id: number; firm_org_id: number } | undefined;
      if (!grant) throw new Error("Accountant access not found");
      await pool.query(`UPDATE firm_client_access SET status = 'revoked', revoked_at = now() WHERE id = $1`, [grant.id]);
      await auditFor(clientId, req.user!.id, "firm_revoke", grant.id, `Client revoked firm access (grant #${grant.id})`);
      await auditFor(grant.firm_org_id, req.user!.id, "firm_revoke", grant.id, `Client revoked this firm's access`);
      return { ok: true };
    })
  );
}
