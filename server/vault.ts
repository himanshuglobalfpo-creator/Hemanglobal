/**
 * server/vault.ts — crypto-vault v1 (Phase 2 format).
 * AES-256-GCM; serialized as "v1:<iv b64>:<authTag b64>:<ciphertext b64>".
 * Key comes from env VAULT_KEY (any string; stretched with scrypt + static
 * app salt so short dev keys still yield 32 bytes).
 */
import crypto from "node:crypto";

const APP_SALT = "ledgerlite-vault-v1";

function key(): Buffer {
  const raw = process.env.VAULT_KEY ?? "dev-only-vault-key-change-me";
  return crypto.scryptSync(raw, APP_SALT, 32);
}

export function vaultEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function vaultDecrypt(serialized: string): string {
  const [version, ivB64, tagB64, ctB64] = serialized.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("unsupported vault format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
