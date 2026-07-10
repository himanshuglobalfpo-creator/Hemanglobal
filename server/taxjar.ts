// ============================================================================
// TAXJAR INTEGRATION — automated US sales tax
// ============================================================================
// Env vars:
//   TAXJAR_API_KEY   — from the TaxJar dashboard. When unset, every function
//                      falls back to the org's manual tax_codes rate and logs
//                      a warning; invoice creation is NEVER blocked.
//   TAXJAR_SANDBOX   — "true" routes ALL calls to https://api.sandbox.taxjar.com
//                      (never production). Anything else uses the live API.
//
// Money contract: this module speaks INTEGER CENTS in and out. The invoices
// table (like the rest of the ledger) stores REAL dollars, so callers convert
// at the boundary — see createInvoiceWithAutoTax() in storage.ts.
//
// Nexus rule: tax is only calculated when the org has nexus in the customer's
// destination state (per org_nexus_states). No nexus → tax = 0, source
// "no_nexus", and the TaxJar API is not called at all.
//
// Testability: the exported decide*/toCents helpers and calculateSalesTax()
// take nexus states and fallback rate as explicit inputs — no hidden DB reads —
// so the decision logic is unit-testable without a network or a database.
// listNexusRegions()/orgCalculateContext() are the DB-aware wrappers.

// TaxJar REST API via native fetch (Node 18+). The official `taxjar` SDK was
// removed because it pulled the deprecated `request`/`form-data`/`tough-cookie`
// chain (SSRF + prototype-pollution advisories). These two endpoints are the
// only ones we use, so direct calls are simpler and dependency-free.
import { logger } from "./logger";

const TAXJAR_PROD_URL = "https://api.taxjar.com";
const TAXJAR_SANDBOX_URL = "https://api.sandbox.taxjar.com";
const TAXJAR_TIMEOUT_MS = 15_000;

export function taxjarConfigured(): boolean {
  return !!process.env.TAXJAR_API_KEY;
}

export function taxjarSandbox(): boolean {
  return process.env.TAXJAR_SANDBOX === "true";
}

function taxjarBaseUrl(): string {
  return taxjarSandbox() ? TAXJAR_SANDBOX_URL : TAXJAR_PROD_URL;
}

/** A TaxJar API error carrying the HTTP status + detail, matching the shape the
 * callers already handle (`e.status`, `e.detail`). */
class TaxjarApiError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "TaxjarApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** POST a JSON body to a TaxJar endpoint. Returns parsed JSON, or throws a
 * TaxjarApiError (with status/detail) on a non-2xx response or transport error.
 * Requires TAXJAR_API_KEY to be set — callers gate on taxjarConfigured() first. */
