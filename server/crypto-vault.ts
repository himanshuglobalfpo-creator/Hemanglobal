// ============================================================================
// CRYPTO VAULT — AES-256-GCM encryption at rest
// ============================================================================
// Two shapes share ONE key (env APP_ENCRYPTION_KEY, exactly 64 hex chars = 32
// bytes):
//   • encryptSecret/decryptSecret — short string secrets (TOTP secrets, Plaid
//     access tokens) stored in text columns.
//   • encryptBlob/decryptBlob — arbitrary binary payloads (attachment file
//     bytes) stored on disk or in S3 by the file driver.
//
// In production a missing/malformed key is a boot-time failure (validated from
// initDatabase() via assertEncryptionKey()) — better to refuse to start than
// to silently write plaintext secrets OR plaintext attachment blobs.
//
// String format:  "v1:" + base64(iv) + ":" + base64(ciphertext) + ":" + base64(authTag)
// The "v1:" prefix does two jobs:
//   1. Versioning — a future "v2:" (new KDF, key rotation, etc.) can coexist.
//   2. Legacy detection — rows written before encryption shipped have no
//      prefix; decryptSecret() passes them through unchanged so reads never
//      break, and storage lazily re-encrypts them on first read.
//
// Blob format:  magic "LLE1" (4 bytes) + iv (12) + authTag (16) + ciphertext.
// The magic header mirrors the "v1:" prefix: it versions the envelope AND lets
// decryptBlob() pass legacy plaintext blobs (written before at-rest encryption
// shipped, or in a keyless dev run) straight through, so existing attachments
// keep downloading. Real attachment payloads never begin with these 4 bytes
// (PDF="%PDF", PNG="\x89PNG", JPEG="\xFF\xD8", etc.), so the detection is
// unambiguous in practice; production always has a key, so it always encrypts.

import crypto from "node:crypto";
import { logger } from "./logger";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — the NIST-recommended size for GCM
const TAG_BYTES = 16; // 128-bit GCM authentication tag
const KEY_HEX_LEN = 64; // 32 bytes
const BLOB_MAGIC = Buffer.from("LLE1", "ascii"); // LedgerLite Encrypted, envelope v1

function loadKey(): Buffer | null {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

// Boot-time guard. Called from initDatabase().
// Production: hard fail on missing/malformed key.
// Dev/test: warn once and fall back to storing plaintext (prefix-less), so
// local hacking without the env var still works — decryptSecret() handles it.
// Known placeholder/weak keys that must NEVER protect real data. The all-zero
// and all-f keys are the obvious "forgot to set it" values (and are what CI
// uses for throwaway databases). Refused in production unless the operator
// explicitly sets ALLOW_INSECURE_DEFAULTS=1 (documented as CI/test-only).
const WEAK_KEYS = new Set(["0".repeat(64), "f".repeat(64), "f".repeat(64).toUpperCase()]);

export function assertEncryptionKey(): void {
  const hex = process.env.APP_ENCRYPTION_KEY;
  const valid = !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
  const isProd = process.env.NODE_ENV === "production";
  const allowInsecure = process.env.ALLOW_INSECURE_DEFAULTS === "1";
  if (isProd && !valid) {
    throw new Error(
      "APP_ENCRYPTION_KEY is missing or malformed (need exactly 64 hex chars = 32 bytes). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (isProd && valid && WEAK_KEYS.has(hex!.toLowerCase()) && !allowInsecure) {
    throw new Error(
      "APP_ENCRYPTION_KEY is a well-known placeholder value — refusing to boot production with it. " +
      "Set a real 32-byte random key, or ALLOW_INSECURE_DEFAULTS=1 for throwaway/CI environments only."
    );
  }
  if (!valid && hex) {
    logger.warn("[vault] APP_ENCRYPTION_KEY is set but malformed — secrets will NOT be encrypted (non-production).");
  }
}

export function encryptionAvailable(): boolean {
  return loadKey() !== null;
}

// Encrypts a secret. If no valid key is configured (non-production only —
// production refuses to boot), returns the plaintext unchanged so the
// prefix-less legacy path handles it.
export function encryptSecret(plain: string): string {
  const key = loadKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

// Decrypts a stored secret. Values NOT starting with "v1:" are legacy
// plaintext rows — returned unchanged so reads never break during rollout.
export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) return stored;
  const key = loadKey();
  if (!key) {
    throw new Error("Cannot decrypt secret: APP_ENCRYPTION_KEY is missing or malformed.");
  }
  const parts = stored.split(":");
  if (parts.length !== 4) throw new Error("Corrupt encrypted secret (expected v1:iv:ct:tag).");
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag); // GCM: authenticates ciphertext — tampering throws
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// True when a stored value is a legacy (pre-encryption) plaintext row.
export function isLegacyPlaintext(stored: string): boolean {
  return !stored.startsWith("v1:");
}

// ---------------------------------------------------------------------------
// Binary blobs (attachment file bytes)
// ---------------------------------------------------------------------------

// Encrypts a binary blob for storage at rest. If no valid key is configured
// (non-production only — production refuses to boot), returns the plaintext
// buffer unchanged, matching encryptSecret()'s keyless fallback.
export function encryptBlob(plain: Buffer): Buffer {
  const key = loadKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BLOB_MAGIC, iv, tag, ciphertext]);
}

// Decrypts a stored blob. Buffers NOT beginning with the magic header are
// legacy plaintext (pre-encryption, or a keyless dev write) — returned
// unchanged so existing attachments keep downloading during rollout.
export function decryptBlob(stored: Buffer): Buffer {
  if (stored.length < BLOB_MAGIC.length || !stored.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
    return stored;
  }
  const key = loadKey();
  if (!key) {
    throw new Error("Cannot decrypt attachment: APP_ENCRYPTION_KEY is missing or malformed.");
  }
  let offset = BLOB_MAGIC.length;
  const iv = stored.subarray(offset, offset + IV_BYTES); offset += IV_BYTES;
  const tag = stored.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES;
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Corrupt encrypted attachment (truncated envelope).");
  }
  const ct = stored.subarray(offset);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag); // GCM: authenticates ciphertext — tampering throws
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
