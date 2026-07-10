import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Modern evergreen-browser baseline. Vite's default "modules" target
    // (chrome87/es2020/…) forces esbuild to DOWN-transform destructuring that
    // some dependencies ship, which esbuild 0.28 refuses ("Transforming
    // destructuring to the configured target environment is not supported
    // yet") — breaking the whole build. es2022 is supported natively by every
    // browser this SaaS targets, so esbuild passes the syntax through instead.
    target: "es2022",
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
