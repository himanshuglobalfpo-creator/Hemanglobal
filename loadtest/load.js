// ============================================================================
// k6 load test — LedgerLite hot paths against a 100k-line reference org
// ============================================================================
// Covers dashboard, invoice list (paginated), invoice create, report generation
// (P&L + balance sheet), and the bank-transaction list. Targets (see LOADTEST.md):
//   • p95 < 500ms for LIST/dashboard endpoints
//   • p95 < 2s   for REPORT endpoints
// at 50 concurrent users on the reference instance.
//
// Prereqs:
//   1. Seed the org:  DATABASE_URL=… npx tsx scripts/seed-loadtest.ts
//   2. Create a login for org 'loadtest-co' and export creds below.
// Run:
//   k6 run -e BASE_URL=https://staging.example -e EMAIL=… -e PASSWORD=… loadtest/load.js
// ============================================================================

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:5000";
const EMAIL = __ENV.EMAIL || "load@loadtest-co.test";
const PASSWORD = __ENV.PASSWORD || "loadtest-password";

const listLatency = new Trend("list_latency", true);
const reportLatency = new Trend("report_latency", true);

export const options = {
  scenarios: {
    steady: { executor: "constant-vus", vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || "1m" },
  },
  thresholds: {
    // The headline SLOs — the run FAILS if these are exceeded.
    "list_latency": ["p(95)<500"],
    "report_latency": ["p(95)<2000"],
    "http_req_failed": ["rate<0.01"],
  },
};

// Read the ll_csrf cookie k6 stored after login, to echo on mutations.
function csrf(jarCookies) {
  const c = jarCookies["__Host-ll_csrf"] || jarCookies["ll_csrf"];
  return c && c.length ? c[0].value : "";
}

export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" } });
  check(res, { "login ok": (r) => r.status === 200 });
  // k6 keeps cookies per-VU via a jar; return nothing — each VU logs in in default().
  return {};
}

export default function () {
  // Each VU authenticates once (cookie jar persists across iterations for the VU).
  const jar = http.cookieJar();
  const existing = jar.cookiesForURL(`${BASE}/`);
  if (!existing["ll_session"] && !existing["__Host-ll_session"]) {
    http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }),
      { headers: { "Content-Type": "application/json" } });
  }

  group("dashboard", () => {
    const r = http.get(`${BASE}/api/dashboard`);
    listLatency.add(r.timings.duration);
    check(r, { "dashboard 200": (x) => x.status === 200 });
  });

  group("invoice list (paginated)", () => {
    const r = http.get(`${BASE}/api/invoices?limit=50&offset=0`);
    listLatency.add(r.timings.duration);
    check(r, { "invoices 200": (x) => x.status === 200 });
  });

  group("bank transaction list", () => {
    const r = http.get(`${BASE}/api/bank-transactions?limit=50&offset=0`);
    listLatency.add(r.timings.duration);
    check(r, { "bank tx 200": (x) => x.status === 200 });
  });

  group("reports", () => {
    const pl = http.get(`${BASE}/api/reports/profit-loss?from=2024-01-01&to=2025-12-31`);
    reportLatency.add(pl.timings.duration);
    check(pl, { "P&L 200": (x) => x.status === 200 });
    const bs = http.get(`${BASE}/api/reports/balance-sheet?date=2025-12-31`);
    reportLatency.add(bs.timings.duration);
    check(bs, { "balance sheet 200": (x) => x.status === 200 });
  });

  group("invoice create", () => {
    const token = csrf(jar.cookiesForURL(`${BASE}/`));
    const r = http.post(`${BASE}/api/invoices`, JSON.stringify({
      date: "2025-06-01", dueDate: "2025-07-01",
      lines: [{ description: "Load test", quantity: 1, unitPrice: 10000 }],
    }), { headers: { "Content-Type": "application/json", "x-csrf-token": token } });
    // 200/201 on success; a 4xx here is a data-shape issue, not a perf failure.
    check(r, { "invoice create not 5xx": (x) => x.status < 500 });
  });

  sleep(1);
}
