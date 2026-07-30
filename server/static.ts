import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function serveStatic(app: Express) {
  // Resolve relative to the EXECUTING file. `__dirname` gets inlined by esbuild
  // as the *source* directory ("server/"), which doesn't exist next to the
  // production bundle — import.meta.url survives bundling and points at
  // dist/index.mjs, so this finds dist/public exactly where vite wrote it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(here, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // SPA fallback: any GET that didn't match a static file or an API route gets
  // index.html so client-side routing (wouter) can take over. This runs AFTER
  // registerRoutes, so real /api endpoints are already handled.
  //
  // IMPORTANT: the pattern must be Express-4 compatible. This project pins
  // express@4 (path-to-regexp 0.1.x), where `*` is the "match anything"
  // wildcard. The Express-5 form `/{*path}` treats `{`/`}` as LITERAL
  // characters here, so `/` would never match and the app would 404 at root.
  // `app.get("*")` is the canonical, version-safe SPA catch-all.
  app.get("*", (req, res, next) => {
    // Don't mask an unmatched API route with HTML — let it 404 as JSON.
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
