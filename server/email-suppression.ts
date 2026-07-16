// ============================================================================
// EMAIL SUPPRESSION — deliverability guardrail
// ============================================================================
// The suppression list (migration 0047) is GLOBAL and address-keyed: a hard
// bounce or complaint suppresses that address for the whole sending domain, so
// we never keep hammering a dead/complaining recipient and torching our sender
// reputation. sendEmail() consults isSuppressed() before every real send; the
// provider webhook (SES/Postmark) feeds it via addSuppression().
//
// Kept out of storage.ts (whose methods are org-scoped) because suppression is
// deliberately cross-tenant; pure parsing lives here with no DB dependency.

import { pool } from "./storage";
import { logger } from "./logger";

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export async function isSuppressed(email: string): Promise<boolean> {
  if (!email) return false;
  const r = await pool.query(`SELECT 1 FROM email_suppressions WHERE email = $1`, [normalize(email)]);
  return r.rowCount! > 0;
}

export async function addSuppression(email: string, reason: string, source?: string, detail?: string): Promise<void> {
  if (!email) return;
  await pool.query(
    `INSERT INTO email_suppressions (email, reason, source, detail) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, detail = EXCLUDED.detail`,
    [normalize(email), reason, source ?? null, detail ?? null]
  );
  logger.info("[email] address suppressed", { email: normalize(email), reason, source });
}

export async function removeSuppression(email: string): Promise<void> {
  await pool.query(`DELETE FROM email_suppressions WHERE email = $1`, [normalize(email)]);
}

export async function suppressionCount(): Promise<number> {
  return (await pool.query(`SELECT COUNT(*)::int AS n FROM email_suppressions`)).rows[0].n;
}

export async function listSuppressions(limit = 100): Promise<Array<{ email: string; reason: string; source: string | null; createdAt: string }>> {
  return (await pool.query(
    `SELECT email, reason, source, created_at AS "createdAt" FROM email_suppressions ORDER BY created_at DESC LIMIT $1`,
    [limit]
  )).rows as any;
}

// --- Provider webhook parsing (pure) ---------------------------------------
export interface SuppressionEvent { email: string; reason: "hard_bounce" | "complaint"; source: "ses" | "postmark"; detail?: string }

// Parses an SES (via SNS) or Postmark bounce/complaint payload into the set of
// addresses to suppress. Returns [] for soft bounces, deliveries, opens, etc.
// — only PERMANENT failures and complaints suppress.
export function parseBounceWebhook(body: any): SuppressionEvent[] {
  if (!body || typeof body !== "object") return [];
  const events: SuppressionEvent[] = [];

  // --- Amazon SES via SNS -------------------------------------------------
  // SNS wraps the SES notification JSON as a string in `Message`.
  let ses: any = body;
  if (typeof body.Message === "string") { try { ses = JSON.parse(body.Message); } catch { ses = null; } }
  if (ses && (ses.notificationType || ses.eventType)) {
    const type = ses.notificationType || ses.eventType;
    if (type === "Bounce" && ses.bounce?.bounceType === "Permanent") {
      for (const r of ses.bounce.bouncedRecipients ?? []) {
        if (r.emailAddress) events.push({ email: r.emailAddress, reason: "hard_bounce", source: "ses", detail: ses.bounce.bounceSubType });
      }
    } else if (type === "Complaint") {
      for (const r of ses.complaint?.complainedRecipients ?? []) {
        if (r.emailAddress) events.push({ email: r.emailAddress, reason: "complaint", source: "ses" });
      }
    }
    return events;
  }

  // --- Postmark -----------------------------------------------------------
  // RecordType "Bounce" with a hard type, or "SpamComplaint".
  if (body.RecordType) {
    const HARD = new Set(["HardBounce", "BadEmailAddress", "Blocked"]);
    if (body.RecordType === "Bounce" && (HARD.has(body.Type) || body.TypeCode === 1)) {
      if (body.Email) events.push({ email: body.Email, reason: "hard_bounce", source: "postmark", detail: body.Type });
    } else if (body.RecordType === "SpamComplaint") {
      if (body.Email) events.push({ email: body.Email, reason: "complaint", source: "postmark" });
    }
  }
  return events;
}
