// ============================================================================
// LOG REDACTION — no PII/secrets in logs
// ============================================================================
// Captures the REAL bytes the logger writes (prod JSON path) and greps them for
// emails and credential shapes — the audit P5.3 requires. Proves:
//   (1) values under sensitive KEYS are replaced wholesale,
//   (2) emails are masked wherever they appear (message, nested field),
//   (3) Bearer/JWT/Stripe-key/hex-token shapes are masked in free text, and
//   (4) ordinary content is left intact (redaction isn't scorched-earth).
//
// Run: tsx tests/log_redaction_test.ts
// ============================================================================

process.env.NODE_ENV = "production"; // exercise the JSON stdout path
const { logger } = await import("../server/logger");

let fail = 0;
const check = (n: string, c: boolean, detail?: string) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

// Capture everything the logger writes to stdout/stderr.
let captured = "";
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
(process.stdout as any).write = (c: any, ...a: any[]) => { captured += c; return true; };
(process.stderr as any).write = (c: any, ...a: any[]) => { captured += c; return true; };

logger.info("user signed in", {
  email: "jane.doe@example.com",            // sensitive-ish value in a plain field
  password: "hunter2super",                  // sensitive KEY
  apiKey: "sk_live_abcdef0123456789ABCDEF",  // sensitive KEY
  authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
  note: "contact me at admin@acme.co or via token whsec_0123456789abcdef0123",
  nested: { userEmail: "nested.user@corp.io", ok: "keep-this-value" },
  orgId: 42,
});
logger.error("boom for user bob@corp.com with hex a1b2c3d4e5f60718293a4b5c6d7e8f90");

// Restore streams before asserting/printing.
(process.stdout as any).write = origOut;
(process.stderr as any).write = origErr;

console.log("Test: log redaction");

check("no raw email addresses remain", !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(captured),
  captured.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]);
check("password value is gone", !captured.includes("hunter2super"));
check("stripe key is gone", !captured.includes("sk_live_abcdef0123456789ABCDEF"));
check("jwt is gone", !captured.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
check("webhook secret is gone", !captured.includes("whsec_0123456789abcdef0123"));
check("bare hex token is gone", !captured.includes("a1b2c3d4e5f60718293a4b5c6d7e8f90"));
check("nested email is gone", !captured.includes("nested.user@corp.io"));
// Non-sensitive content survives.
check("non-sensitive nested value kept", captured.includes("keep-this-value"));
check("numeric field kept", captured.includes("42"));
check("redaction markers present", captured.includes("[redacted]") && captured.includes("[email]"));

if (fail > 0) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("\nAll log-redaction checks passed ✅");
