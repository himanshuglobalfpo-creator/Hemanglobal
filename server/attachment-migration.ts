// ============================================================================
// ATTACHMENT STORAGE MIGRATION — move blobs between backends, safely
// ============================================================================
// Copies attachment blobs from wherever they live (local disk) to the primary
// object store (S3/R2/MinIO), one batch at a time, with THREE guarantees:
//
//   • Resumable — progress is the per-row `storage_backend` flag, not in-memory
//     state. A crash, a redeploy, or a second concurrent call simply continues
//     from the rows still on the old backend. Idempotent by construction.
//   • Verified — every copy is checked by SHA-256: the exact bytes are read
//     back from the target and must hash to the same value stored on the row
//     (backfilled from the source on first pass). A truncated/corrupt copy
//     fails verification and the row is left untouched on its source backend.
//   • Zero-downtime reads — the row's backend flips to the target ONLY after
//     the verified copy exists, and the source blob is deleted ONLY after the
//     flip. At every instant the row points at a store that holds its bytes, so
//     downloads never 404 mid-migration (reads resolve the driver per row).
//
// The blob on disk is already the AES-256-GCM envelope (encrypt-before-put), so
// this copies ciphertext verbatim — the vault key never leaves the app and the
// object store only ever sees encrypted bytes.
//
// Driver resolution is injected so the algorithm is unit-testable against
// in-memory stores without a live S3; production passes the real files.ts
// resolver.
// ============================================================================

import { checksumBytes, getDriver as defaultGetDriver, type FileDriver, type StorageBackend } from "./files";

export interface AttachmentRow {
  id: number;
  storageKey: string;
  storageBackend: string;
  checksumSha256: string | null;
}

// The slice of storage the migrator needs — kept narrow so tests can supply a
// fake without standing up the whole storage layer.
export interface MigrationStore {
  listAttachmentsPendingMigration(targetBackend: string, limit: number): Promise<AttachmentRow[]>;
  setAttachmentBackend(id: number, backend: string, checksumSha256: string): Promise<void>;
}

export interface MigrateOptions {
  target?: StorageBackend;              // default: "s3"
  batchSize?: number;                   // default: 25
  getDriver?: (b: StorageBackend) => FileDriver; // default: files.getDriver
}

export interface MigrateResult {
  migrated: number;   // rows copied + verified + flipped this call
  remaining: number;  // rows still on a non-target backend after this call
  verified: number;   // checksum verifications performed (== migrated on success)
}

export async function migrateAttachmentsBatch(store: MigrationStore, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const target: StorageBackend = opts.target ?? "s3";
  const batchSize = opts.batchSize ?? 25;
  const resolve = opts.getDriver ?? defaultGetDriver;
  const targetDriver = resolve(target);

  const pending = await store.listAttachmentsPendingMigration(target, batchSize);
  let migrated = 0;
  let verified = 0;

  for (const row of pending) {
    const sourceDriver = resolve(row.storageBackend as StorageBackend);

    // 1. Read the source bytes and pin an integrity anchor. Trust the stored
    //    checksum if present; otherwise backfill it from the source (first pass).
    const sourceBytes = await sourceDriver.get(row.storageKey);
    const sourceSum = checksumBytes(sourceBytes);
    if (row.checksumSha256 && row.checksumSha256 !== sourceSum) {
      throw new Error(`attachment #${row.id}: source blob checksum mismatch (stored ${row.checksumSha256}, got ${sourceSum}) — refusing to migrate a corrupt source`);
    }

    // 2. Copy to the target under the same key, then read it back and verify.
    await targetDriver.put(row.storageKey, sourceBytes, "application/octet-stream");
    const roundTrip = await targetDriver.get(row.storageKey);
    if (checksumBytes(roundTrip) !== sourceSum) {
      throw new Error(`attachment #${row.id}: target read-back checksum mismatch — copy is corrupt, leaving row on ${row.storageBackend}`);
    }
    verified++;

    // 3. Flip the row (now reads go to the target), THEN drop the source blob.
    await store.setAttachmentBackend(row.id, target, sourceSum);
    if (row.storageBackend !== target) {
      await sourceDriver.delete(row.storageKey);
    }
    migrated++;
  }

  // A short batch means the source backend is drained.
  const remaining = pending.length < batchSize ? 0 : (await store.listAttachmentsPendingMigration(target, 1)).length;
  return { migrated, remaining, verified };
}
