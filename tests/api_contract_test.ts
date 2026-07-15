// ============================================================================
// API CONTRACT — every client /api/* path must match a server route
// ============================================================================
// Static guard against the "dead flow" class of bug (a UI calling an endpoint
// that doesn't exist — e.g. the removed /api/auth/otp before it was built):
//
//   1. Scan client/src for every "/api/..." string the UI can hit (apiRequest,
//      query keys, fetch, window.open, raw fetch to /api/import, etc.).
//   2. Scan the server for every registered route (app.get/post/put/patch/
//      delete("/api/...")) across all server/*.ts files.
//   3. Assert each client path shape matches at least one server route shape,
//      treating :params and ${...} segments as wildcards.
//
// Run: tsx tests/api_contract_test.ts
// ============================================================================

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const CLIENT_DIR = path.join(ROOT, "client", "src");
const SERVER_DIR = path.join(ROOT, "server");

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // Skip test files/fixtures — they intentionally reference fake endpoints
    // (e.g. "/api/oops" to exercise error handling).
    if (e.name === "__tests__" || /\.test\.[jt]sx?$/.test(e.name)) continue;
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// Normalize a path into comparable segments: strip query, coerce dynamic
// segments (`${...}`, `:param`, or a bare `*`) to the wildcard token "*".
function segments(raw: string): string[] {
  const clean = raw.split("?")[0].replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).map((s) =>
    s.includes("${") || s.startsWith(":") || s === "*" ? "*" : s
  );
}
function pathMatches(clientSegs: string[], serverSegs: string[]): boolean {
  if (clientSegs.length !== serverSegs.length) return false;
  return clientSegs.every((c, i) => c === "*" || serverSegs[i] === "*" || c === serverSegs[i]);
}

// ---- Collect server routes ----
const serverRoutes = new Set<string>();
for (const file of walk(SERVER_DIR, [".ts"])) {
  const src = fs.readFileSync(file, "utf8");
  const re = /\bapp\.(?:get|post|put|patch|delete)\(\s*[`"']([^`"']+)[`"']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) if (m[1].startsWith("/api/")) serverRoutes.add(m[1]);
}
const serverSegLists = [...serverRoutes].map(segments);

// ---- Collect client API paths ----
const clientPaths = new Set<string>();
for (const file of walk(CLIENT_DIR, [".ts", ".tsx"])) {
  const src = fs.readFileSync(file, "utf8");
  // Any "/api/..." literal in a string or template literal.
  const re = /[`"'](\/api\/[^`"'\s)]+)[`"']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Ignore obvious non-endpoints (none expected, but be defensive).
    clientPaths.add(m[1]);
  }
}

let failures = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  if (cond) { /* quiet on pass */ } else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

console.log(`API contract: ${clientPaths.size} client paths vs ${serverRoutes.size} server routes`);
let matched = 0;
for (const cp of clientPaths) {
  const cs = segments(cp);
  const ok = serverSegLists.some((ss) => pathMatches(cs, ss));
  check(`client path "${cp}" has a server route`, ok, "no matching app.<method>() registration");
  if (ok) matched++;
}

if (failures) {
  console.error(`\n❌ ${failures} client path(s) have no matching server route.`);
  process.exit(1);
}
console.log(`✅ ALL ${matched} client /api paths map to a registered server route.`);
