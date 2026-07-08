/**
 * server/db.ts — SQLite connection + numbered idempotent migration runner.
 * Migrations live in ./migrations/NNNN_name.sql and are applied exactly once,
 * recorded in schema_migrations. Dates are TEXT YYYY-MM-DD; money is INTEGER cents.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "ledgerlite.db");

export function openDb(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export const db = openDb(process.env.NODE_ENV === "test" ? ":memory:" : DB_PATH);

export function runMigrations(target: Database.Database = db): string[] {
  target.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort(); // numeric prefix => lexicographic sort is chronological
  const applied: string[] = [];
  const isApplied = target.prepare("SELECT 1 FROM schema_migrations WHERE id = ?");
  const record = target.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
  for (const file of files) {
    if (isApplied.get(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const apply = target.transaction(() => {
      target.exec(sql);
      record.run(file);
    });
    apply();
    applied.push(file);
  }
  return applied;
}
