// ============================================================================
// DATE HELPERS — future-dated document detection (BUG-005)
// ============================================================================
// Pure, dependency-free, and unit-testable: no DB reads, no Date parsing
// surprises. Dates are ISO calendar strings (YYYY-MM-DD) and all comparisons
// happen in UTC whole-day units, so DST and local-offset drift can't produce a
// half-day "0.99 days in the future" false negative.

// Today's UTC calendar date as YYYY-MM-DD. `nowMs` is injectable for tests.
export function isoToday(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// Whole calendar days that `dateIso` is ahead of `todayIso` (negative if past).
// Both inputs must be YYYY-MM-DD; parsed as UTC midnight so the difference is
// an exact integer number of days.
export function daysAhead(dateIso: string, todayIso: string): number {
  const d = Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10));
  const t = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return Math.round((d - t) / 86_400_000);
}

// Returns a human-readable warning when `dateIso` is more than `graceDays` in
// the future, else null. `docLabel` names the document ("invoice", "bill",
// "journal entry"). `todayIso` is injectable so callers/tests control "now".
export function futureDatedWarning(
  dateIso: string,
  graceDays: number,
  docLabel: string,
  todayIso: string = isoToday(),
): string | null {
  const ahead = daysAhead(dateIso, todayIso);
  const grace = Number.isFinite(graceDays) && graceDays > 0 ? Math.floor(graceDays) : 0;
  if (ahead <= grace) return null;
  const graceNote = grace > 0 ? ` (more than the allowed ${grace} day${grace === 1 ? "" : "s"})` : "";
  return `This ${docLabel} is dated ${dateIso}, ${ahead} day${ahead === 1 ? "" : "s"} in the future${graceNote}.`;
}
