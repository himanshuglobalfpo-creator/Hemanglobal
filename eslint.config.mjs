// ============================================================================
// ESLint flat config (ESLint 9)
// ============================================================================
// Named `.mjs` on purpose: package.json has no "type":"module", so a `.js`
// config with `import` would reintroduce the MODULE_TYPELESS_PACKAGE_JSON
// warning we fixed for postcss. `eslint .` auto-discovers this file.
//
// Rule philosophy for a large, pre-existing codebase: correctness-oriented
// rules are errors; stylistic/΅churn rules that would flag hundreds of existing
// lines are warnings, so `npm run lint` (which fails only on ERRORS) passes
// while still surfacing cleanups. Import ordering is auto-fixable (`--fix`).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "build/**",
      "**/*.tsbuildinfo",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
    ],
  },

  // Base JS + TypeScript (non-type-checked: fast, no full type graph needed).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Shared rules across all TS/TSX.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { import: importPlugin },
    rules: {
      "import/order": [
        "error",
        {
          groups: [["builtin", "external"], ["internal", "parent", "sibling", "index"]],
          "newlines-between": "ignore",
          warnOnUnassignedImports: false,
        },
      ],
      // This codebase intentionally uses `any` at DB/driver boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      // Underscore-prefixed = deliberately unused; everything else is a warning
      // (unused code is a smell, not a build-breaker).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      // Don't flag a destructuring where at least one target must stay `let`
      // (e.g. `let [, mo, d, y] = m` where only `y` is reassigned).
      "prefer-const": ["error", { destructuring: "all" }],
      // Optional SDKs (plaid, stripe, ioredis) and Tailwind config plugins are
      // loaded via lazy require() on purpose — see the boundary comments there.
      "@typescript-eslint/no-require-imports": "off",
      // `declare global { namespace Express { ... } }` is the standard way to
      // augment Express's Request type — ES module syntax can't express it.
      "@typescript-eslint/no-namespace": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-control-regex": "off",
    },
  },

  // Client (React) — browser globals + React/hooks rules.
  {
    files: ["client/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 18 automatic JSX runtime — no need to import React in scope.
      "react/react-in-jsx-scope": "off",
      // TypeScript already checks prop types.
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off",
      // Radix/cmdk primitives carry custom data attributes (e.g. cmdk-*).
      "react/no-unknown-property": "off",
    },
  },

  // Generated shadcn/ui primitives (vendored) — relax stylistic churn rules.
  {
    files: ["client/src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "prefer-const": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },

  // Server, shared, tests, root TS configs — Node globals.
  {
    files: ["server/**/*.ts", "shared/**/*.ts", "tests/**/*.ts", "*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Plain-JS/CJS harnesses (tests/*.js, *.cjs, *.mjs) — CommonJS + Node globals.
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: { globals: { ...globals.node }, sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
);
