/**
 * Alerts as recipients see them, acknowledgment, and the Incident Card.
 *
 * GET  /api/alerts                    my delivered alerts (my inbox), as delivered
 * POST /api/alerts/:id/viewed         I opened it (not an acknowledgment)
 * POST /api/alerts/:id/acknowledge    I'm responding: stops pending escalation
 * GET  /api/incidents/:id             the incident, at the detail I'm entitled to
 * GET  /api/incidents/:id/card        the Incident Card, built from the timeline
 * POST /api/incidents/:id/repeat      re-send the current step's alert; the deadline does not move
 * POST /api/incidents/:id/resolve     { outcome } after acknowledging; a separate action
 *
 * Who sees what:
 * - the host (first responder for everyone else) and the person the incident
 *   is about see the full incident;
 * - anyone else who was alerted (a backup contact with an account) sees only
 *   what their alerts delivered (CLAUDE.md).
 * Acknowledgment confirms the alert was received; it never means the person is OK.
 */
import { Hono } from "hono";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { isHost } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { buildIncidentCard } from "../data/card.js";
import { nextDeadline } from "../safety/escalation.js";
import { MAX_REPEATS, recipientRef, recorder } from "../timeline/recorder.js";
import type { IncidentDoc, NotificationJobDoc, SessionDoc } from "../types.js";
import { enqueueStep } from "./jobs.js";

export const ACK_CAVEAT = "Acknowledgment confirms the alert was received. It does not confirm the person's wellbeing.";

const resolveSchema = v.object({ outcome: v.enum(["false_alarm", "assistance_reached", "other"] as const) });

type Access = { mode: "full"; asHost: boolean } | { mode: "delivered"; jobs: NotificationJobDoc[] } | null;

export function accessTo(incident: IncidentDoc, session: SessionDoc | null, userId: string, jobs: NotificationJobDoc[]): Access {
  const subject = session?.participants.find((p) => p.participantId === incident.participantId);
  if (session && isHost(session, userId)) return { mode: "full", asHost: true };
  if (subject?.userId === userId) return { mode: "full", asHost: false };
  const mine = jobs.filter((j) => j.recipient.kind === "user" && j.recipient.userId === userId && j.status === "delivered");
  return mine.length > 0 ? { mode: "delivered", jobs: mine } : null;
}

const ackView = (i: IncidentDoc) => (i.acknowledged ? { by: i.acknowledged.name, at: i.acknowledged.at, note: ACK_CAVEAT } : null);
const resolvedView = (i: IncidentDoc) => (i.resolved ? { by: i.resolved.name, at: i.resolved.at, outcome: i.resolved.outcome, bySubject: i.resolved.bySubject === true } : null);

export function incidentView(incident: IncidentDoc, session: SessionDoc | null, jobs: NotificationJobDoc[]) {
  const subject = session?.participants.find((p) => p.participantId === incident.participantId);
  return {
    id: incident._id,
    sessionId: incident.sessionId,
    sessionName: session?.name ?? null,
    participant: { participantId: incident.participantId, displayName: subject?.displayName ?? "Unknown" },
    trigger: incident.trigger,
    openedAt: incident.openedAt,
    status: incident.status,
    nextEscalationAt: nextDeadline(incident),
    acknowledged: ackView(incident),
    resolved: resolvedView(incident),
    steps: incident.steps.map((s) => ({
      level: s.level,
      recipients: s.recipients.map((r) => r.name),
      notifiedAt: s.notifiedAt,
      dueAt: s.dueAt,
      repeats: s.repeats,
    })),
    deliveries: jobs.map((j) => ({
      recipient: j.recipient.name,
      level: j.level,
      repeat: j.repeat,
      status: j.status,
      attempts: j.attempts,
      deliveredAt: j.deliveredAt,
      viewedAt: j.viewedAt,
      simulated: j.recipient.kind !== "user",
    })),
    log: incident.log,
  };
}

/** What a recipient who is not the host may see: their own alerts, as delivered, and the response status. */
export function deliveredView(incident: IncidentDoc, mine: NotificationJobDoc[]) {
  return {
    id: incident._id,
    status: incident.status,
    acknowledged: ackView(incident),
    resolved: resolvedView(incident),
    alerts: mine.map((j) => ({ id: j._id, deliveredAt: j.deliveredAt, viewedAt: j.viewedAt, repeat: j.repeat, ...j.payload })),
  };
}

