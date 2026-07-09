// ============================================================================
// STRIPE PAYMENT INTEGRATION
// ============================================================================
// Adds "Pay this invoice online" to the public share page. When a customer
// completes payment, Stripe sends a webhook that we use to call payInvoice()
// automatically — no manual reconciliation needed.
//
// Required deps to add to package.json:
//   "stripe": "^14.0.0"
//
// Required env vars:
//   STRIPE_SECRET_KEY       — sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET   — whsec_... (from the Stripe webhook config)
//   STRIPE_SUCCESS_URL      — optional override; defaults to ${APP_BASE_URL}/p/invoice/{token}?paid=1
//
// Routes added:
//   POST /api/invoices/:id/payment-link    — owner action: get a Stripe Checkout URL for the active invoice
//   GET  /p/invoice/:token/pay             — public: redirect customer to Stripe Checkout
//   POST /api/stripe/webhook               — Stripe → us, marks invoice paid

import type { Express, Request, Response } from "express";
import { db, storage } from "./storage";
import { accounts } from "@shared/schema";
import { organizations } from "@shared/auth-schema";
import { and, eq } from "drizzle-orm";
import { formatMoney } from "@shared/money";
import { appBaseUrl } from "./email";
import { withOrg } from "./org-scope";

// Exact message the webhook/UI contract depends on — do not reword casually.
export const CLEARING_ACCOUNT_NOT_CONFIGURED =
  "Stripe clearing account not configured — set it in Settings → Online payments before accepting Stripe payments";

/**
 * Resolve the org's configured Stripe clearing account, validating that it is
 * a bank-subtype asset account BELONGING TO THAT ORG. Throws with a clear,
 * actionable message otherwise. This is the ONLY way the Stripe integration
 * may pick a bank account — never guess from the chart of accounts: with more
 * than one bank account, "first bank subtype found" silently books real money
 * to whichever account happens to sort first.
 */
export async function getConfiguredClearingAccount(orgId: number) {
  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((r: any[]) => r[0]);
  if (!org) throw new Error(`Organization ${orgId} not found`);
  if (!org.stripeClearingAccountId) {
    throw new Error(CLEARING_ACCOUNT_NOT_CONFIGURED);
  }
  const acct = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, org.stripeClearingAccountId), eq(accounts.orgId, orgId)))
    .then((r: any[]) => r[0]);
  if (!acct) {
    // Covers both "deleted" and "points at another org's account" (the latter
    // should be impossible via the PATCH validation, but never trust it here).
    throw new Error(
      "Stripe clearing account is set to an account that does not exist in this organization — fix it in Settings → Online payments"
    );
  }
  if (acct.type !== "asset" || acct.subtype !== "bank") {
    throw new Error(
      `Stripe clearing account must be a bank-subtype asset account — "${acct.code} ${acct.name}" is ${acct.type}/${acct.subtype}. Fix it in Settings → Online payments`
    );
  }
  return acct;
}

let _stripe: any = null;
let _stripeError: string | null = null;

function getStripe(): any | null {
  if (_stripe) return _stripe;
  if (_stripeError) return null;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    _stripeError = "STRIPE_SECRET_KEY not set";
    return null;
  }
  try {
    // Lazy require so the server boots even when stripe isn't installed yet.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require("stripe");
    _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
    return _stripe;
  } catch (e: any) {
    _stripeError = `stripe SDK not installed (npm i stripe): ${e?.message || e}`;
    console.warn("[stripe]", _stripeError);
    return null;
  }
}

export function stripeStatus() {
  const present = !!process.env.STRIPE_SECRET_KEY;
  const webhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
  return { configured: present, webhookConfigured, error: _stripeError };
}

/**
 * Per-org readiness: env config AND a valid clearing account. The UI uses
 * this to gate "enable online payments"; the session-creation routes enforce
 * the same precondition server-side.
 */
