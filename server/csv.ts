/**
 * server/csv.ts — TASK 4e: shared CSV serializer, RFC 4180 quoting.
 * Fields containing commas, quotes, CR or LF are wrapped in double quotes
 * with embedded quotes doubled. Line ending is CRLF per the RFC so files
 * open cleanly in Excel.
 */
import type { Response } from "express";

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

function escapeField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeField(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => escapeField(c.value(r))).join(","));
  return [head, ...body].join("\r\n") + "\r\n";
}

export function sendCsv<T>(res: Response, filename: string, rows: T[], columns: CsvColumn<T>[]): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.send(toCsv(rows, columns));
}
