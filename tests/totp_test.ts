// TOTP verify window + base32 round-trip + HMAC signature determinism.
import { generateTotpSecret, totpCode, verifyTotp, base32Encode, base32Decode, generateRecoveryCodes } from "../server/totp";
import crypto from "node:crypto";
let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };
console.log("Test: TOTP (RFC 6238)");
// base32 round-trip
const raw = crypto.randomBytes(20);
check("base32 round-trips", base32Decode(base32Encode(raw)).equals(raw));
const secret = generateTotpSecret();
const now = Date.now();
const code = totpCode(secret, now);
check("current code verifies", verifyTotp(secret, code, now));
// ±1 step window
check("previous step (-30s) accepted", verifyTotp(secret, totpCode(secret, now - 30_000), now));
check("next step (+30s) accepted", verifyTotp(secret, totpCode(secret, now + 30_000), now));
// outside window rejected
check("+2 steps (+60s) rejected", !verifyTotp(secret, totpCode(secret, now + 60_000), now));
check("wrong code rejected", !verifyTotp(secret, "000000", now) || totpCode(secret, now) === "000000");
check("non-numeric rejected", !verifyTotp(secret, "abcdef", now));
// recovery codes shape + uniqueness
const rc = generateRecoveryCodes(8);
check("8 recovery codes", rc.length === 8);
check("recovery codes unique", new Set(rc).size === 8);
check("recovery format XXXXX-XXXXX", rc.every((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c)));
if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
console.log("\n✅ ALL TESTS PASS — TOTP window + base32 + recovery codes verified");
