/**
 * Email sender for invoice sharing. Two modes:
 *   1) Real SMTP send via nodemailer when SMTP_HOST + SMTP_USER + SMTP_PASS are set.
 *   2) Dev fallback: log the message + return a mock success so the rest of the
 *      flow still works in the sandbox / local Replit. The recipient still gets
 *      a working public link they can copy/paste.
 *
 * Env vars (optional):
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS
 *   SMTP_FROM (the From: header), SMTP_SECURE ("true" for 465 TLS)
 *   APP_BASE_URL (used in email body for the public link; falls back to
 *     `http://localhost:5000`)
 */

import nodemailer from "nodemailer";
import { logger } from "./logger";
import { isSuppressed } from "./email-suppression";

export type SendOpts = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
  // When set, adds RFC 8058 List-Unsubscribe headers — used for
  // reminder/statement style mail so recipients (and inbox providers) get a
  // one-click unsubscribe, which improves deliverability and is expected for
  // any non-transactional send.
  listUnsubscribe?: string; // a URL or "mailto:" target
};

export type SendResult = {
  ok: boolean;
  mode: "smtp" | "dev" | "suppressed";
  messageId?: string;
  error?: string;
};

let cachedTransporter: nodemailer.Transporter | null | undefined;

function getTransporter(): nodemailer.Transporter | null {
  if (cachedTransporter !== undefined) return cachedTransporter;
  // Dev/testing seam: SMTP_TRANSPORT=json captures emails as JSON (nodemailer's
  // jsonTransport) instead of dialing a real SMTP server — configured=true, no
  // network. Used by the recurring-invoice test and handy for local dev.
  if (process.env.SMTP_TRANSPORT === "json") {
    cachedTransporter = nodemailer.createTransport({ jsonTransport: true });
    return cachedTransporter;
  }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    cachedTransporter = null;
    return null;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return cachedTransporter;
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:5000").replace(/\/$/, "");
}

// A List-Unsubscribe mailto target for reminder/statement-style mail. Defaults
// to the sending address; override with SMTP_UNSUBSCRIBE for a dedicated inbox.
export function unsubscribeMailto(): string {
  const addr = process.env.SMTP_UNSUBSCRIBE || bareAddress(process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@ledgerlite.local");
  return `mailto:${addr}?subject=Unsubscribe`;
}

function fromAddress(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@ledgerlite.local";
}

// Bare address inside a possibly-decorated From ("Name <a@b>") → "a@b".
function bareAddress(v: string): string {
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim();
}

// The SMTP envelope MAIL FROM (return-path). Aligning it with the From: domain
// is what SPF/DMARC check — a mismatch fails alignment and lands in spam. Defaults
// to the From address; override with SMTP_ENVELOPE_FROM if bounces should go
// elsewhere (still on the SAME domain to keep DMARC alignment).
function envelopeFrom(): string {
  return process.env.SMTP_ENVELOPE_FROM || bareAddress(fromAddress());
}

export function smtpStatus() {
  const configured = !!getTransporter();
  return {
    configured,
    from: fromAddress(),
    envelopeFrom: envelopeFrom(),
    host: process.env.SMTP_HOST || null,
    // Surfaced by the Settings banner: an unconfigured SMTP means invoice/
    // reminder emails are only logged, not delivered.
    warning: configured ? null : "SMTP is not configured — outgoing email is logged, not delivered.",
  };
}

export async function sendEmail(opts: SendOpts): Promise<SendResult> {
  const transporter = getTransporter();
  const from = fromAddress();

  // Deliverability guardrail: never send to a hard-bounced/complained address.
  // Checked in every mode so the dev log reflects reality too.
  if (await isSuppressed(opts.to).catch(() => false)) {
    logger.info("[email] skipped — recipient is suppressed", { to: opts.to, subject: opts.subject });
    return { ok: false, mode: "suppressed", error: "recipient is on the suppression list" };
  }

  const headers: Record<string, string> = {};
  if (opts.listUnsubscribe) {
    headers["List-Unsubscribe"] = opts.listUnsubscribe.startsWith("mailto:") || opts.listUnsubscribe.startsWith("<")
      ? opts.listUnsubscribe
      : `<${opts.listUnsubscribe}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  if (!transporter) {
    // Dev mode: log it and pretend it worked so the share flow still completes.
    logger.info("[email:dev-mode] SMTP not configured — email not sent", {
      from,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      body: opts.text,
    });
    return { ok: true, mode: "dev", messageId: `dev-${Date.now()}` };
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      headers: Object.keys(headers).length ? headers : undefined,
      // Align the envelope (return-path) with the From domain for SPF/DMARC.
      envelope: { from: envelopeFrom(), to: opts.to, cc: opts.cc },
    });
    return { ok: true, mode: "smtp", messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, mode: "smtp", error: e?.message || String(e) };
  }
}
