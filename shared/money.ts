// ============================================================================
// MONEY — integer cents everywhere
// ============================================================================
// All monetary values in the database and in server-side math are INTEGER
// CENTS ($10.99 = 1099). Never use REAL/float for money. Floating point math
// is only permitted at the two boundaries:
//   IN:  user-submitted dollars → toCents() → Math.round(dollars * 100)
//   OUT: display formatting     → formatMoney(cents) → "$1,234.56"
//
// Shared by server (storage, PDFs, statements, audit strings) and client.

// Upper bound for a single monetary amount, in INTEGER CENTS. Money columns are
// BIGINT so the DB can hold very large values, but every value must still stay a
// JS-safe integer (< 2^53) for exact server-side math, and an absurd amount is
// almost always an input error. Default: $1 trillion. Configurable via the
// MAX_TX_CENTS env var (server) — kept well below Number.MAX_SAFE_INTEGER so
// sums of many amounts also stay exact.
export const DEFAULT_MAX_TX_CENTS = 1_000_000_000_000_00; // $1,000,000,000,000.00

export const MAX_TX_CENTS: number = (() => {
  // `process` may be undefined in the browser bundle — guard the access.
  const raw = typeof process !== "undefined" ? Number(process.env?.MAX_TX_CENTS) : NaN;
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_TX_CENTS;
})();

/**
 * Convert user-input dollars (possibly fractional/float) to integer cents.
 * Throws above `maxCents` (default MAX_TX_CENTS) so an out-of-range amount fails
 * loudly at the API boundary instead of silently overflowing downstream math.
 */
export function toCents(dollars: number, maxCents: number = MAX_TX_CENTS): number {
  if (!Number.isFinite(dollars)) throw new Error(`Invalid money amount: ${dollars}`);
  const cents = Math.round(dollars * 100);
  if (Math.abs(cents) > maxCents) {
    throw new Error(
      `Amount ${dollars} exceeds the maximum allowed of ${maxCents / 100} ` +
        `(${maxCents} cents). Raise MAX_TX_CENTS if this is intentional.`
    );
  }
  return cents;
}

/** Format integer cents as "$X,XXX.XX" (negative → "-$X,XXX.XX").
 *  Optional currency code (ISO 4217) defaults to USD, so every existing call
 *  site keeps its behavior; FX documents pass their own code ("EUR" → "€…").
 *  Unknown codes fall back to a plain "CODE 1,234.56" render rather than throw. */
export function formatMoney(cents: number, currency: string = "USD"): string {
  if (!Number.isFinite(cents)) cents = 0;
  const c = Math.round(cents); // guard: caller should already pass an integer
  try {
    return (c / 100).toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return `${currency} ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

/** API response shape for a money value: exact cents + human display string. */
export function moneyField(cents: number): { cents: number; display: string } {
  return { cents: Math.round(cents), display: formatMoney(cents) };
}

/**
 * Multiply cents by a percentage rate (e.g. tax), returning integer cents.
 * Example: taxCents(10000, 8.875) = Math.round(10000 * 0.08875) = 888
 */
export function pctOfCents(cents: number, ratePercent: number): number {
  return Math.round((cents * ratePercent) / 100);
}

/** Assert a value is integer cents (catches float leakage in dev/tests). */
export function assertCents(v: number, label = "amount"): number {
  if (!Number.isInteger(v)) {
    throw new Error(`${label} must be integer cents, got ${v}`);
  }
  return v;
}
