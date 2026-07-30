// ============================================================================
// XLSX EXPORT (P3.6) — streaming .xlsx for tabular reports via exceljs
// ============================================================================
// exceljs is loaded lazily (dynamic import) so it never affects server boot —
// only requests that actually ask for ?format=xlsx pull it in. Rows stream to
// the response, so large reports don't buffer the whole workbook in memory.

import type { Response } from "express";
import type { CsvColumn } from "./csv";

export async function streamXlsx<T>(res: Response, filename: string, sheetName: string, columns: CsvColumn<T>[], rows: T[]): Promise<void> {
  const ExcelJS = (await import("exceljs")).default as any;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const ws = wb.addWorksheet(sheetName.slice(0, 31)); // Excel sheet-name limit
  ws.addRow(columns.map((c) => c.header)).commit();
  for (const row of rows) {
    ws.addRow(columns.map((c) => (typeof c.key === "function" ? (c.key as (r: T) => unknown)(row) : (row as any)[c.key]))).commit();
  }
  ws.commit();
  await wb.commit();
}

// True when the client asked for an Excel download.
export function wantsXlsx(format: unknown): boolean {
  return String(format || "").toLowerCase() === "xlsx";
}
