// ============================================================================
// TOTP — RFC 6238, dependency-free
// ============================================================================
// SHA-1 HMAC (the algorithm every authenticator app defaults to), 6 digits,
// 30-second step, verification window of ±1 step (accepts the previous and
// next code to absorb clock skew). Includes RFC 4648 base32 helpers and an
// otpauth:// URI builder for authenticator-app enrollment.

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
  const clean = s.toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  // 20 random bytes = 160-bit secret, the RFC 4226 recommended size for SHA-1.
  return base32Encode(crypto.randomBytes(20));
}

// HOTP value for one counter (RFC 4226 §5.3, dynamic truncation).
function hotp(secretB32: string, counter: number): string {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  // Counter is 8 bytes big-endian; JS numbers cover this range safely
  // (2^53 >> any realistic Unix-time/30 counter).
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return String(code).padStart(6, "0");
}

const STEP_SECONDS = 30;
const WINDOW = 1; // ± steps accepted

export function totpCode(secretB32: string, atMs: number = Date.now()): string {
  return hotp(secretB32, Math.floor(atMs / 1000 / STEP_SECONDS));
}

// Constant-time 6-digit compare, then check the current step and ±WINDOW.
export function verifyTotp(secretB32: string, code: string, atMs: number = Date.now()): boolean {
  const clean = String(code).replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const expected = hotp(secretB32, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

// otpauth://totp/LedgerLite:user@example.com?secret=...&issuer=LedgerLite&algorithm=SHA1&digits=6&period=30
export function otpauthUri(secretB32: string, accountEmail: string, issuer = "LedgerLite"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// 8 one-time recovery codes: 10 chars, crockford-ish alphabet without lookalikes.
export function generateRecoveryCodes(count = 8): string[] {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let c = "";
    const bytes = crypto.randomBytes(10);
    for (const b of bytes) c += alphabet[b % alphabet.length];
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return codes;
}
