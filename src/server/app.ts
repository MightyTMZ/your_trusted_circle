/**
 * YTC backend API (docs/YTC Grand Architecture.png, box 2), in five parts:
 *
 * 1. Authentication and session authorization   auth/        who you are; participant rules (authz.ts); rate limits
 * 2. Session lifecycle and event validation      lifecycle/   create, join, suspend, end; accept only catalogued events; live location relay
 * 3. Safety state and deadlines                  safety/      check-ins, heartbeats, cancellation, escalation
 * 4. Alert orchestration                         alerts/      notification jobs, results, retries, repeats, acknowledgment
 * 5. Data access and retention                   data/        permitted timelines, Incident Card, expiry, export, deletion
 * 6. Simulated voice-agent escalation            voice/       the agent's call to the mock operator (src/agent)
 *    Live incident demo (presenter tool)         demo/        synthetic sensor input that runs 3, 4 and 6 for real
 *
 * Plus: timeline/ (the server's hash-chained record of each session),
 * contacts/ (backup contacts with accounts) and voice/service.ts (token-
 * authenticated endpoints for an external voice-agent service).
 *
 * Security defaults: cookie sign-in (httpOnly, SameSite=Lax), Origin check on
 * every state-changing browser request (except Apple's cross-site sign-in
 * callback, protected by its OAuth state, and service endpoints, which use a
 * bearer token instead of cookies), JSON-only bodies, rate limits, no IP logging.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { alertRoutes } from "./alerts/routes.js";
import { RateLimiter, rateLimit } from "./auth/ratelimit.js";
import { authRoutes } from "./auth/routes.js";
import { contactRoutes } from "./contacts/routes.js";
import { fail, type AppEnv, type Deps } from "./context.js";
import { accountRoutes } from "./data/account.js";
import { demoRoutes } from "./demo/routes.js";
import { storyRoutes } from "./data/story.js";
import { runRetention } from "./data/retention.js";
import { dataRoutes } from "./data/timeline.js";
import { ingestRoutes } from "./lifecycle/events.js";
import { relayRoutes } from "./lifecycle/relay.js";
import { sessionRoutes } from "./lifecycle/sessions.js";
import { safetyRoutes } from "./safety/routes.js";
import { runSchedulerPass } from "./safety/scheduler.js";
import { voiceRoutes } from "./voice/routes.js";
import { voiceServiceRoutes } from "./voice/service.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MIN = 60_000;

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { config } = deps;
  const allowedOrigins = new Set([config.appOrigin, config.apiOrigin]);
  const limiter = new RateLimiter(deps.now);
  const limit = (name: string, n: number, windowMs: number) => rateLimit(limiter, name, n, windowMs, config.trustProxy);
  // Test sign-in: localhost and 127.0.0.1 keep separate cookies, so each acts as its own phone.
  if (deps.config.testSignIn) {
    for (const o of [deps.config.appOrigin, deps.config.apiOrigin]) {
      const u = new URL(o);
      for (const host of ["localhost", "127.0.0.1"]) allowedOrigins.add(`${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`);
    }
  }

  app.use("*", secureHeaders());
  app.use("/api/*", cors({ origin: config.appOrigin, credentials: true, allowMethods: ["GET", "POST", "PATCH", "DELETE"] }));

  // CSRF: browsers always send Origin on cross-site POST/PATCH/DELETE.
  app.use("/api/*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.method === "POST" && /^\/api\/auth\/[a-z]+\/callback$/.test(c.req.path)) return next();
    if (c.req.path.startsWith("/api/service/")) return next();
    const origin = c.req.header("Origin");
    if (!origin || !allowedOrigins.has(origin)) return fail(c, 403, "bad_origin", "Request blocked: unexpected origin.");
    const type = c.req.header("Content-Type") ?? "";
    if (c.req.raw.body !== null && !type.startsWith("application/json")) return fail(c, 415, "json_only", "Send JSON.");
    return next();
  });

  // Rate limits. Tight where guessing or flooding would hurt; generous elsewhere.
  app.use("/api/auth/:provider/start", limit("signin", 20, 10 * MIN));
  app.use("/api/sessions/join", limit("join", 30, 10 * MIN));
  app.use("/api/sessions/join/*", limit("join", 30, 10 * MIN));
  app.use("/api/contact-invites/*", limit("invite", 30, 10 * MIN));
  app.use("/api/ingest", limit("ingest", 120, MIN));
  app.use("/api/sessions/:id/location", limit("location", 30, MIN));
  app.use("/api/*", limit("api", 600, MIN));

  // Serverless hosts have no long-running scheduler: optionally run a pass before requests (at most once a second).
  let lastTick = 0;
  let ticking: Promise<unknown> | null = null;
  if (config.tickOnRequest) {
    app.use("/api/*", async (_c, next) => {
      const now = deps.now().getTime();
      if (!ticking && now - lastTick >= 1000) {
        lastTick = now;
        ticking = runSchedulerPass(deps).catch((err) => console.error(`[scheduler] pass failed: ${(err as Error).name}`)).finally(() => (ticking = null));
        await ticking;
      }
      await next();
    });
  }

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Scheduler tick for hosts without a long-running process (Vercel Cron sends CRON_SECRET as a bearer token).
  let lastRetention = 0;
  app.get("/api/internal/tick", async (c) => {
    if (!config.cronSecret || c.req.header("Authorization") !== `Bearer ${config.cronSecret}`) {
      return fail(c, 401, "unauthorized", "Not allowed.");
    }
    const pass = await runSchedulerPass(deps);
    let retention = null;
    if (config.retentionInApi && deps.now().getTime() - lastRetention >= 60 * MIN) {
      lastRetention = deps.now().getTime();
      retention = await runRetention(deps);
    }
    return c.json({ pass, retention });
  });

  // 1. Authentication and session authorization
  app.route("/api/auth", authRoutes(deps));
  // 2. Session lifecycle and event validation
  app.route("/api/sessions", sessionRoutes(deps));
  app.route("/api/ingest", ingestRoutes(deps));
  app.route("/api", relayRoutes(deps));
  app.route("/api", contactRoutes(deps));
  // 3. Safety state and deadlines
  app.route("/api", safetyRoutes(deps));
  // 4. Alert orchestration
  app.route("/api", alertRoutes(deps));
  app.route("/api/service", voiceServiceRoutes(deps));
  // 5. Data access and retention
  app.route("/api", dataRoutes(deps));
  app.route("/api", storyRoutes(deps));
  app.route("/api/me", accountRoutes(deps));
  // 6. Simulated voice-agent escalation
  if (deps.calls) app.route("/api/calls", voiceRoutes(deps.calls, deps));
  if (deps.demos) app.route("/api", demoRoutes(deps, deps.demos));

  // Serve Vite build output for non-API routes (production only).
  // root is relative to the working directory (repo root); Vite outputs to dist/.
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) return next();
    const res = await serveStatic({ root: "dist" })(c, async () => {});
    if (c.res.status !== 404) return res;
    // SPA fallback: serve index.html for client-side routes.
    return serveStatic({ root: "dist", path: "index.html" })(c, next);
  });

  app.notFound((c) => fail(c, 404, "not_found", "No such endpoint."));
  app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path} failed: ${err.name}: ${err.message}`);
    return fail(c, 500, "server_error", "Something went wrong on our side. Try again.");
  });
  return app;
}
