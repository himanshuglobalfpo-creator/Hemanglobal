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
    // Split heavy vendor libraries into their own long-cached chunks so the
    // initial download stays small. Combined with the route-based React.lazy
    // splitting in App.tsx, recharts (~the biggest dep) only ships when a chart
    // page loads, and each vendor group caches independently across deploys.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // Pull ONLY the charting stack (recharts + its d3 deps) into its own
          // chunk. It is a large, leaf-like library used exclusively by the
          // lazily-loaded Dashboard/Reports pages, so isolating it keeps it off
          // the initial download entirely. Everything else is left to Vite's
          // default chunking, which co-locates interdependent modules and
          // avoids the circular-chunk warnings that forced react/tanstack/radix
          // groupings produce (they import each other).
          if (id.includes("recharts") || id.includes("/d3-") || id.includes("victory-vendor")) return "charts";
          return undefined;
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
