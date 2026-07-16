// ============================================================================
// FILE DRIVER CONTRACT + ATTACHMENT MIGRATION
// ============================================================================
// Two layers, no database:
//
//   A. Driver contract — the byte-store interface every backend must honour:
//      put→get round-trips exactly, delete removes, get-after-delete fails,
//      deleting a missing key is a no-op, and path-traversal keys are refused.
//      LocalDriver is always exercised; the S3Driver (SigV4, no SDK) is
//      exercised against MinIO ONLY when S3_ENDPOINT is set — which it is in
//      CI — so `npm test` on a laptop without MinIO still passes clean.
//
//   B. Migration state machine — migrateAttachmentsBatch against in-memory
//      drivers and a fake store, proving the three guarantees WITHOUT any live
//      object store: resumable (flag-driven), verified (SHA-256 read-back), and
//      zero-downtime (flip before source-delete; corrupt copy leaves the row).
//
// Run: tsx tests/file_driver_test.ts
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A scratch FILE_DIR must be set BEFORE the local driver is first constructed
// (getDriver caches per backend), so set it before importing files.ts users.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ll-filedriver-"));
process.env.FILE_DIR = SCRATCH;

const { getDriver, checksumBytes } = await import("../server/files");
const { migrateAttachmentsBatch } = await import("../server/attachment-migration");
import type { FileDriver, StorageBackend } from "../server/files";
import type { AttachmentRow, MigrationStore } from "../server/attachment-migration";

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};
async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try { await fn(); check(label, false, "expected an error"); }
  catch (e: any) { check(label, pattern.test(String(e?.message)), `got: ${e?.message}`); }
}

// ---------------------------------------------------------------------------
// A. Driver contract — parameterized over any FileDriver
// ---------------------------------------------------------------------------
async function driverContract(name: string, d: FileDriver) {
  console.log(`\nDriver contract: ${name}`);
  const key = `1/${crypto.randomUUID()}`;
  const payload = crypto.randomBytes(4096);

  await d.put(key, payload, "application/octet-stream");
  const got = await d.get(key);
  check(`${name}: get returns exactly what put stored`, Buffer.compare(got, payload) === 0);

  // Overwrite semantics — put replaces.
  const payload2 = Buffer.concat([Buffer.from("%PDF-1.7"), crypto.randomBytes(100)]);
  await d.put(key, payload2, "application/pdf");
  check(`${name}: put overwrites in place`, Buffer.compare(await d.get(key), payload2) === 0);

  await d.delete(key);
  await expectReject(`${name}: get after delete fails`, () => d.get(key), /.+/);
  // Deleting a missing key is a no-op, not an error.
  let deleteMissingOk = true;
  try { await d.delete(key); } catch { deleteMissingOk = false; }
  check(`${name}: delete of a missing key is a no-op`, deleteMissingOk);
}

console.log("Test: file driver contract + attachment migration");

// Local driver — always.
await driverContract("local", getDriver("local"));

// Local driver refuses to escape its root.
await expectReject(
  "local: traversal key is rejected",
  () => getDriver("local").get("../../etc/passwd"),
  /Invalid storage key/
);

// checksum is stable and content-addressing.
const b = crypto.randomBytes(64);
check("checksumBytes is deterministic", checksumBytes(b) === checksumBytes(Buffer.from(b)));
check("checksumBytes distinguishes content", checksumBytes(b) !== checksumBytes(crypto.randomBytes(64)));

// S3 driver — only when an endpoint is configured (MinIO in CI).
if (process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_KEY && process.env.S3_SECRET) {
  await driverContract("s3", getDriver("s3"));
} else {
  console.log("\nDriver contract: s3 — SKIPPED (no S3_ENDPOINT; set it to run against MinIO/R2/S3)");
}

// ---------------------------------------------------------------------------
// B. Migration state machine — in-memory drivers + fake store
// ---------------------------------------------------------------------------
console.log("\nMigration state machine (in-memory drivers)");

class MemDriver implements FileDriver {
  store = new Map<string, Buffer>();
  async put(key: string, data: Buffer) { this.store.set(key, Buffer.from(data)); }
  async get(key: string) {
    const v = this.store.get(key);
    if (!v) throw new Error(`MemDriver: no such key ${key}`);
    return Buffer.from(v);
  }
  async delete(key: string) { this.store.delete(key); }
}