async function taxjarPost(path: string, body: unknown): Promise<any> {
  const key = process.env.TAXJAR_API_KEY!;
  let res: Response;
  try {
    res = await fetch(`${taxjarBaseUrl()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TAXJAR_TIMEOUT_MS),
    });
  } catch (e: any) {
    // Network / timeout / abort — no HTTP status available.
    throw new TaxjarApiError(e?.message || "network error", undefined, e?.message);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    // TaxJar error bodies look like { error, detail, status }.
    throw new TaxjarApiError(json?.error || `HTTP ${res.status}`, res.status, json?.detail || text || undefined);
  }
  return json;
}

export function taxjarStatus() {
  return { configured: taxjarConfigured(), sandbox: taxjarSandbox() };
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
export type CalculateSalesTaxParams = {
  fromZip: string;
  fromState: string;
  fromCity?: string;
  toZip: string;
  toState: string; // 2-char, e.g. "TX"
  toCity?: string;
  amount: number; // INTEGER CENTS (taxable amount, excluding tax)
  productTaxCode?: string; // TaxJar product tax category, e.g. "31000" for software
  /** States (2-char codes) where the org has nexus. Decides whether tax applies. */
  nexusStates: string[];
  /** Manual fallback when TaxJar is unconfigured or errors: rate as a percentage, e.g. 8.25 */
  fallback?: { rate: number; label?: string };
};

export type TaxBreakdownCents = {
  stateTax: number; // cents
  countyTax: number; // cents
  cityTax: number; // cents
  specialDistrictTax: number; // cents
};

export type CalculateSalesTaxResult = {
  taxAmount: number; // INTEGER CENTS to collect
  taxRate: number; // combined rate as a percentage, e.g. 8.25
  breakdown: TaxBreakdownCents;
  /** Where the number came from — stored on the invoice for audit. */
  source: "taxjar" | "taxjar_sandbox" | "manual_fallback" | "no_nexus";
  /** Raw TaxJar response (when source is taxjar*), kept verbatim for audit. */
  raw?: unknown;
  /** Present when we fell back — surfaced in logs and /api/tax/calculate. */
  warning?: string;
};

// ----------------------------------------------------------------------------
// Pure helpers (unit-tested without network/DB)
// ----------------------------------------------------------------------------

/** TaxJar returns dollars as decimals; convert safely to integer cents. */
export function toCents(dollars: number | undefined | null): number {
  return Math.round(((dollars ?? 0) + Number.EPSILON) * 100);
}

/** Manual-rate computation on integer cents (banker's-free, half-up like the ledger). */
export function manualTaxCents(amountCents: number, ratePercent: number): number {
  return Math.round((amountCents * ratePercent) / 100 + Number.EPSILON);
}

/** Nexus gate: does the org owe tax in this destination state? */
export function hasNexusIn(toState: string, nexusStates: string[]): boolean {
  const t = toState.trim().toUpperCase();
  return nexusStates.some((s) => s.trim().toUpperCase() === t);
}

function zeroResult(source: CalculateSalesTaxResult["source"], warning?: string): CalculateSalesTaxResult {
  return {
    taxAmount: 0,
    taxRate: 0,
    breakdown: { stateTax: 0, countyTax: 0, cityTax: 0, specialDistrictTax: 0 },
    source,
    ...(warning ? { warning } : {}),
  };
}

function fallbackResult(
  amountCents: number,
  fallback: { rate: number; label?: string } | undefined,
  reason: string
): CalculateSalesTaxResult {
  if (!fallback) {
    const warning = `${reason} — no manual tax code available; charging 0 tax`;
    logger.warn(`[taxjar] ${warning}`);
    return zeroResult("manual_fallback", warning);
  }
  const taxAmount = manualTaxCents(amountCents, fallback.rate);
  const warning = `${reason} — using manual rate ${fallback.rate}%${fallback.label ? ` (${fallback.label})` : ""}`;
  logger.warn(`[taxjar] ${warning}`);
  return {
    taxAmount,
    taxRate: fallback.rate,
    // Manual rates are single-jurisdiction by definition: attribute to state bucket.
    breakdown: { stateTax: taxAmount, countyTax: 0, cityTax: 0, specialDistrictTax: 0 },
    source: "manual_fallback",
    warning,
  };
}

// ----------------------------------------------------------------------------
// calculateSalesTax — the main entry point
// ----------------------------------------------------------------------------
export async function calculateSalesTax(params: CalculateSalesTaxParams): Promise<CalculateSalesTaxResult> {
  const { amount, toState, nexusStates, fallback } = params;

  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`amount must be a non-negative integer number of cents, got ${amount}`);
  }
  if (!/^[A-Za-z]{2}$/.test(toState)) {
    throw new Error(`toState must be a 2-character state code, got "${toState}"`);
  }

  // Rule: no nexus in the destination state → no tax obligation → 0, no API call.
  if (!hasNexusIn(toState, nexusStates)) {
    return zeroResult("no_nexus");
  }

  if (!taxjarConfigured()) {
    return fallbackResult(amount, fallback, "TAXJAR_API_KEY not set");
  }

  try {
    const res = await taxjarPost("/v2/taxes", {
      from_country: "US",
      from_zip: params.fromZip,
      from_state: params.fromState,
      ...(params.fromCity ? { from_city: params.fromCity } : {}),
      to_country: "US",
      to_zip: params.toZip,
      to_state: toState.toUpperCase(),
      ...(params.toCity ? { to_city: params.toCity } : {}),
      amount: amount / 100, // TaxJar speaks dollars
      shipping: 0,
      ...(params.productTaxCode
        ? {
            line_items: [
              { id: "1", quantity: 1, unit_price: amount / 100, product_tax_code: params.productTaxCode },
            ],
          }
        : {}),
    });

    const tax = res.tax ?? {};
    const bd: any = tax.breakdown ?? {};
    return {
      taxAmount: toCents(tax.amount_to_collect),
      // TaxJar's rate is a fraction (0.0825); our tax_codes store percentages (8.25).
      taxRate: +(tax.rate * 100).toFixed(4),
      breakdown: {
        stateTax: toCents(bd.state_tax_collectable),
        countyTax: toCents(bd.county_tax_collectable),
        cityTax: toCents(bd.city_tax_collectable),
        specialDistrictTax: toCents(bd.special_district_tax_collectable),
      },
      source: taxjarSandbox() ? "taxjar_sandbox" : "taxjar",
      raw: res, // full response, stored verbatim for audit
    };
  } catch (e: any) {
    // NEVER block the caller (rule: invoice creation must not fail on TaxJar outage).
    return fallbackResult(
      amount,
      fallback,
      `TaxJar API error (${e?.status ?? "?"}: ${e?.detail || e?.message || e})`
    );
  }
}

// ----------------------------------------------------------------------------
// validateAddress — normalize a US address via TaxJar
// ----------------------------------------------------------------------------
export type AddressInput = { street?: string; city?: string; state?: string; zip?: string };
export type ValidateAddressResult = {
  valid: boolean;
  normalized: AddressInput | null;
  /** All candidates TaxJar returned (first one is `normalized`). */
  candidates?: AddressInput[];
  warning?: string;
};

export async function validateAddress(address: AddressInput): Promise<ValidateAddressResult> {
  if (!taxjarConfigured()) {
    return {
      valid: false,
      normalized: null,
      warning: "TAXJAR_API_KEY not set — address validation unavailable",
    };
  }
  try {
    const res = await taxjarPost("/v2/addresses/validate", { country: "US", ...address });
    const candidates = ((res.addresses as any[]) || []).map((a) => ({
      street: a.street,
      city: a.city,
      state: a.state,
      zip: a.zip,
    }));
    if (candidates.length === 0) return { valid: false, normalized: null, candidates: [] };
    return { valid: true, normalized: candidates[0], candidates };
  } catch (e: any) {
    // 404 from TaxJar means "no match found" — that's a validity answer, not an outage.
    if (e?.status === 404) return { valid: false, normalized: null, candidates: [] };
    const warning = `TaxJar address validation error: ${e?.detail || e?.message || e}`;
    logger.warn(`[taxjar] ${warning}`);
    return { valid: false, normalized: null, warning };
  }
}
