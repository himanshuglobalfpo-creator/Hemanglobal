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

/** Convert user-input dollars (possibly fractional/float) to integer cents. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error(`Invalid money amount: ${dollars}`);
  return Math.round(dollars * 100);
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
