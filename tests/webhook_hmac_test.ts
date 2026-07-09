// Webhook HMAC signature determinism + SSRF guard IP classification.
// Pure unit test: it imports server/webhooks, which transitively loads
// server/storage (a lazy pg Pool). Give storage a dummy connection string so
// module init doesn't throw — this test never issues a query.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";
import crypto from "node:crypto";

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); if (!c) fail++; };

(async () => {
  // Dynamic import so the DATABASE_URL default above is set before storage's
  // module-level pool is constructed.
  const { signWebhookPayload, assertSafeWebhookUrl } = await import("../server/webhooks");

  console.log("Test: Webhook HMAC + SSRF guard");
  const secret = "supersecretkey1234567890";
  const body = JSON.stringify({ event: "invoice.paid", data: { id: 1 } });
  const sig = signWebhookPayload(secret, body);
  // matches an independent HMAC computation
  const expected = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  check("signature matches independent HMAC-SHA256", sig === expected);
  check("signature is 64 hex chars", /^[0-9a-f]{64}$/.test(sig));
  check("different body → different sig", signWebhookPayload(secret, body + " ") !== sig);
  check("different secret → different sig", signWebhookPayload(secret + "x", body) !== sig);

  // SSRF: private/loopback/metadata rejected; public accepted.
  const rejected = async (url: string) => { try { await assertSafeWebhookUrl(url); return false; } catch { return true; } };
  check("rejects 127.0.0.1", await rejected("http://127.0.0.1/hook"));
  check("rejects 10.x", await rejected("http://10.1.2.3/hook"));
  check("rejects 192.168.x", await rejected("https://192.168.0.1/hook"));
  check("rejects 172.16.x", await rejected("http://172.16.5.5/hook"));
  check("rejects cloud metadata 169.254.169.254", await rejected("http://169.254.169.254/latest/meta-data/"));
  check("rejects non-http scheme", await rejected("ftp://example.com/hook"));
  // public host should pass (uses DNS; example.com resolves to public IPs)
  const publicOk = async (url: string) => { try { await assertSafeWebhookUrl(url); return true; } catch { return false; } };
  check("accepts public https URL", await publicOk("https://example.com/hook"));
  if (fail) { console.log(`\n❌ ${fail} failed`); process.exit(1); }
  console.log("\n✅ ALL TESTS PASS — HMAC deterministic; SSRF guard blocks private ranges");
})();