export async function stripeOrgStatus(orgId: number) {
  const base = stripeStatus();
  let clearingAccountConfigured = false;
  let clearingAccountError: string | null = null;
  let clearingAccount: { id: number; code: string; name: string } | null = null;
  try {
    const acct = await getConfiguredClearingAccount(orgId);
    clearingAccountConfigured = true;
    clearingAccount = { id: acct.id, code: acct.code, name: acct.name };
  } catch (e: any) {
    clearingAccountError = e?.message || String(e);
  }
  return {
    ...base,
    clearingAccountConfigured,
    clearingAccount,
    clearingAccountError,
    onlinePaymentsReady: base.configured && base.webhookConfigured && clearingAccountConfigured,
  };
}

export function registerStripeRoutes(app: Express) {
  // Owner-side: generate a payment link for an open invoice.
  // The link contains the share token so the public flow can find the invoice.
  app.post("/api/invoices/:id/payment-link", async (req, res) => {
    try {
      const stripe = getStripe();
      if (!stripe) {
        res.status(503).json({ error: stripeStatus().error || "Stripe not configured" });
        return;
      }
      if (!req.org) {
        res.status(403).json({ error: "No active organization" });
        return;
      }
      // Online payments REQUIRE a configured clearing account. Refuse to
      // create a Checkout session we could not book: failing here (before any
      // money moves) beats failing in the webhook (after it has).
      try {
        await getConfiguredClearingAccount(req.org.id);
      } catch (e: any) {
        res.status(409).json({ error: e?.message || "Stripe clearing account not configured" });
        return;
      }
      const id = Number(req.params.id);
      const inv = await storage.getInvoice(id);
      if (!inv) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const remaining = inv.total - (inv.amountPaid || 0); // integer cents
      if (remaining < 50) { // Stripe minimum charge is $0.50 = 50 cents
        // Stripe minimum charge is $0.50 USD
        res.status(400).json({ error: "Invoice balance is below the Stripe minimum of $0.50" });
        return;
      }
      // Need a share token (so the success URL can route the customer back)
      let share = (await storage.listSharesForInvoice(id))[0];
      if (!share || share.revokedAt || (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now())) {
        share = await storage.createInvoiceShare(id, inv.customer?.email || undefined);
      }

      const successUrl = process.env.STRIPE_SUCCESS_URL ||
        `${appBaseUrl()}/p/invoice/${share.token}?paid=1`;
      const cancelUrl = `${appBaseUrl()}/p/invoice/${share.token}?canceled=1`;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: inv.customer?.email || undefined,
        line_items: [
          {
            price_data: {
              currency: (req.org as any)?.baseCurrency?.toLowerCase() || "usd",
              product_data: {
                name: `Invoice ${inv.number}`,
                description: `Payment for invoice ${inv.number}`,
              },
              unit_amount: remaining, // already integer cents
            },
            quantity: 1,
          },
        ],
        metadata: {
          invoiceId: String(inv.id),
          orgId: String(req.org.id),
          shareToken: share.token,
          ledgerliteVersion: "1",
        },
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (e: any) {
      console.error("[stripe/payment-link]", e);
      res.status(500).json({ error: e?.message || "Failed to create payment link" });
    }
  });

  // Public: redirect customer from the share page to Stripe Checkout.
  // The page-level call would normally POST to /api/.../payment-link, but for
  // a quick "Pay now" link in an email this GET is convenient.
  app.get("/p/invoice/:token/pay", async (req, res) => {
    try {
      const stripe = getStripe();
      if (!stripe) {
        res.status(503).type("html").send("<h1>Online payment not configured</h1>");
        return;
      }
      const token = req.params.token;
      const data = await storage.getShareByToken(token);
      if (!data || !data.invoice) {
        res.status(404).type("html").send("<h1>Invoice not found</h1>");
        return;
      }
      const inv = data.invoice;
      const remaining = inv.total - (inv.amountPaid || 0); // integer cents
      if (remaining < 50) { // Stripe minimum charge is $0.50 = 50 cents
        res.redirect(`/p/invoice/${token}?paid=1`);
        return;
      }
      const successUrl = process.env.STRIPE_SUCCESS_URL ||
        `${appBaseUrl()}/p/invoice/${token}?paid=1`;
      const cancelUrl = `${appBaseUrl()}/p/invoice/${token}?canceled=1`;
      // The share row carries its own org_id — that is the source of truth for
      // which tenant this payment belongs to. Never default to org 1.
      const orgId = (data as any).orgId;
      if (!Number.isInteger(orgId) || orgId <= 0) {
        console.error(`[stripe/pay] share ${token} has no valid orgId`);
        res.status(500).type("html").send("<h1>Payment error</h1><p>This payment link is misconfigured. Please contact the sender.</p>");
        return;
      }
      // Same precondition as the owner-side payment-link route: never start a
      // checkout the webhook could not book. The payer sees a generic page;
      // the actionable detail is logged for the operator.
      try {
        await getConfiguredClearingAccount(orgId);
      } catch (e: any) {
        console.error(`[stripe/pay] org ${orgId}: ${e?.message || e}`);
        res.status(503).type("html").send("<h1>Online payment not available</h1><p>The sender has not finished setting up online payments. Please contact them to pay another way.</p>");
        return;
      }
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: data.customer?.email || undefined,
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: `Invoice ${inv.number}`, description: `Payment for invoice ${inv.number}` },
            unit_amount: remaining, // already integer cents
          },
          quantity: 1,
        }],
        metadata: { invoiceId: String(inv.id), orgId: String(orgId), shareToken: token },
      });
      res.redirect(303, session.url);
    } catch (e: any) {
      console.error("[stripe/pay]", e);
      res.status(500).type("html").send("<h1>Payment error</h1><p>Something went wrong starting the payment. Please try again or contact the sender.</p>");
    }
  });

  // Webhook: Stripe → us. Mark invoice paid when checkout.session.completed fires.
  // IMPORTANT: this route uses the raw body (not parsed JSON) because the signature
  // is computed over the exact bytes. We mounted express.json with a `verify` callback
  // earlier that captures rawBody; we use that here.
  app.post("/api/stripe/webhook", async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).send("Stripe not configured");
      return;
    }
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      res.status(503).send("STRIPE_WEBHOOK_SECRET not set");
      return;
    }
    const sig = req.headers["stripe-signature"] as string | undefined;
    let event: any;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody as Buffer, sig, secret);
    } catch (err: any) {
      console.error("[stripe/webhook] signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const md = session.metadata || {};
        const invoiceId = Number(md.invoiceId);
        const orgId = Number(md.orgId);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0 || !Number.isInteger(orgId) || orgId <= 0) {
          // A session without our metadata was not created by this app (or is
          // corrupt). Recording it against a guessed tenant would post money to
          // the wrong books — ack it so Stripe stops retrying, and log loudly.
          console.error(
            `[stripe/webhook] checkout.session.completed ${session.id} missing invoiceId/orgId metadata — ignored`
          );
          res.json({ received: true, ignored: true });
          return;
        }
        // Run inside the org context so storage methods resolve the right tenant
        await withOrg({ orgId, userId: 0 }, async () => {
          const inv = await storage.getInvoice(invoiceId);
          if (!inv) throw new Error(`Invoice ${invoiceId} not found in org ${orgId}`);
          const amount = (session.amount_total || 0) / 100;
          if (amount < 0.005) throw new Error("Stripe reported zero-amount payment");

          // Post to the org's CONFIGURED Stripe clearing account. If it is
          // unset or invalid this throws — the catch below returns 500 so
          // Stripe RETRIES the webhook. That is the correct failure mode:
          // the money already moved at Stripe, so we must not guess which
          // account to book it to, and we must not ack (200) an event we
          // haven't recorded. Once the org sets the account in Settings,
          // Stripe's retry books the payment. NO fallback to "first bank
          // account found" — with multiple bank accounts that posts real
          // money to an arbitrary one.
          const bank = await getConfiguredClearingAccount(orgId);

          await storage.payInvoice({
            invoiceId,
            date: new Date().toISOString().slice(0, 10),
            amount,
            bankAccountId: bank.id,
            memo: `Stripe payment ${session.id}`,
          });
          console.log(`[stripe/webhook] paid invoice ${inv.number} for ${formatMoney(session.amount_total || 0)} via ${session.id}`);
        });
      }
      res.json({ received: true });
    } catch (e: any) {
      console.error("[stripe/webhook] processing error:", e);
      // Return 200 so Stripe doesn't keep retrying — we've logged the error
      // (alternative: return 500 to retry; depends on operator preference)
      res.status(500).json({ error: e?.message });
    }
  });
}
