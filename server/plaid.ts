/**
 * Plaid integration.
 *
 * Required deps to add to package.json:
 *   "plaid": "^25.0.0"
 *
 * Required env vars:
 *   PLAID_CLIENT_ID         — from Plaid dashboard
 *   PLAID_SECRET            — from Plaid dashboard (sandbox/dev/prod)
 *   PLAID_ENV               — "sandbox" | "development" | "production" (default: sandbox)
 *   PLAID_WEBHOOK_URL       — optional; URL Plaid will POST to on transaction updates
 *
 * Flow:
 *   1. Frontend calls POST /api/plaid/link-token  → server uses PlaidApi.linkTokenCreate
 *   2. Plaid Link UI opens, user picks bank, returns a public_token
 *   3. Frontend POSTs that to /api/plaid/exchange → server calls itemPublicTokenExchange,
 *      stores access_token via storage.savePlaidItem
 *   4. Frontend (or a cron) hits /api/plaid/sync → server loops over plaid_items,
 *      calls transactionsSync with each item's cursor, imports added rows via
 *      storage.importBankTransactions, persists the new cursor.
 */

import { logger } from "./logger";

let _plaid: any = null;
let _plaidLoadError: string | null = null;

function loadPlaidSdk():
  | { client: any; Products: any; CountryCode: any }
  | { error: string } {
  if (_plaid) return _plaid;
  if (_plaidLoadError) return { error: _plaidLoadError };
  try {
    // Lazy require so server boots even when plaid isn't installed yet.
     
    const plaid = require("plaid");
    const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = plaid;
    const env = (process.env.PLAID_ENV || "sandbox") as keyof typeof PlaidEnvironments;
    const cfg = new Configuration({
      basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
          "PLAID-SECRET": process.env.PLAID_SECRET,
        },
      },
    });
    _plaid = { client: new PlaidApi(cfg), Products, CountryCode };
    return _plaid;
  } catch (e: any) {
    _plaidLoadError = `plaid SDK not installed (run: npm i plaid). Error: ${e?.message || e}`;
    logger.warn("[plaid] SDK load failed", { error: _plaidLoadError });
    return { error: _plaidLoadError };
  }
}

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function plaidStatus() {
  const cfg = plaidConfigured();
  let sdkLoaded = false;
  let sdkError: string | undefined;
  if (cfg) {
    const sdk = loadPlaidSdk();
    sdkLoaded = !("error" in sdk);
    if ("error" in sdk) sdkError = sdk.error;
  }
  return {
    configured: cfg,
    sdkLoaded,
    sdkError,
    env: process.env.PLAID_ENV || "sandbox",
    message: !cfg
      ? "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET."
      : !sdkLoaded
      ? sdkError
      : "Plaid is configured and ready.",
  };
}

export async function createLinkToken(
  userId: string
): Promise<{ link_token: string; expiration: string } | { error: string }> {
  if (!plaidConfigured()) {
    return { error: "Plaid not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env." };
  }
  const sdk = loadPlaidSdk();
  if ("error" in sdk) return { error: sdk.error };
  try {
    const res = await sdk.client.linkTokenCreate({
      user: { client_user_id: String(userId) },
      client_name: "LedgerLite",
      products: [sdk.Products.Transactions],
      country_codes: [sdk.CountryCode.Us],
      language: "en",
      webhook: process.env.PLAID_WEBHOOK_URL || undefined,
    });
    return { link_token: res.data.link_token, expiration: res.data.expiration };
  } catch (e: any) {
    logger.error("[plaid] linkTokenCreate failed", { error: e?.response?.data || e?.message });
    return { error: `Plaid error: ${e?.response?.data?.error_message || e?.message || e}` };
  }
}

export async function exchangePublicToken(
  publicToken: string
): Promise<{ access_token: string; item_id: string } | { error: string }> {
  if (!plaidConfigured()) return { error: "Plaid not configured." };
  const sdk = loadPlaidSdk();
  if ("error" in sdk) return { error: sdk.error };
  try {
    const res = await sdk.client.itemPublicTokenExchange({ public_token: publicToken });
    return { access_token: res.data.access_token, item_id: res.data.item_id };
  } catch (e: any) {
    logger.error("[plaid] itemPublicTokenExchange failed", { error: e?.response?.data || e?.message });
    return { error: `Plaid error: ${e?.response?.data?.error_message || e?.message || e}` };
  }
}

export type PlaidSyncResult =
  | {
      added: Array<{ date: string; description: string; amount: number; externalId: string }>;
      modified: Array<{ externalId: string; date: string; description: string; amount: number }>;
      removed: string[];
      next_cursor: string;
      has_more: boolean;
    }
  | { error: string };

export async function syncTransactions(
  accessToken: string,
  cursor?: string
): Promise<PlaidSyncResult> {
  if (!plaidConfigured()) return { error: "Plaid not configured." };
  const sdk = loadPlaidSdk();
  if ("error" in sdk) return { error: sdk.error };
  try {
    const res = await sdk.client.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 500,
    });
    const data = res.data;
    return {
      added: data.added.map((t: any) => ({
        date: t.date,
        description: t.merchant_name || t.name || "(unknown)",
        // Plaid sign convention: positive = money OUT (expense).
        // LedgerLite convention: positive = money IN (deposit). Flip.
        amount: -t.amount,
        externalId: t.transaction_id,
      })),
      modified: data.modified.map((t: any) => ({
        externalId: t.transaction_id,
        date: t.date,
        description: t.merchant_name || t.name || "(unknown)",
        amount: -t.amount,
      })),
      removed: data.removed.map((r: any) => r.transaction_id),
      next_cursor: data.next_cursor,
      has_more: data.has_more,
    };
  } catch (e: any) {
    logger.error("[plaid] transactionsSync failed", { error: e?.response?.data || e?.message });
    return { error: `Plaid error: ${e?.response?.data?.error_message || e?.message || e}` };
  }
}

// Webhook handler. Plaid POSTs us when new transactions are available.
// We ack it; the next sync call picks up the data.
export function handlePlaidWebhook(body: any): { ok: boolean; action?: string } {
  const { webhook_type, webhook_code, item_id } = body || {};
  if (webhook_type === "TRANSACTIONS") {
    if (
      webhook_code === "SYNC_UPDATES_AVAILABLE" ||
      webhook_code === "INITIAL_UPDATE" ||
      webhook_code === "HISTORICAL_UPDATE"
    ) {
      logger.info("[plaid/webhook] update available", { itemId: item_id, webhookCode: webhook_code });
      return { ok: true, action: "sync_pending" };
    }
  }
  return { ok: true };
}
