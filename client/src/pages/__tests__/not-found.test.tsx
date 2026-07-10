import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import NotFound from "@/pages/not-found";

// Component render test: exercises the real component, the "@/…" alias, and a
// vendored shadcn/ui Card primitive under jsdom.
describe("NotFound page", () => {
  it("renders the 404 heading", () => {
    render(<NotFound />);
    expect(screen.getByText(/404 Page Not Found/i)).toBeInTheDocument();
  });

  it("shows the helper copy", () => {
    render(<NotFound />);
    expect(screen.getByText(/add the page to the router/i)).toBeInTheDocument();
  });
});
