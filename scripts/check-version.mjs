#!/usr/bin/env node
// ============================================================================
// VERSION-LITERAL CHECK (CI guardrail)
// ============================================================================
// package.json is the single source of truth for the app version. This blocks
// the "bumped package.json but left a stale version string somewhere" class of
// mistake: it greps tracked source for any app-version literal (a line that
// mentions "version" AND carries an x.y.z semver) and fails if one disagrees
// with package.json. Non-app semvers are ignored — Stripe's date-based
// apiVersion ("2024-06-20"), dependency specifiers ("^1.2.3"), and version
// ranges are all skipped.
//
// Run: node scripts/check-version.mjs   (also part of `npm test`)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`❌ package.json version "${VERSION}" is not a plain semver.`);
  process.exit(1);
}

const SCAN_DIRS = ["server", "client/src", "shared"];
const SCAN_FILES = ["README.md", "Dockerfile"];
const SEMVER = /\b(\d+\.\d+\.\d+)\b/;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(p)); }
    else if (/\.(ts|tsx|js|mjs|cjs|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...SCAN_FILES.map((f) => path.join(ROOT, f))];

let mismatches = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/version/i.test(line)) return;
    if (/apiVersion|api_version/i.test(line)) return;                 // Stripe's dated API version
    if (/content-type|charset|text\/plain|application\//i.test(line)) return; // MIME/protocol version params (e.g. Prometheus version=0.0.4)
    if (/["']\^|["']~|>=|<=/.test(line)) return;                      // dependency range specifiers
    const m = line.match(SEMVER);
    if (m && m[1] !== VERSION) {
      mismatches++;
      console.error(`❌ ${path.relative(ROOT, file)}:${i + 1} version literal ${m[1]} ≠ package.json ${VERSION}`);
      console.error(`   ${line.trim()}`);
    }
  });
}

if (mismatches > 0) {
  console.error(`\n❌ ${mismatches} stale app-version literal(s). Update them to ${VERSION} or read the version from package.json.`);
  process.exit(1);
}
console.log(`✅ Version literal check passed — app version ${VERSION} is consistent.`);
