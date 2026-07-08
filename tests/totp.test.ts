/**
 * TASK 2 tests — RFC 6238 vectors, ±1-step verify window, base32 round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import "./setup.js";
import { base32Encode, base32Decode, totpCode, verifyTotp, otpauthUri, generateTotpSecret, generateRecoveryCodes } from "../server/totp.js";

// RFC 6238 Appendix B uses ASCII secret "12345678901234567890" (SHA-1).
const RFC_SECRET_B32 = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("RFC 6238 SHA-1 test vectors (6-digit truncation)", () => {
  // Vector codes are the last 6 digits of the published 8-digit values.
  assert.equal(totpCode(RFC_SECRET_B32, 59 * 1000), "287082"); // 94287082
  assert.equal(totpCode(RFC_SECRET_B32, 1111111109 * 1000), "081804"); // 07081804
  assert.equal(totpCode(RFC_SECRET_B32, 1234567890 * 1000), "005924"); // 89005924
  assert.equal(totpCode(RFC_SECRET_B32, 2000000000 * 1000), "279037"); // 69279037
});

test("verify window accepts ±1 step and rejects ±2", () => {
  const now = 1_700_000_000_000;
  const prev = totpCode(RFC_SECRET_B32, now - 30_000);
  const curr = totpCode(RFC_SECRET_B32, now);
  const next = totpCode(RFC_SECRET_B32, now + 30_000);
  const stale = totpCode(RFC_SECRET_B32, now - 60_000);
  assert.equal(verifyTotp(RFC_SECRET_B32, prev, now), true);
  assert.equal(verifyTotp(RFC_SECRET_B32, curr, now), true);
  assert.equal(verifyTotp(RFC_SECRET_B32, next, now), true);
  // A ±2-step code only fails when it differs from the in-window codes.
  if (stale !== prev && stale !== curr && stale !== next) {
    assert.equal(verifyTotp(RFC_SECRET_B32, stale, now), false);
  }
  assert.equal(verifyTotp(RFC_SECRET_B32, "000000", now) && curr !== "000000" && prev !== "000000" && next !== "000000", false);
  assert.equal(verifyTotp(RFC_SECRET_B32, "12345", now), false); // wrong length
  assert.equal(verifyTotp(RFC_SECRET_B32, "abcdef", now), false); // non-digits
});

test("base32 round-trip", () => {
  for (const len of [1, 5, 10, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) % 256));
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
});

test("secret generation + otpauth URI shape", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/); // 20 bytes → 32 base32 chars
  const uri = otpauthUri(secret, "owner@example.com");
  assert.match(uri, /^otpauth:\/\/totp\/LedgerLite:owner%40example\.com\?secret=/);
  assert.ok(uri.includes("issuer=LedgerLite"));
  assert.ok(uri.includes("period=30"));
});

test("recovery codes: 8 unique formatted codes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
});
