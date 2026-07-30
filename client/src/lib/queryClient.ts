import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// ----------------------------------------------------------------------------
// CSRF (Task 2): read the double-submit cookie set by the server on login and
// echo it back in x-csrf-token on every mutating request. The cookie is
// intentionally NOT HttpOnly — this read is the whole mechanism.
// ----------------------------------------------------------------------------
const CSRF_COOKIE = "ll_csrf";
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function readCsrfToken(): string | undefined {
  // Production sets the cookie under the __Host- prefix (Secure + Path=/); dev
  // uses the bare name. Read either so one client build works in both.
  for (const name of [`__Host-${CSRF_COOKIE}`, CSRF_COOKIE]) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

function csrfHeaders(method: string): Record<string, string> {
  if (!MUTATING.has(method.toUpperCase())) return {};
  const token = readCsrfToken();
  return token ? { "x-csrf-token": token } : {};
}

// ----------------------------------------------------------------------------
// Pagination (Task 1): these endpoints now return { rows, total, limit, offset }
// instead of a bare array. Phase 1 client behavior: request limit=200 and
// unwrap .rows so every existing consumer keeps seeing an array. UI pagination
// controls are a later phase.
// ----------------------------------------------------------------------------
const PAGINATED_PATHS = new Set([
  "/api/invoices",
  "/api/bills",
  "/api/journal",
  "/api/customers",
  "/api/vendors",
  "/api/bank-transactions",
  "/api/audit",
]);

export function isPaginatedEnvelope(body: unknown): body is { rows: unknown[]; total: number } {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as any).rows) &&
    typeof (body as any).total === "number"
  );
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...csrfHeaders(method),
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    let url = queryKey.join("/");
    // Paginated list endpoints: request the max page and unwrap below.
    if (PAGINATED_PATHS.has(url)) {
      url = `${url}?limit=200`;
    }
    const res = await fetch(`${API_BASE}${url}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    const body = await res.json();
    // Unwrap { rows, total, ... } so consumers keep receiving plain arrays.
    if (isPaginatedEnvelope(body)) {
      return body.rows as any;
    }
    return body;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
