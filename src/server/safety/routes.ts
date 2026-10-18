/**
 * Safety state and deadlines. Every route acts only on the caller's own
 * check-ins and device; nobody can answer, cancel or trigger them for someone else.
 *
 * POST /api/sessions/:id/checkins     my device observed a movement change: start a private check-in
 * POST /api/checkins/:id/respond      { response: "ok" | "help" }; "ok" cancels the deadline
 * POST /api/sessions/:id/help         ask for help now (the client confirms first)
 * POST /api/sessions/:id/heartbeat    my device is alive
 * POST /api/sessions/:id/update       add "I'm OK" to my open alert; never acknowledges or resolves it
 * POST /api/sessions/:id/cancel-alert cancel my own open alert as a false alarm (my own report)
 */
import { Hono } from "hono";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { activeParticipant, isLive } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newId } from "../ids.js";
import { recorder } from "../timeline/recorder.js";
import type { CheckInDoc, ParticipantDoc, SessionDoc } from "../types.js";
import { incidentView } from "../alerts/routes.js";
import { openIncident } from "./escalation.js";

const checkInSchema = v.object({
  reason: v.enum(["movement_changed", "manual"] as const),
  observationEventId: v.optional(v.id("evt")),
});
const respondSchema = v.object({ response: v.enum(["ok", "help"] as const) });

export function checkInView(c: CheckInDoc) {
  return {
    id: c._id,
    sessionId: c.sessionId,
    reason: c.reason,
    promptedAt: c.promptedAt,
    dueAt: c.dueAt,
    status: c.status,
    respondedAt: c.respondedAt,
    incidentId: c.incidentId,
  };
}

/**
 * "I need help" without a pending check-in. The catalog needs an earlier event
 * as the incident's trigger, so the tap is recorded as what it is: a manual
 * check-in, answered with "requested help" at once.
 */
export async function requestHelpNow(deps: Deps, session: SessionDoc, me: ParticipantDoc, at: Date) {
  const existing = await deps.store.findActiveIncident(session._id, me.participantId);
  if (existing) return existing;
  const rec = recorder(deps);
  const checkIn: CheckInDoc = {
    _id: newId("chk"),
    sessionId: session._id,
    participantId: me.participantId,
    reason: "manual",
    observationEventId: null,
    promptedAt: at,
    dueAt: at,
    status: "requested_help",
    respondedAt: at,
    cancelledReason: null,
    incidentId: null,
  };
  await deps.store.insertCheckIn(checkIn);
  await rec.checkInPrompted(session, checkIn);
  const responded = await rec.checkInResponded(session, me, checkIn, "requested_help", at);
  const incident = await openIncident(deps, session, me, "help_requested", at, checkIn._id, responded?.event_id ?? null);
  await deps.store.transitionCheckIn(checkIn._id, "requested_help", { incidentId: incident._id });
  return incident;
}

