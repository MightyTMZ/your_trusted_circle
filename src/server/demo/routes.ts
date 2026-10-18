/**
 * Live incident demo routes (demo/live-demo.ts). Host only, and mounted only
 * when config.demoIncidents is on. Simulation only: the call it leads to is
 * the in-process mock operator.
 *
 * POST   /api/sessions/:id/demo   { participantId }  start: synthetic history, then an impact ~5 s later
 * GET    /api/sessions/:id/demo                      where the demo is (404 when none has run)
 * DELETE /api/sessions/:id/demo                      stop feeding input; open alerts stay open
 */
import { Hono } from "hono";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { activeParticipant, isHost, isLive } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { DemoError, type DemoRegistry } from "./live-demo.js";

const startSchema = v.object({ participantId: v.id("par") });

export function demoRoutes(deps: Deps, demos: DemoRegistry) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth(deps));

  async function hostOf(sessionId: string, userId: string) {
    const session = await deps.store.getSession(sessionId);
    if (!session || !activeParticipant(session, userId)) return { error: "no_session" as const };
    if (!isHost(session, userId)) return { error: "host_only" as const };
    return { session };
  }

  r.post("/sessions/:id/demo", async (c) => {
    const found = await hostOf(c.req.param("id"), c.var.user._id);
    if (found.error === "no_session") return fail(c, 404, "no_session", "Session not found.");
    if (found.error === "host_only") return fail(c, 403, "host_only", "Only the host can start the demo.");
    const { session } = found;
    if (!isLive(session, deps.now())) return fail(c, 409, "session_over", "This session has ended.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(startSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Pick who the demo is about.", issues);
    try {
      const run = await demos.start(deps, session, (body as Infer<typeof startSchema>).participantId);
      return c.json({ demo: run.view() }, 201);
    } catch (err) {
      if (err instanceof DemoError) return fail(c, err.status, err.code, err.message);
      throw err;
    }
  });

  r.get("/sessions/:id/demo", async (c) => {
    const found = await hostOf(c.req.param("id"), c.var.user._id);
    if (found.error === "no_session") return fail(c, 404, "no_session", "Session not found.");
    if (found.error === "host_only") return fail(c, 403, "host_only", "Only the host can see the demo.");
    const run = demos.get(found.session._id);
    return c.json({ demo: run ? run.view() : null });
  });

  r.delete("/sessions/:id/demo", async (c) => {
    const found = await hostOf(c.req.param("id"), c.var.user._id);
    if (found.error === "no_session") return fail(c, 404, "no_session", "Session not found.");
    if (found.error === "host_only") return fail(c, 403, "host_only", "Only the host can stop the demo.");
    const run = await demos.stop(deps, found.session._id, "Stopped by the host.");
    return c.json({ demo: run ? run.view() : null });
  });

  return r;
}
