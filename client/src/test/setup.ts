// Vitest setup for client component tests: adds jest-dom matchers
// (toBeInTheDocument, toHaveClass, …) and unmounts React trees between tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
