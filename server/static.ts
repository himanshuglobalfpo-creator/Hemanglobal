import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function serveStatic(app: Express) {
  // Resolve relative to the EXECUTING file. `__dirname` gets inlined by esbuild
  // as the *source* directory ("server/"), which doesn't exist next to the
  // production bundle — import.meta.url survives bundling and points at
  // dist/index.js, so this finds dist/public exactly where vite wrote it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(here, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
