/**
 * shared/money.ts — integer-cents money helpers.
 * TASK 1: formatMoney takes an optional ISO currency code (default "USD")
 * so document views/PDFs/statements can render the DOCUMENT currency while
 * the GL stays 100% base currency.
 */

// Storage rule: EVERY currency is stored in 1/100 units (dollarsToCents and
// the client both multiply user input by 100), including zero-decimal ones
// like JPY. Zero-decimal codes only affect DISPLAY precision — so server
// documents and the client always agree on the stored value.
const ZERO_DECIMAL = new Set(["JPY"]);

export function formatMoney(cents: number, currency: string = "USD"): string {
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // Unknown code: fall back to plain formatting with the code as prefix.
    return `${currency} ${amount.toFixed(decimals)}`;
  }
}

/** Convert foreign cents to base cents at a document/payment rate. */
export function convertCents(foreignCents: number, rate: number): number {
  return Math.round(foreignCents * rate);
}

/** Dollars (string or number, e.g. "12.34") to integer cents; throws on bad input. */
export function dollarsToCents(v: string | number): number {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`invalid money value: ${v}`);
  return Math.round(n * 100);
}
