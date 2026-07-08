// Flat ESLint config: typescript-eslint recommended over server/shared/
// scripts/tests, plus a browser-globals block for the vanilla-JS client.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
  })),
  {
    files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["client/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        window: "readonly", document: "readonly", fetch: "readonly", location: "readonly",
        URLSearchParams: "readonly", Intl: "readonly", prompt: "readonly", alert: "readonly",
        confirm: "readonly",
      },
    },
    rules: { ...js.configs.recommended.rules },
  },
];
