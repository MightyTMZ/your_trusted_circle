/**
 * GET /api/sessions/:id/timeline — the parts of a session's record the caller
 * may see. Access follows consent (CLAUDE.md) and the participant rules:
 *
 * - Everyone sees everything about themselves: their own check-ins, the
 *   incidents about them (including who acknowledged), and events they sent
 *   or that are about them.
 * - The host, as first responder, also sees every incident in the session and
 *   others' session/incident/alert/connectivity events. Check-ins stay private
 *   to the person (the host only learns of a missed one through its incident).
 * - Location events about someone else are shown only as that person allows:
 *   "group" to everyone, "host" or responder sharing to the host.
 * - Other participants see only session membership events.
 */
import { Hono } from "hono";
import { categoryOf, isEventType, specFor, type TimelineEvent } from "../../timeline/schema/catalog.js";
import { anyParticipant, isHost } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { incidentView } from "../alerts/routes.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { checkInView } from "../safety/routes.js";
import type { ParticipantDoc, SessionDoc, TraceDoc } from "../types.js";

const HOST_VISIBLE = new Set(["session", "incident", "notification", "escalation", "connectivity", "emergency", "voice"]);

export function canSeeEvent(session: SessionDoc, viewer: ParticipantDoc, trace: TraceDoc): boolean {
  if (trace.kind !== "event") return trace.userId === viewer.userId;
  if (trace.userId === viewer.userId || trace.subjectParticipantId === viewer.participantId) return true;
  const event = trace.data as TimelineEvent;
  if (!isEventType(event.type)) return false;
  const subject = session.participants.find((p) => p.participantId === trace.subjectParticipantId);
  const host = isHost(session, viewer.userId);
  if (specFor(event.type).sensitivity === "location") {
    if (!subject) return false;
    if (subject.consent.locationSharing === "group") return true;
    return host && (subject.consent.locationSharing === "host" || subject.consent.shareLocationWithResponders);
  }
  if (specFor(event.type).sensitivity === "profile") return false;
  const category = categoryOf(event.type);
  return host ? HOST_VISIBLE.has(category) : category === "session";
}

export function dataRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  r.get("/sessions/:id/timeline", auth, async (c) => {
    const session = await deps.store.getSession(c.req.param("id"));
    const viewer = session ? anyParticipant(session, c.var.user._id) : undefined;
    if (!session || !viewer) return fail(c, 404, "no_session", "Session not found.");
    const host = isHost(session, viewer.userId);

    const incidents = (await deps.store.listIncidentsForSession(session._id)).filter(
      (i) => host || i.participantId === viewer.participantId,
    );
    const checkIns = (await deps.store.listCheckInsForSession(session._id)).filter((x) => x.participantId === viewer.participantId);
    const events = (await deps.store.listTracesForSession(session._id)).filter((t) => canSeeEvent(session, viewer, t)).slice(-500);

    return c.json({
      sessionId: session._id,
      incidents: await Promise.all(incidents.map(async (i) => incidentView(i, session, await deps.store.listJobsForIncident(i._id)))),
      checkIns: checkIns.map(checkInView),
      events: events.map((t) => ({ id: t._id, kind: t.kind, type: t.type, occurredAt: t.occurredAt, receivedAt: t.receivedAt, data: t.data })),
    });
  });

  return r;
}
