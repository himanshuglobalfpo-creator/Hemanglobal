/**
 * TASK 6 tests — HMAC signature, SSRF guard, event fan-out & CSV helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestOrg, db } from "./setup.js";
import { signPayload, assertUrlIsPublic, emitEvent } from "../server/webhooks.js";
import { toCsv } from "../server/csv.js";

test("x-ledgerlite-signature is hex HMAC-SHA256(secret, rawBody)", () => {
  const secret = "whsec_test_123";
  const body = JSON.stringify({ event: "invoice.paid", data: { invoiceId: 7 } });
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(signPayload(secret, body), expected);
  // Receiver-side verification example (documented in README):
  const received = signPayload(secret, body);
  assert.ok(crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex")));
  // Any body tamper breaks the signature.
  assert.notEqual(signPayload(secret, body + " "), expected);
});

test("SSRF guard rejects metadata/loopback/private ranges", async () => {
  await assert.rejects(assertUrlIsPublic("http://169.254.169.254/latest/meta-data"), /private/);
  await assert.rejects(assertUrlIsPublic("http://127.0.0.1:8080/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("http://localhost/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("http://10.1.2.3/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("http://172.16.0.9/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("http://192.168.1.1/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("http://[::1]/hook"), /private/);
  await assert.rejects(assertUrlIsPublic("ftp://example.com/x"), /http/);
  await assert.rejects(assertUrlIsPublic("not a url"), /invalid/);
  // Public literal IP is allowed (no DNS needed).
  await assert.doesNotReject(assertUrlIsPublic("https://8.8.8.8/hook"));
});

test("emitEvent enqueues one pending delivery per subscribed hook only", () => {
  const { orgId } = createTestOrg();
  const other = createTestOrg();
  const ins = db.prepare("INSERT INTO webhooks (org_id, url, secret, events, is_active) VALUES (?,?,?,?,?)");
  ins.run(orgId, "https://example.com/a", "s1", JSON.stringify(["invoice.paid"]), 1);
  ins.run(orgId, "https://example.com/b", "s2", JSON.stringify(["bill.paid"]), 1); // not subscribed
  ins.run(orgId, "https://example.com/c", "s3", JSON.stringify(["invoice.paid"]), 0); // inactive
  ins.run(other.orgId, "https://example.com/d", "s4", JSON.stringify(["invoice.paid"]), 1); // other org

  emitEvent(orgId, "invoice.paid", { invoiceId: 42 });

  const rows = db.prepare("SELECT * FROM webhook_deliveries WHERE org_id = ?").all(orgId) as Array<{
    event: string; status: string; payload: string; attempts: number;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "invoice.paid");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].attempts, 0);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.data.invoiceId, 42);
  assert.equal(payload.orgId, orgId);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE org_id = ?").get(other.orgId) as { n: number }).n, 0);
});

test("toCsv: RFC 4180 quoting for commas, quotes, and newlines", () => {
  const rows = [
    { name: 'Acme, "The" Corp', note: "line1\nline2", amount: 1234 },
    { name: "Plain", note: "", amount: 5 },
  ];
  const csv = toCsv(rows, [
    { header: "Name", value: (r) => r.name },
    { header: "Note", value: (r) => r.note },
    { header: "Amount", value: (r) => (r.amount / 100).toFixed(2) },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Name,Note,Amount");
  assert.equal(lines[1], '"Acme, ""The"" Corp","line1\nline2",12.34');
  // The embedded \n splits lines[1] visually but must remain inside quotes:
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.endsWith("\r\n"));
});