export function safetyRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);
  const rec = recorder(deps);

  async function mine(sessionId: string, userId: string) {
    const session = await deps.store.getSession(sessionId);
    const me = session ? activeParticipant(session, userId) : undefined;
    return session && me ? { session, me } : null;
  }

  r.post("/sessions/:id/checkins", auth, async (c) => {
    const found = await mine(c.req.param("id"), c.var.user._id);
    if (!found) return fail(c, 404, "no_session", "You are not in this session.");
    const { session, me } = found;
    const now = deps.now();
    if (!isLive(session, now)) return fail(c, 409, "session_over", "This session has ended.");
    if (session.suspendedAt) return fail(c, 409, "session_suspended", "The host has paused check-ins for this session.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(checkInSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the check-in request.", issues);
    const input = body as Infer<typeof checkInSchema>;
    if (input.reason === "movement_changed" && !me.consent.monitoring) {
      return fail(c, 409, "monitoring_off", "Movement check-ins are off for you in this session.");
    }
    if (await deps.store.findActiveIncident(session._id, me.participantId)) {
      return fail(c, 409, "incident_open", "An alert about you is already open.");
    }
    const pending = await deps.store.findPendingCheckIn(session._id, me.participantId);
    if (pending) return c.json({ checkIn: checkInView(pending) });

    const checkIn: CheckInDoc = {
      _id: newId("chk"),
      sessionId: session._id,
      participantId: me.participantId,
      reason: input.reason,
      observationEventId: input.observationEventId ?? null,
      promptedAt: now,
      dueAt: new Date(now.getTime() + session.rules.checkInWindowSec * 1000),
      status: "pending",
      respondedAt: null,
      cancelledReason: null,
      incidentId: null,
    };
    await deps.store.insertCheckIn(checkIn);
    await rec.checkInPrompted(session, checkIn);
    return c.json({ checkIn: checkInView(checkIn) }, 201);
  });

  r.post("/checkins/:id/respond", auth, async (c) => {
    const checkIn = await deps.store.getCheckIn(c.req.param("id"));
    const found = checkIn ? await mine(checkIn.sessionId, c.var.user._id) : null;
    if (!checkIn || !found || found.me.participantId !== checkIn.participantId) {
      return fail(c, 404, "no_checkin", "Check-in not found.");
    }
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(respondSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", 'Answer "ok" or "help".', issues);
    const now = deps.now();
    const { response } = body as Infer<typeof respondSchema>;

    if (response === "ok") {
      if (!(await deps.store.transitionCheckIn(checkIn._id, "pending", { status: "responded_ok", respondedAt: now }))) {
        return fail(c, 409, "checkin_closed", "This check-in has already closed. If an alert was sent, your host can see it.");
      }
      await rec.checkInResponded(found.session, found.me, checkIn, "confirmed_ok", now);
      return c.json({ checkIn: checkInView((await deps.store.getCheckIn(checkIn._id))!) });
    }

    if (!(await deps.store.transitionCheckIn(checkIn._id, "pending", { status: "requested_help", respondedAt: now }))) {
      // Too late to answer, but asking for help is never refused.
      const incident = await requestHelpNow(deps, found.session, found.me, now);
      return c.json({ checkIn: checkInView((await deps.store.getCheckIn(checkIn._id))!), incidentId: incident._id });
    }
    const responded = await rec.checkInResponded(found.session, found.me, checkIn, "requested_help", now);
    const incident = await openIncident(deps, found.session, found.me, "help_requested", now, checkIn._id, responded?.event_id ?? null);
    await deps.store.transitionCheckIn(checkIn._id, "requested_help", { incidentId: incident._id });
    return c.json({ checkIn: checkInView((await deps.store.getCheckIn(checkIn._id))!), incidentId: incident._id });
  });

  r.post("/sessions/:id/help", auth, async (c) => {
    const found = await mine(c.req.param("id"), c.var.user._id);
    if (!found) return fail(c, 404, "no_session", "You are not in this session.");
    const incident = await requestHelpNow(deps, found.session, found.me, deps.now());
    return c.json({ incidentId: incident._id, status: incident.status }, 201);
  });

  r.post("/sessions/:id/heartbeat", auth, async (c) => {
    const found = await mine(c.req.param("id"), c.var.user._id);
    if (!found) return fail(c, 404, "no_session", "You are not in this session.");
    const now = deps.now();
    const { session, me } = found;
    await deps.store.updateParticipant(session._id, me.participantId, { lastHeartbeatAt: now, deviceOnline: true });
    if (!me.deviceOnline) {
      await rec.deviceOnline(session, me, now.getTime() - (me.lastHeartbeatAt?.getTime() ?? now.getTime()));
      const incident = await deps.store.findActiveIncident(session._id, me.participantId);
      if (incident) {
        await deps.store.appendIncidentLog(incident._id, { at: now, kind: "connectivity", text: `${me.displayName}'s device is sending heartbeats again.` });
      }
    }
    return c.body(null, 204);
  });

  r.post("/sessions/:id/update", auth, async (c) => {
    const found = await mine(c.req.param("id"), c.var.user._id);
    if (!found) return fail(c, 404, "no_session", "You are not in this session.");
    const incident = await deps.store.findActiveIncident(found.session._id, found.me.participantId);
    if (!incident) return fail(c, 404, "no_incident", "There is no open alert about you.");
    await deps.store.appendIncidentLog(incident._id, {
      at: deps.now(),
      kind: "participant_update",
      text: `${found.me.displayName} says they are OK. This is added to the record; the alert stays open until a responder resolves it.`,
    });
    return c.body(null, 204);
  });

  // Only the person the alert is about can cancel it, and only their own.
  // Queued deliveries for a closed incident are dropped by the dispatcher.
  r.post("/sessions/:id/cancel-alert", auth, async (c) => {
    const found = await mine(c.req.param("id"), c.var.user._id);
    if (!found) return fail(c, 404, "no_session", "You are not in this session.");
    const incident = await deps.store.findActiveIncident(found.session._id, found.me.participantId);
    if (!incident) return fail(c, 404, "no_incident", "There is no open alert about you to cancel.");
    const now = deps.now();
    const res = { byUserId: c.var.user._id, name: found.me.displayName, at: now, outcome: "false_alarm" as const, bySubject: true };
    if (!(await deps.store.cancelIncidentBySubject(incident._id, res))) {
      return fail(c, 409, "incident_closed", "This alert has already been closed.");
    }
    await deps.store.appendIncidentLog(incident._id, {
      at: now,
      kind: "resolution",
      text: `${found.me.displayName} cancelled the alert from their own device: false alarm. Pending escalation stopped. This is their own report; no one has checked on them in person.`,
    });
    const updated = (await deps.store.getIncident(incident._id))!;
    return c.json({ incident: incidentView(updated, found.session, await deps.store.listJobsForIncident(updated._id)) });
  });

  return r;
}
