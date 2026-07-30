// ============================================================================
// CSV — RFC 4180 serialization shared by every report's ?format=csv path
// ============================================================================
// Quoting rules (RFC 4180): a field is quoted when it contains a comma, a
// double quote, or a line break; embedded quotes are doubled. Excel opens the
// result cleanly, including descriptions like: He said "hi", twice.

export type CsvColumn<T> = {
  key: keyof T | ((row: T) => unknown);
  header: string;
};

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => csvEscape(c.header)).join(",");
  const body = rows.map((row) =>
    columns
      .map((c) => csvEscape(typeof c.key === "function" ? c.key(row) : (row as any)[c.key]))
      .join(",")
  );
  return [header, ...body].join("\r\n") + "\r\n"; // CRLF per RFC 4180
}

// Cents → "1234.56" for CSV (spreadsheets want plain decimals, not "$1,234.56").
export function csvMoney(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}
