// ============================================================================
// CRYPTO VAULT — attachment blob encryption at rest (AES-256-GCM)
// ============================================================================
// Proves the encryptBlob/decryptBlob envelope used by the attachment routes:
//   (1) round-trips arbitrary binary bytes losslessly under a real key,
//   (2) actually encrypts (ciphertext != plaintext, carries the LLE1 magic),
//   (3) authenticates — a single flipped byte fails the GCM tag,
//   (4) passes legacy plaintext blobs (no magic header) straight through, and
//   (5) refuses to decrypt an encrypted blob when the key is missing.
//
// Run: tsx tests/crypto_vault_blob_test.ts
// ============================================================================

import crypto from "node:crypto";
import { encryptBlob, decryptBlob } from "../server/crypto-vault";

// loadKey() reads process.env.APP_ENCRYPTION_KEY on every call, so setting it
// here (after the static import) is sufficient — the vault picks it up lazily.
const KEY = crypto.randomBytes(32).toString("hex");
process.env.APP_ENCRYPTION_KEY = KEY;

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

console.log("Test: crypto-vault attachment blob encryption");

// (1) Round-trip a realistic binary payload (fake PDF header + random body).
const plain = Buffer.concat([Buffer.from("%PDF-1.7\n", "ascii"), crypto.randomBytes(4096)]);
const enc = encryptBlob(plain);
const dec = decryptBlob(enc);
check("round-trips binary bytes losslessly", dec.equals(plain));

// (2) It is genuinely encrypted: ciphertext differs from plaintext and carries
//     the LLE1 magic + is longer by the envelope overhead (4 magic + 12 iv + 16 tag).
check("ciphertext differs from plaintext", !enc.subarray(0, plain.length).equals(plain));
check("carries LLE1 magic header", enc.subarray(0, 4).toString("ascii") === "LLE1");
check("envelope adds exactly 32 bytes of overhead", enc.length === plain.length + 32);

// (3) Tamper detection: flip one ciphertext byte → GCM tag check must throw.
const tampered = Buffer.from(enc);
tampered[tampered.length - 1] ^= 0x01;
let threw = false;
try { decryptBlob(tampered); } catch { threw = true; }
check("tampered ciphertext is rejected (GCM auth)", threw);

// (4) Legacy plaintext (no magic) passes through unchanged.
const legacy = Buffer.from("plain receipt bytes, pre-encryption", "utf8");
check("legacy plaintext passes through unchanged", decryptBlob(legacy).equals(legacy));

// A short buffer (shorter than the magic) is treated as legacy, not crashed.
const tiny = Buffer.from([0x01, 0x02]);
check("sub-magic-length buffer treated as legacy", decryptBlob(tiny).equals(tiny));

// (5) Empty payload still round-trips (zero-length ciphertext, valid tag).
const emptyEnc = encryptBlob(Buffer.alloc(0));
check("empty payload round-trips", decryptBlob(emptyEnc).length === 0);

// (6) Without a key, an encrypted blob cannot be decrypted (fails closed).
delete process.env.APP_ENCRYPTION_KEY;
let noKeyThrew = false;
try { decryptBlob(enc); } catch { noKeyThrew = true; }
check("decrypt without key throws (fails closed)", noKeyThrew);
// ...but a legacy plaintext blob still reads even with no key.
check("legacy plaintext still readable without key", decryptBlob(legacy).equals(legacy));
process.env.APP_ENCRYPTION_KEY = KEY; // restore

if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
console.log("\n✅ ALL TESTS PASS — attachment blobs encrypted at rest (AES-256-GCM)");
