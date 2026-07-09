// ============================================================================
// DEPRECIATION SCHEDULES (pure, side-effect-free)
// ============================================================================
// The accounting-critical math for the fixed-asset register lives here as pure
// functions so it can be unit-tested in isolation AND reused verbatim by the
// storage layer. Everything is INTEGER CENTS and WHOLE months — no floats in
// the ledger. The invariant the whole feature depends on:
//
//     sum(schedule amounts) === cost - salvage      (exactly, always)
//
// The LAST period absorbs the rounding remainder, so an asset is never over- or
// under-depreciated regardless of method or a non-divisible cost.

export const DEPRECIATION_METHODS = ["straight_line", "double_declining"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export interface DepreciationInput {
  costCents: number;
  salvageCents: number;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  /** Acquisition date, YYYY-MM-DD. Depreciation begins in the acquisition month. */
  acquisitionDate: string;
}

export interface DepreciationPeriod {
  /** 0-based month index within the asset's life. */
  index: number;
  /** Calendar period this amount belongs to, YYYY-MM. */
  period: string;
  /** Depreciation for this period, integer cents. */
  amountCents: number;
}

// ---- period helpers (YYYY-MM arithmetic, no Date drift) --------------------

/** The YYYY-MM period of a YYYY-MM-DD (or YYYY-MM) date string. */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** Add `n` whole months to a YYYY-MM period. */
export function addMonthsToPeriod(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** The last calendar day (YYYY-MM-DD) of a YYYY-MM period — used as the JE date. */
export function lastDayOfPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  // Day 0 of the *next* month is the last day of this month.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Non-negative whole count of months from `from` to `to` (both YYYY-MM). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty * 12 + (tm - 1)) - (fy * 12 + (fm - 1));
}

// ---- schedule ---------------------------------------------------------------

/**
 * Build the full month-by-month depreciation schedule for an asset. The amounts
 * always sum to exactly (cost - salvage); the final period carries any rounding
 * remainder. Never depreciates below salvage value.
 */
export function computeDepreciationSchedule(input: DepreciationInput): DepreciationPeriod[] {
  const { costCents, salvageCents, usefulLifeMonths: n, method, acquisitionDate } = input;
  if (!Number.isInteger(costCents) || costCents <= 0) {
    throw new Error("costCents must be a positive integer (cents)");
  }
  if (!Number.isInteger(salvageCents) || salvageCents < 0) {
    throw new Error("salvageCents must be a non-negative integer (cents)");
  }
  if (salvageCents >= costCents) {
    throw new Error("salvageCents must be less than costCents");
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("usefulLifeMonths must be a positive integer");
  }

  const base = costCents - salvageCents; // total depreciable amount
  const amounts: number[] = new Array(n).fill(0);

  if (method === "straight_line") {
    const perMonth = Math.floor(base / n);
    let allocated = 0;
    for (let i = 0; i < n - 1; i++) {
      amounts[i] = perMonth;
      allocated += perMonth;
    }
    amounts[n - 1] = base - allocated; // last period absorbs the remainder
  } else {
    // Double-declining balance: apply 2/n to the DECLINING book value each month,
    // never dipping below salvage. The final period is a plug that brings the
    // book value exactly to salvage (a "switch-to-plug at the end" convention),
    // guaranteeing the schedule sums to `base`.
    const rate = 2 / n;
    let book = costCents;
    let allocated = 0;
    for (let i = 0; i < n - 1; i++) {
      let dep = Math.round(book * rate);
      if (book - dep < salvageCents) dep = book - salvageCents; // cap at salvage floor
      if (dep < 0) dep = 0;
      amounts[i] = dep;
      allocated += dep;
      book -= dep;
    }
    amounts[n - 1] = base - allocated; // last period absorbs the remainder
    if (amounts[n - 1] < 0) amounts[n - 1] = 0; // safety (allocated can never exceed base)
  }

  const firstPeriod = periodOf(acquisitionDate);
  return amounts.map((amountCents, index) => ({
    index,
    period: addMonthsToPeriod(firstPeriod, index),
    amountCents,
  }));
}

/** Convenience: total of a schedule (always cost - salvage). */
export function scheduleTotal(schedule: DepreciationPeriod[]): number {
  return schedule.reduce((s, p) => s + p.amountCents, 0);
}
