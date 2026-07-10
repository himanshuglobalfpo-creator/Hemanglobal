import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { createServer } from "node:http";
import crypto from "node:crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { storage, initDatabase, closeDatabase } from "./storage";
import { logger } from "./logger";
import { mapDbError } from "./db-errors";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Trust the first proxy hop so req.ip / req.protocol are correct behind nginx / Cloudflare.
// Only enable in production; in dev (Vite middleware) we don't need it and it can be misleading.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ----------------------------------------------------------------------------
// Request IDs (Task: structured logging). Honor an incoming x-request-id from
// a trusted proxy if it looks sane; otherwise mint a UUID. Echo it back so the
// client and every log line share the same correlation key.
// ----------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      reqId?: string;
    }
  }
}

const REQ_ID_RE = /^[\w-]{1,64}$/;
app.use((req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const candidate = typeof incoming === "string" ? incoming : undefined;
  req.reqId = candidate && REQ_ID_RE.test(candidate) ? candidate : crypto.randomUUID();
  res.setHeader("x-request-id", req.reqId);
  next();
});

// Security headers. Kept dependency-free (helmet equivalent for what we need).
//
// Content-Security-Policy: served REPORT-ONLY until CSP_ENFORCE=true so
// violations can be observed in the browser console / report tooling before
// anything breaks in production. Allow-list rationale:
//   script-src  — self + Plaid Link + Stripe.js (both load from their CDNs)
//   style-src   — 'unsafe-inline' is required by the public invoice share page
//                 (routes.ts /p/invoice/:token) which inlines its stylesheet,
//                 and by Plaid/Stripe injected iframes' host styles
//   frame-src   — Plaid Link and Stripe render in iframes
//   connect-src — Plaid API (production + sandbox) and Stripe API XHR
//   object-src 'none', base-uri/form-action 'self' — standard hardening
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.plaid.com https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src https://cdn.plaid.com https://js.stripe.com",
  "connect-src 'self' https://production.plaid.com https://sandbox.plaid.com https://api.stripe.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// CSP enforcement policy:
//   • Production defaults to ENFORCING (Content-Security-Policy) — the header is
//     live for real users unless an operator explicitly opts out.
//   • Set CSP_ENFORCE=false to fall back to report-only (e.g. while shaking out
//     violations against the report log before a launch).
//   • Outside production it stays report-only unless CSP_ENFORCE=true, so local
//     dev / Vite HMR is never blocked by accident.
function cspEnforced(): boolean {
  const flag = process.env.CSP_ENFORCE;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const cspHeader = cspEnforced()
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
  res.setHeader(cspHeader, CSP_POLICY);
  if (process.env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

// Body size limits — most accounting requests are small. Large CSV imports route through
// importBankTransactions which bundles parsed rows into a JSON array; 5MB covers ~50k tx.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ----------------------------------------------------------------------------
// Request timeouts (Task 7). Default 30s; PDF streaming and Plaid sync get
// 120s (PDFs stream large statements, Plaid sync pages through the provider
// API). On timeout: 503 if nothing has been sent yet, then destroy the socket
// so the connection can't linger half-open.
// ----------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

app.use((req, res, next) => {
  const isLongRunning =
    req.path.includes("/pdf") || /^\/api\/plaid\/items\/\d+\/sync$/.test(req.path);
  const timeoutMs = isLongRunning ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timed out" });
    }
    // Kill the socket either way — a handler stuck mid-stream must not hold
    // the connection (and its pooled DB work) open indefinitely.
    res.socket?.destroy();
  });
  next();
});

const MAX_LOG_BODY_CHARS = 200;

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const fields: Record<string, unknown> = {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: duration,
        reqId: req.reqId,
        userId: req.user?.id,
        orgId: req.org?.id,
      };
      // Only log response bodies for non-2xx (errors) and only a short prefix —
      // dumping every successful report response floods logs and may include data
      // we'd prefer not to persist (customer info, tax IDs in error envelopes etc.).
      if (capturedJsonResponse && res.statusCode >= 400) {
        const s = JSON.stringify(capturedJsonResponse);
        fields.body = s.length > MAX_LOG_BODY_CHARS ? s.slice(0, MAX_LOG_BODY_CHARS) + "…" : s;
      }
      logger.info(`${req.method} ${path} ${res.statusCode} in ${duration}ms`, fields);
    }
  });

  next();
});

(async () => {
  // PostgreSQL bootstrap MUST complete before any route can touch the DB:
  // runs pending migrations, then seeds the default chart of accounts.
  await initDatabase();

  await registerRoutes(httpServer, app);

  // Periodic session cleanup (deletes expired sessions hourly)
  const { startSessionCleanup } = await import("./auth");
  startSessionCleanup();

  // Run recurring transaction catch-up on server start
  try {
    const caught = await storage.runCatchUp();
    if (caught.length > 0) {
      logger.info(`Recurring catch-up: posted ${caught.reduce((s, c) => s + c.posted, 0)} occurrence(s) across ${caught.length} template(s)`);
    }
  } catch (e: any) {
    logger.error("Recurring catch-up failed", { error: e.message });
  }

  // Estimate-expiry sweep on server start (same catch-up pattern): flip
  // past-expiry draft/sent estimates to 'expired' so a stale quote can't convert.
  try {
    const expired = await storage.expireEstimates();
    if (expired > 0) logger.info(`Estimate expiry sweep: marked ${expired} estimate(s) expired`);
  } catch (e: any) {
    logger.error("Estimate expiry sweep failed", { error: e.message });
  }

  // Depreciation catch-up on server start (same catch-up pattern): backfill any
  // monthly depreciation postings missed while the server was down. Idempotent.
  try {
    const posted = await storage.runDepreciationCatchUp();
    if (posted > 0) logger.info(`Depreciation catch-up: posted ${posted} monthly entr${posted === 1 ? "y" : "ies"}`);
  } catch (e: any) {
    logger.error("Depreciation catch-up failed", { error: e.message });
  }

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    // Map raw Postgres driver errors (unique/FK/range/etc.) to a safe, friendly
    // response. The FULL error — SQLSTATE, constraint, detail, stack — is kept in
    // the structured log below; only the sanitized envelope reaches the client.
    const friendly = mapDbError(err);
    const status = friendly?.status || err.status || err.statusCode || 500;
    const clientMessage = friendly?.message || err.message || "Internal Server Error";

    // Structured, correlated: this reqId matches the x-request-id header the
    // client received — the join key between a support ticket and the logs.
    logger.error("Internal Server Error", {
      reqId: req.reqId,
      status,
      error: err?.message,
      pgCode: err?.code ?? err?.cause?.code,
      pgDetail: err?.detail ?? err?.cause?.detail,
      pgConstraint: err?.constraint ?? err?.cause?.constraint,
      stack: err?.stack?.split("\n").slice(0, 5).join(" | "),
    });

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message: clientMessage });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      logger.info(`serving on port ${port}`);
    },
  );

  // Graceful shutdown: stop accepting new connections, let in-flight requests drain.
  // Without this, a SIGTERM during recurring-catch-up could interrupt a multi-line JE
  // post mid-transaction and leave the database in an inconsistent state.
  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully…`);
    httpServer.close((err) => {
      if (err) {
        logger.error("Error during shutdown", { error: err.message });
        process.exit(1);
      }
      logger.info("HTTP server closed.");
      closeDatabase()
        .then(() => {
          logger.info("PostgreSQL pool drained.");
          process.exit(0);
        })
        .catch(() => process.exit(0));
    });
    // Hard timeout — if connections won't drain in 10s, force exit
    setTimeout(() => {
      logger.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
