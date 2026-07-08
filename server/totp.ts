/**
 * server/totp.ts — TASK 2: dependency-free TOTP (RFC 6238).
 * HMAC-SHA-1, 6 digits, 30-second step, verification window of ±1 step.
 * Includes RFC 4648 base32 helpers and an otpauth:// URI builder.
 */
import crypto from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20)); // 160-bit secret per RFC 4226
}

/** RFC 4226 HOTP truncation for a given counter. */
function hotp(secretB32: string, counter: number): string {
  const keyBuf = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  // JS numbers are safe here: counters stay far below 2^53.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac("sha1", keyBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpCode(secretB32: string, atMs: number = Date.now(), stepSeconds = 30): string {
  return hotp(secretB32, Math.floor(atMs / 1000 / stepSeconds));
}

/** Verify with a ±1-step window (accepts previous/current/next 30s codes). */
export function verifyTotp(secretB32: string, code: string, atMs: number = Date.now(), stepSeconds = 30): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  for (const drift of [-1, 0, 1]) {
    const expected = hotp(secretB32, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

export function otpauthUri(secretB32: string, accountEmail: string, issuer = "LedgerLite"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** 8 human-friendly one-time recovery codes (plaintext; caller hashes). */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
