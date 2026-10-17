/**
 * Alerts as the recipient sees them, and acknowledgment.
 *
 * GET  /api/alerts                    my delivered alerts (my inbox)
 * POST /api/alerts/:id/acknowledge    I'm responding: stops pending escalation
 * GET  /api/incidents/:id             the incident, for its subject, the host, or anyone alerted
 * POST /api/incidents/:id/resolve     { outcome } after acknowledging; a separate action
 *
 * Acknowledgment confirms the alert was received and someone is responding.
 * It never means the person is OK (CLAUDE.md), and every view says so.
 */
import { Hono } from "hono";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { isHost } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { nextDeadline } from "../safety/escalation.js";
import type { IncidentDoc, NotificationJobDoc, SessionDoc } from "../types.js";

export const ACK_CAVEAT = "Acknowledgment confirms the alert was received. It does not confirm the person's wellbeing.";

const resolveSchema = v.object({ outcome: v.enum(["false_alarm", "assistance_reached", "other"] as const) });

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
    acknowledged: incident.acknowledged
      ? { by: incident.acknowledged.name, at: incident.acknowledged.at, note: ACK_CAVEAT }
      : null,
    resolved: incident.resolved ? { by: incident.resolved.name, at: incident.resolved.at, outcome: incident.resolved.outcome } : null,
    steps: incident.steps.map((s) => ({
      level: s.level,
      recipients: s.recipients.map((r) => r.name),
      notifiedAt: s.notifiedAt,
      dueAt: s.dueAt,
    })),
    deliveries: jobs.map((j) => ({
      recipient: j.recipient.name,
      level: j.level,
      status: j.status,
      attempts: j.attempts,
      deliveredAt: j.deliveredAt,
      simulated: j.recipient.kind !== "user",
    })),
    log: incident.log,
  };
}

export function alertRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  /** Subject, host, or someone an alert about it was delivered to. */
  async function canSee(incident: IncidentDoc, session: SessionDoc | null, userId: string, jobs: NotificationJobDoc[]) {
    if (session && isHost(session, userId)) return true;
    const subject = session?.participants.find((p) => p.participantId === incident.participantId);
    if (subject?.userId === userId) return true;
    return jobs.some((j) => j.recipient.kind === "user" && j.recipient.userId === userId && j.status === "delivered");
  }

  r.get("/alerts", auth, async (c) => {
    const jobs = (await deps.store.listJobsForUser(c.var.user._id)).filter((j) => j.status === "delivered");
    const alerts = [];
    for (const job of jobs) {
      const incident = await deps.store.getIncident(job.incidentId);
      if (!incident) continue;
      const session = await deps.store.getSession(job.sessionId);
      const subject = session?.participants.find((p) => p.participantId === incident.participantId);
      alerts.push({
        id: job._id,
        incidentId: incident._id,
        sessionName: session?.name ?? null,
        about: subject?.displayName ?? "Unknown",
        trigger: incident.trigger,
        deliveredAt: job.deliveredAt,
        incidentStatus: incident.status,
        acknowledgedBy: incident.acknowledged?.name ?? null,
        nextEscalationAt: nextDeadline(incident),
      });
    }
    return c.json({ alerts });
  });

  r.post("/alerts/:id/acknowledge", auth, async (c) => {
    const job = await deps.store.getJob(c.req.param("id"));
    const user = c.var.user;
    if (!job || job.recipient.kind !== "user" || job.recipient.userId !== user._id || job.status !== "delivered") {
      return fail(c, 404, "no_alert", "Alert not found.");
    }
    const now = deps.now();
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
    await deps.store.appendIncidentLog(job.incidentId, {
      at: now,
      kind: "acknowledgment",
      text: `Acknowledged by ${user.displayName}. Pending escalation stopped. This does not confirm ${subject?.displayName ?? "the person"}'s wellbeing.`,
    });
    const updated = (await deps.store.getIncident(job.incidentId))!;
    return c.json({ incident: incidentView(updated, session, await deps.store.listJobsForIncident(updated._id)) });
  });

  r.get("/incidents/:id", auth, async (c) => {
    const incident = await deps.store.getIncident(c.req.param("id"));
    if (!incident) return fail(c, 404, "no_incident", "Incident not found.");
    const session = await deps.store.getSession(incident.sessionId);
    const jobs = await deps.store.listJobsForIncident(incident._id);
    if (!(await canSee(incident, session, c.var.user._id, jobs))) return fail(c, 404, "no_incident", "Incident not found.");
    return c.json({ incident: incidentView(incident, session, jobs) });
  });

  r.post("/incidents/:id/resolve", auth, async (c) => {
    const incident = await deps.store.getIncident(c.req.param("id"));
    const user = c.var.user;
    if (!incident) return fail(c, 404, "no_incident", "Incident not found.");
    const session = await deps.store.getSession(incident.sessionId);
    const jobs = await deps.store.listJobsForIncident(incident._id);
    const responder =
      (session && isHost(session, user._id) && session.participants.find((p) => p.participantId === incident.participantId)?.userId !== user._id) ||
      jobs.some((j) => j.recipient.kind === "user" && j.recipient.userId === user._id && j.status === "delivered");
    if (!responder) return fail(c, 403, "responders_only", "Only someone responding to this alert can resolve it.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(resolveSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Pick an outcome.", issues);
    const now = deps.now();
    const { outcome } = body as Infer<typeof resolveSchema>;
    if (!(await deps.store.resolveIncident(incident._id, { byUserId: user._id, name: user.displayName, at: now, outcome }))) {
      return fail(c, 409, incident.status === "open" ? "acknowledge_first" : "incident_closed", incident.status === "open" ? "Acknowledge the alert first." : "Already resolved.");
    }
    const label = outcome === "false_alarm" ? "False alarm" : outcome === "assistance_reached" ? "Someone reached them in person" : "Other";
    await deps.store.appendIncidentLog(incident._id, { at: now, kind: "resolution", text: `Resolved by ${user.displayName}: ${label}.` });
    const updated = (await deps.store.getIncident(incident._id))!;
    return c.json({ incident: incidentView(updated, session, await deps.store.listJobsForIncident(updated._id)) });
  });

  return r;
}
