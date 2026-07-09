// The API returns ALL money as INTEGER CENTS ($10.99 = 1099) — the schema and
// storage layer never use floating point for money. fmtMoney is the display
// boundary where cents become dollars.
export function fmtMoney(cents: number | null | undefined): string {
  const v = (cents ?? 0) / 100;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// For values still in DOLLARS: local form previews computed from inputs the
// user is typing (qty × rate) BEFORE they are submitted to the API.
export function fmtDollars(dollars: number | null | undefined): string {
  return ((dollars ?? 0)).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Cents → dollars, for pre-filling dollar input fields from API values.
export function centsToDollars(cents: number | null | undefined): number {
  return (cents ?? 0) / 100;
}

export function fmtDate(s?: string | null): string {
  if (!s) return "";
  // Normalize to local-friendly without timezone shifts
  const [y, m, d] = s.slice(0, 10).split("-");
  if (!y || !m || !d) return s;
  return `${m}/${d}/${y}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function startOfYearISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}
