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

export type SendOpts = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
};

export type SendResult = {
  ok: boolean;
  mode: "smtp" | "dev";
  messageId?: string;
  error?: string;
};

let cachedTransporter: nodemailer.Transporter | null | undefined;

function getTransporter(): nodemailer.Transporter | null {
  if (cachedTransporter !== undefined) return cachedTransporter;
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

export function smtpStatus() {
  return {
    configured: !!getTransporter(),
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@ledgerlite.local",
    host: process.env.SMTP_HOST || null,
  };
}

export async function sendEmail(opts: SendOpts): Promise<SendResult> {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@ledgerlite.local";

  if (!transporter) {
    // Dev mode: log it and pretend it worked so the share flow still completes.
    console.log("\n[email:dev-mode] (SMTP not configured — would have sent:)");
    console.log("  From:    ", from);
    console.log("  To:      ", opts.to);
    if (opts.cc) console.log("  Cc:      ", opts.cc);
    console.log("  Subject: ", opts.subject);
    console.log("  Body:\n" + opts.text.split("\n").map((l) => "    " + l).join("\n"));
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
    });
    return { ok: true, mode: "smtp", messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, mode: "smtp", error: e?.message || String(e) };
  }
}