export function alertRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);
  const rec = recorder(deps);

  async function load(id: string) {
    const incident = await deps.store.getIncident(id);
    if (!incident) return null;
    const session = await deps.store.getSession(incident.sessionId);
    const jobs = await deps.store.listJobsForIncident(incident._id);
    return { incident, session, jobs };
  }

  async function myDeliveredJob(id: string, userId: string) {
    const job = await deps.store.getJob(id);
    return job && job.recipient.kind === "user" && job.recipient.userId === userId && job.status === "delivered" ? job : null;
  }

  r.get("/alerts", auth, async (c) => {
    const jobs = (await deps.store.listJobsForUser(c.var.user._id)).filter((j) => j.status === "delivered");
    const alerts = [];
    for (const job of jobs) {
      const incident = await deps.store.getIncident(job.incidentId);
      if (!incident) continue;
      alerts.push({
        id: job._id,
        incidentId: incident._id,
        ...job.payload,
        repeat: job.repeat,
        deliveredAt: job.deliveredAt,
        viewedAt: job.viewedAt,
        incidentStatus: incident.status,
        acknowledgedBy: incident.acknowledged?.name ?? null,
        nextEscalationAt: nextDeadline(incident),
      });
    }
    return c.json({ alerts });
  });

  r.post("/alerts/:id/viewed", auth, async (c) => {
    const job = await myDeliveredJob(c.req.param("id"), c.var.user._id);
    if (!job) return fail(c, 404, "no_alert", "Alert not found.");
    if (await deps.store.markJobViewed(job._id, deps.now())) {
      const session = await deps.store.getSession(job.sessionId);
      if (session) await rec.notificationViewed(session, job);
    }
    return c.body(null, 204);
  });

  r.post("/alerts/:id/acknowledge", auth, async (c) => {
    const job = await myDeliveredJob(c.req.param("id"), c.var.user._id);
    const user = c.var.user;
    if (!job) return fail(c, 404, "no_alert", "Alert not found.");
    const now = deps.now();
    const before = await deps.store.getIncident(job.incidentId);
    const won = await deps.store.acknowledgeIncident(job.incidentId, { byUserId: user._id, name: user.displayName, at: now });
    const incident = (await deps.store.getIncident(job.incidentId))!;
    if (!won) {
      if (incident.status === "acknowledged") {
        return fail(c, 409, "already_acknowledged", `${incident.acknowledged?.name ?? "Someone"} is already responding.`);
      }
      return fail(c, 409, "incident_closed", "This alert has been resolved.");
    }
    await deps.store.markIncidentJobsAcknowledged(job.incidentId, now);
    const session = await deps.store.getSession(job.sessionId);
    const subject = session?.participants.find((p) => p.participantId === incident.participantId);
    if (session && before) {
      await rec.acknowledged(session, incident, job);
      // The step that was waiting on this acknowledgment will not fire.
      const pending = before.steps.findIndex((s, i) => i > before.currentStep && s.dueAt !== null);
      if (pending >= 0) await rec.stepCancelled(session, incident, pending, "acknowledged");
    }
    await deps.store.appendIncidentLog(job.incidentId, {
      at: now,
      kind: "acknowledgment",
      text: `Acknowledged by ${user.displayName}. Pending escalation stopped. This does not confirm ${subject?.displayName ?? "the person"}'s wellbeing.`,
    });
    const updated = (await deps.store.getIncident(job.incidentId))!;
    const jobs = await deps.store.listJobsForIncident(updated._id);
    const access = accessTo(updated, session, user._id, jobs);
    return c.json({ incident: access?.mode === "full" ? incidentView(updated, session, jobs) : deliveredView(updated, access?.mode === "delivered" ? access.jobs : []) });
  });

  r.get("/incidents/:id", auth, async (c) => {
    const found = await load(c.req.param("id"));
    const access = found ? accessTo(found.incident, found.session, c.var.user._id, found.jobs) : null;
    if (!found || !access) return fail(c, 404, "no_incident", "Incident not found.");
    if (access.mode === "full") return c.json({ incident: incidentView(found.incident, found.session, found.jobs) });
    return c.json({ incident: deliveredView(found.incident, access.jobs) });
  });

  r.get("/incidents/:id/card", auth, async (c) => {
    const found = await load(c.req.param("id"));
    const access = found ? accessTo(found.incident, found.session, c.var.user._id, found.jobs) : null;
    if (!found || !found.session || !access) return fail(c, 404, "no_incident", "Incident not found.");
    const events = await deps.timeline.events(found.session._id);
    const card = buildIncidentCard(
      events,
      found.session,
      found.incident,
      access.mode === "full"
        ? { kind: "full", viewerIsHost: access.asHost }
        : {
            kind: "delivered",
            factEventIds: new Set(access.jobs.flatMap((j) => j.payload.factEventIds)),
            notificationIds: new Set(access.jobs.map((j) => j._id)),
          },
    );
    return c.json({ card, generatedAt: deps.now() });
  });

  /** Only someone responding: the host for anyone else, or a recipient whose alert was delivered. */
  function responderRole(incident: IncidentDoc, session: SessionDoc | null, userId: string, jobs: NotificationJobDoc[]) {
    const subject = session?.participants.find((p) => p.participantId === incident.participantId);
    if (session && isHost(session, userId) && subject?.userId !== userId) return { role: "host" as const, session };
    const mine = jobs.find((j) => j.recipient.kind === "user" && j.recipient.userId === userId && j.status === "delivered");
    if (session && mine) return { role: recipientRef(session, mine.recipient).role === "host" ? ("host" as const) : ("backup_contact" as const), session, job: mine };
    return null;
  }

  r.post("/incidents/:id/repeat", auth, async (c) => {
    const found = await load(c.req.param("id"));
    if (!found) return fail(c, 404, "no_incident", "Incident not found.");
    const who = responderRole(found.incident, found.session, c.var.user._id, found.jobs);
    if (!who) return fail(c, 403, "responders_only", "Only someone responding to this alert can repeat it.");
    const { incident } = found;
    if (incident.status !== "open") return fail(c, 409, "not_open", "This alert is no longer waiting for a response.");
    const index = incident.currentStep;
    const step = incident.steps[index];
    if (!step || step.level === "emergency_simulated") return fail(c, 409, "nothing_to_repeat", "There is no alert to repeat at this step.");
    if (step.repeats >= MAX_REPEATS) return fail(c, 409, "repeat_limit", `This alert has already been repeated ${MAX_REPEATS} times.`);
    if (!(await deps.store.claimRepeat(incident._id, index, step.repeats))) return fail(c, 409, "repeat_conflict", "Someone just repeated this alert.");

    const now = deps.now();
    const jobs = await enqueueStep(deps, who.session, incident, index, now, step.repeats + 1);
    for (const job of jobs) await rec.notificationSent(who.session, incident, job);
    await deps.store.appendIncidentLog(incident._id, {
      at: now,
      kind: "notification",
      text: `Alert repeated to ${step.recipients.map((x) => x.name).join(", ")}. The escalation deadline is unchanged.`,
    });
    const updated = (await deps.store.getIncident(incident._id))!;
    return c.json({ repeated: jobs.length, nextEscalationAt: nextDeadline(updated) }, 202);
  });

  r.post("/incidents/:id/resolve", auth, async (c) => {
    const found = await load(c.req.param("id"));
    if (!found) return fail(c, 404, "no_incident", "Incident not found.");
    const user = c.var.user;
    const who = responderRole(found.incident, found.session, user._id, found.jobs);
    if (!who) return fail(c, 403, "responders_only", "Only someone responding to this alert can resolve it.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(resolveSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Pick an outcome.", issues);
    const now = deps.now();
    const { outcome } = body as Infer<typeof resolveSchema>;
    const { incident } = found;
    if (!(await deps.store.resolveIncident(incident._id, { byUserId: user._id, name: user.displayName, at: now, outcome }))) {
      return incident.status === "open"
        ? fail(c, 409, "acknowledge_first", "Acknowledge the alert first.")
        : fail(c, 409, "incident_closed", "Already resolved.");
    }
    const byId =
      who.role === "host"
        ? (who.session.participants.find((p) => p.userId === user._id)?.participantId ?? user._id)
        : recipientRef(who.session, who.job!.recipient).id;
    await rec.resolved(who.session, incident, { role: who.role, id: byId }, outcome);
    const label = outcome === "false_alarm" ? "False alarm" : outcome === "assistance_reached" ? "Someone reached them in person" : "Other";
    await deps.store.appendIncidentLog(incident._id, { at: now, kind: "resolution", text: `Resolved by ${user.displayName}: ${label}.` });
    const updated = (await deps.store.getIncident(incident._id))!;
    const jobs = await deps.store.listJobsForIncident(updated._id);
    const access = accessTo(updated, found.session, user._id, jobs);
    return c.json({ incident: access?.mode === "full" ? incidentView(updated, found.session, jobs) : deliveredView(updated, access?.mode === "delivered" ? access.jobs : []) });
  });

  return r;
}
