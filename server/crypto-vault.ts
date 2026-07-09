// ============================================================================
// CRYPTO VAULT — AES-256-GCM encryption for secrets at rest (Plaid tokens)
// ============================================================================
// Key: env APP_ENCRYPTION_KEY, exactly 64 hex chars (32 bytes). In production
// a missing/malformed key is a boot-time failure (validated from
// initDatabase() via assertEncryptionKey()) — better to refuse to start than
// to silently write plaintext secrets.
//
// Stored format:  "v1:" + base64(iv) + ":" + base64(ciphertext) + ":" + base64(authTag)
// The "v1:" prefix does two jobs:
//   1. Versioning — a future "v2:" (new KDF, key rotation, etc.) can coexist.
//   2. Legacy detection — rows written before encryption shipped have no
//      prefix; decryptSecret() passes them through unchanged so reads never
//      break, and storage lazily re-encrypts them on first read.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — the NIST-recommended size for GCM
const KEY_HEX_LEN = 64; // 32 bytes

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
export function assertEncryptionKey(): void {
  const hex = process.env.APP_ENCRYPTION_KEY;
  const valid = !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
  if (process.env.NODE_ENV === "production" && !valid) {
    throw new Error(
      "APP_ENCRYPTION_KEY is missing or malformed (need exactly 64 hex chars = 32 bytes). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (!valid && hex) {
    console.warn("[vault] APP_ENCRYPTION_KEY is set but malformed — secrets will NOT be encrypted (non-production).");
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