// A minimal MigrationStore over an in-memory row list, mirroring the org-scoped
// SQL: "pending" = rows not on the target, oldest-id first, limited.
class FakeStore implements MigrationStore {
  constructor(public rows: (AttachmentRow & { deletedFromSource?: boolean })[]) {}
  async listAttachmentsPendingMigration(target: string, limit: number) {
    return this.rows.filter(r => r.storageBackend !== target).sort((a, b) => a.id - b.id).slice(0, limit)
      .map(r => ({ id: r.id, storageKey: r.storageKey, storageBackend: r.storageBackend, checksumSha256: r.checksumSha256 }));
  }
  async setAttachmentBackend(id: number, backend: string, checksum: string) {
    const r = this.rows.find(x => x.id === id)!;
    r.storageBackend = backend; r.checksumSha256 = checksum;
  }
}

function seed(n: number, local: MemDriver): (AttachmentRow & { bytes: Buffer })[] {
  const rows: (AttachmentRow & { bytes: Buffer })[] = [];
  for (let i = 1; i <= n; i++) {
    const key = `1/blob-${i}`;
    const bytes = crypto.randomBytes(256 + i);
    local.store.set(key, bytes);
    rows.push({ id: i, storageKey: key, storageBackend: "local", checksumSha256: null, bytes });
  }
  return rows;
}

// (1) Happy path — everything migrates, verifies, flips, and source is purged.
{
  const local = new MemDriver(), s3 = new MemDriver();
  const rows = seed(3, local);
  const store = new FakeStore(rows as any);
  const resolve = (b: StorageBackend) => (b === "s3" ? s3 : local);
  const res = await migrateAttachmentsBatch(store, { target: "s3", batchSize: 25, getDriver: resolve });
  check("all rows migrated", res.migrated === 3 && res.remaining === 0 && res.verified === 3);
  check("every row flipped to s3", rows.every(r => r.storageBackend === "s3"));
  check("s3 holds identical bytes", rows.every(r => Buffer.compare(s3.store.get(r.storageKey)!, r.bytes) === 0));
  check("checksum backfilled from source", rows.every(r => r.checksumSha256 === checksumBytes(r.bytes)));
  check("source blobs deleted after flip", rows.every(r => !local.store.has(r.storageKey)));
}

// (2) Resumable — a small batch drains in multiple calls; re-running is a no-op.
{
  const local = new MemDriver(), s3 = new MemDriver();
  const rows = seed(5, local);
  const store = new FakeStore(rows as any);
  const resolve = (b: StorageBackend) => (b === "s3" ? s3 : local);
  const r1 = await migrateAttachmentsBatch(store, { target: "s3", batchSize: 2, getDriver: resolve });
  check("batch 1 migrates 2, reports remaining", r1.migrated === 2 && r1.remaining === 1);
  const r2 = await migrateAttachmentsBatch(store, { target: "s3", batchSize: 2, getDriver: resolve });
  check("batch 2 migrates 2 more", r2.migrated === 2 && r2.remaining === 1);
  const r3 = await migrateAttachmentsBatch(store, { target: "s3", batchSize: 2, getDriver: resolve });
  check("batch 3 migrates the last, remaining=0", r3.migrated === 1 && r3.remaining === 0);
  const r4 = await migrateAttachmentsBatch(store, { target: "s3", batchSize: 2, getDriver: resolve });
  check("re-running after completion is a no-op", r4.migrated === 0 && r4.remaining === 0);
}

// (3) Verified — a target that corrupts the copy fails verification and leaves
//     the row on its source backend (no data loss).
{
  const local = new MemDriver();
  const badS3: FileDriver = {
    async put() { /* silently drop */ },
    async get() { return Buffer.from("corrupt"); },
    async delete() {},
  };
  const rows = seed(1, local);
  const store = new FakeStore(rows as any);
  const resolve = (b: StorageBackend) => (b === "s3" ? badS3 : local);
  await expectReject(
    "corrupt target copy is rejected",
    () => migrateAttachmentsBatch(store, { target: "s3", batchSize: 25, getDriver: resolve }),
    /read-back checksum mismatch/
  );
  check("row stays on local after failed copy", rows[0].storageBackend === "local");
  check("source blob NOT deleted after failed copy", local.store.has(rows[0].storageKey));
}

// (4) Verified — a source whose stored checksum no longer matches its bytes is
//     refused (guards against migrating a already-corrupt source).
{
  const local = new MemDriver(), s3 = new MemDriver();
  const rows = seed(1, local);
  rows[0].checksumSha256 = "deadbeef"; // claim a checksum the bytes don't have
  const store = new FakeStore(rows as any);
  const resolve = (b: StorageBackend) => (b === "s3" ? s3 : local);
  await expectReject(
    "corrupt source is refused",
    () => migrateAttachmentsBatch(store, { target: "s3", batchSize: 25, getDriver: resolve }),
    /source blob checksum mismatch/
  );
}

fs.rmSync(SCRATCH, { recursive: true, force: true });

if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("\nAll file-driver + migration checks passed ✅");
