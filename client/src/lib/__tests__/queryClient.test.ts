import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isPaginatedEnvelope, readCsrfToken, apiRequest, getQueryFn } from "@/lib/queryClient";

// Data-layer unit tests: these guard the real request plumbing every page
// depends on — CSRF echo, the paginated-envelope unwrap, and 401 handling.

describe("isPaginatedEnvelope", () => {
  it("recognizes a { rows, total } envelope", () => {
    expect(isPaginatedEnvelope({ rows: [], total: 0 })).toBe(true);
  });
  it("rejects a bare array or plain object", () => {
    expect(isPaginatedEnvelope([1, 2, 3])).toBe(false);
    expect(isPaginatedEnvelope({ foo: "bar" })).toBe(false);
    expect(isPaginatedEnvelope(null)).toBe(false);
  });
});

describe("readCsrfToken", () => {
  it("reads the ll_csrf cookie", () => {
    document.cookie = "ll_csrf=abc123";
    expect(readCsrfToken()).toBe("abc123");
  });
});

describe("apiRequest", () => {
  beforeEach(() => {
    document.cookie = "ll_csrf=tok-42";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("echoes the CSRF token on a mutating request and serializes the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("POST", "/api/customers", { name: "Acme" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/customers");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("tok-42");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Acme" }));
  });

  it("does NOT send a CSRF header on a GET", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("GET", "/api/health");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBeUndefined();
  });

  it("throws with status + body on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(apiRequest("GET", "/api/oops")).rejects.toThrow(/500: boom/);
  });
});

describe("getQueryFn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("unwraps a paginated envelope into a bare array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ rows: [{ id: 1 }, { id: 2 }], total: 2 }), { status: 200 })
    ));
    const fn = getQueryFn<any>({ on401: "throw" });
    const out = await fn({ queryKey: ["/api/invoices"] } as any);
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns null on 401 when configured to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const fn = getQueryFn<any>({ on401: "returnNull" });
    const out = await fn({ queryKey: ["/api/auth/me"] } as any);
    expect(out).toBeNull();
  });
});
