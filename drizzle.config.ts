import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./migrations/pg",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://ledgerlite:ledgerlite@localhost:5432/ledgerlite",
  },
});
