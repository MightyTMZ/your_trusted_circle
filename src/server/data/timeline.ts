/**
 * GET /api/sessions/:id/timeline — the parts of a session's record the caller
 * may see, from the server's hash-chained timeline. Access follows consent
 * (CLAUDE.md) and the participant rules:
 *
 * - Everyone sees everything about themselves: their own check-ins, the
 *   incidents about them (including who acknowledged), and events by or about them.
 * - The host, as first responder, also sees every incident in the session and
 *   others' session/incident/alert/escalation/connectivity events. Check-ins
 *   stay private to the person (the host learns of a missed one through its
 *   incident) and so do motion details.
 * - Location events about someone else are shown only as that person allows:
 *   "group" to everyone, "host" or responder sharing to the host.
 * - Other participants see only session membership events.
 */
import { Hono } from "hono";
import { categoryOf, isEventType, specFor, type TimelineEvent } from "../../timeline/schema/catalog.js";
import { incidentView } from "../alerts/routes.js";
import { anyParticipant, isHost } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { checkInView } from "../safety/routes.js";
import type { ParticipantDoc, SessionDoc } from "../types.js";

const HOST_VISIBLE = new Set(["session", "incident", "notification", "escalation", "connectivity", "emergency", "voice"]);

export function canSeeEvent(session: SessionDoc, viewer: ParticipantDoc, e: TimelineEvent): boolean {
  if (!isEventType(e.type)) return false;
  const aboutMe = e.participant_id === viewer.participantId || e.actor.id === viewer.participantId;
  if (aboutMe) return true;
  const subject = session.participants.find((p) => p.participantId === e.participant_id);
  const host = isHost(session, viewer.userId);
  const sensitivity = specFor(e.type).sensitivity;
  if (sensitivity === "location") {
    if (!subject) return false;
    if (subject.consent.locationSharing === "group") return true;
    return host && (subject.consent.locationSharing === "host" || subject.consent.shareLocationWithResponders);
  }
  if (sensitivity === "profile") return false;
  const category = categoryOf(e.type);
  if (category === "checkin" || category === "consent" || category === "sensor") return false;
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

    const incidents = (await deps.store.listIncidentsForSession(session._id)).filter((i) => host || i.participantId === viewer.participantId);
    const checkIns = (await deps.store.listCheckInsForSession(session._id)).filter((x) => x.participantId === viewer.participantId);
    const events = (await deps.timeline.events(session._id)).filter((e) => canSeeEvent(session, viewer, e)).slice(-500);

    return c.json({
      sessionId: session._id,
      incidents: await Promise.all(incidents.map(async (i) => incidentView(i, session, await deps.store.listJobsForIncident(i._id)))),
      checkIns: checkIns.map(checkInView),
      events: events.map((e) => ({ id: e.event_id, seq: e.seq, type: e.type, occurredAt: e.occurred_at, summary: e.summary, simulated: e.provenance.simulated })),
    });
  });

  return r;
}
