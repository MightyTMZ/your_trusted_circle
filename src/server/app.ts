/**
 * YTC backend API (docs/YTC Grand Architecture.png, box 2), in five parts:
 *
 * 1. Authentication and session authorization   auth/        who you are; participant rules (authz.ts)
 * 2. Session lifecycle and event validation      lifecycle/   create, join, end; accept only catalogued events
 * 3. Safety state and deadlines                  safety/      check-ins, heartbeats, cancellation, escalation
 * 4. Alert orchestration                         alerts/      notification jobs, results, retries, acknowledgment
 * 5. Data access and retention                   data/        permitted timelines, expiry, export, deletion
 *
 * Security defaults: cookie sign-in (httpOnly, SameSite=Lax), Origin check on
 * every state-changing request (except Apple's cross-site sign-in callback,
 * which is protected by its OAuth state), JSON-only bodies, no IP logging.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { alertRoutes } from "./alerts/routes.js";
import { authRoutes } from "./auth/routes.js";
import { fail, type AppEnv, type Deps } from "./context.js";
import { accountRoutes } from "./data/account.js";
import { dataRoutes } from "./data/timeline.js";
import { ingestRoutes } from "./lifecycle/events.js";
import { relayRoutes } from "./lifecycle/relay.js";
import { sessionRoutes } from "./lifecycle/sessions.js";
import { safetyRoutes } from "./safety/routes.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const allowedOrigins = new Set([deps.config.appOrigin, deps.config.apiOrigin]);

  app.use("*", secureHeaders());
  app.use("/api/*", cors({ origin: deps.config.appOrigin, credentials: true, allowMethods: ["GET", "POST", "PATCH", "DELETE"] }));

  // CSRF: browsers always send Origin on cross-site POST/PATCH/DELETE.
  app.use("/api/*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.method === "POST" && /^\/api\/auth\/[a-z]+\/callback$/.test(c.req.path)) return next();
    const origin = c.req.header("Origin");
    if (!origin || !allowedOrigins.has(origin)) return fail(c, 403, "bad_origin", "Request blocked: unexpected origin.");
    const type = c.req.header("Content-Type") ?? "";
    if (c.req.raw.body !== null && !type.startsWith("application/json")) return fail(c, 415, "json_only", "Send JSON.");
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  // 1. Authentication and session authorization
  app.route("/api/auth", authRoutes(deps));
  // 2. Session lifecycle and event validation
  app.route("/api/sessions", sessionRoutes(deps));
  app.route("/api/ingest", ingestRoutes(deps));
  app.route("/api", relayRoutes(deps));
  // 3. Safety state and deadlines
  app.route("/api", safetyRoutes(deps));
  // 4. Alert orchestration
  app.route("/api", alertRoutes(deps));
  // 5. Data access and retention
  app.route("/api", dataRoutes(deps));
  app.route("/api/me", accountRoutes(deps));

  app.notFound((c) => fail(c, 404, "not_found", "No such endpoint."));
  app.onError((err, c) => {
    // Log the error type only; messages can contain request data.
    console.error(`[api] ${c.req.method} ${c.req.path} failed: ${err.name}`);
    return fail(c, 500, "server_error", "Something went wrong on our side. Try again.");
  });
  return app;
}
