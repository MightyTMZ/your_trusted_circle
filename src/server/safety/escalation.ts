/**
 * Escalation rules, matching the client (src/domain/incident.ts) and CLAUDE.md:
 *
 * 1. The host is alerted first, for every participant except themselves.
 * 2. Then every other active group participant and that person's backup
 *    contacts in parallel.
 * 3. Then emergency services, always simulated, which also triggers the voice agent.
 *
 * Each step's deadline is set when the previous step is notified, never when
 * an alert is delivered or repeated, so a failed or repeated delivery cannot
 * push escalation back. Acknowledgment stops pending steps; it never confirms
 * the person's wellbeing. Resolution is a separate action.
 *
 * Every step is also recorded on the session timeline (timeline/recorder.ts).
 */
import { enqueueStep } from "../alerts/jobs.js";
import type { Deps } from "../context.js";
import { newId } from "../ids.js";
import { recorder } from "../timeline/recorder.js";
import type { EscalationLevel, EscalationStep, IncidentDoc, IncidentLogEntry, ParticipantDoc, SessionDoc, SessionRules } from "../types.js";

export const EMERGENCY_SIM_NAME = "Emergency services (simulated)";

const stepOf = (level: EscalationLevel, recipients: EscalationStep["recipients"]): EscalationStep => ({
  escalationId: newId("esc"),
  level,
  recipients,
  dueAt: null,
  notifiedAt: null,
  repeats: 0,
});

export function buildSteps(session: SessionDoc, subject: ParticipantDoc): EscalationStep[] {
  const steps: EscalationStep[] = [];
  const host = session.participants.find((p) => p.role === "host");
  if (host && subject.role !== "host") steps.push(stepOf("host", [{ kind: "user", userId: host.userId, name: host.displayName }]));
  const group = session.participants
    .filter((p) => p.leftAt === null && p.participantId !== subject.participantId && p.role !== "host")
    .map((p) => ({ kind: "user" as const, userId: p.userId, name: p.displayName }));
  const backups = subject.backupContacts.map((c) =>
    c.userId ? { kind: "user" as const, userId: c.userId, name: c.name } : { kind: "backup_contact" as const, contactId: c.id, name: c.name },
  );
  if (group.length > 0 || backups.length > 0) {
    steps.push(
      stepOf(
        "group",
        [...group, ...backups],
      ),
    );
  }
  steps.push(stepOf("emergency_simulated", [{ kind: "emergency_simulated", name: EMERGENCY_SIM_NAME }]));
  return steps;
}

function ackWindowMs(rules: SessionRules, level: EscalationLevel): number {
  return (level === "host" ? rules.hostAckWindowSec : rules.backupAckWindowSec) * 1000;
}

/** Notifies step `index` once: claims it, schedules the next deadline, queues one job per recipient. */
export async function notifyStep(
  deps: Deps,
  session: SessionDoc,
  incident: IncidentDoc,
  index: number,
  at: Date,
  /** Runs once this worker has won the step, before its alerts are recorded (e.g. "step fired"). */
  onClaimed?: () => Promise<unknown>,
): Promise<boolean> {
  const step = incident.steps[index];
  if (!step) return false;
  const hasNext = index + 1 < incident.steps.length;
  const nextDue = hasNext ? new Date(at.getTime() + ackWindowMs(session.rules, step.level)) : null;
  if (!(await deps.store.claimStep(incident._id, index, at, nextDue))) return false;
  await onClaimed?.();

  const rec = recorder(deps);
  const jobs = await enqueueStep(deps, session, incident, index, at, 0);
  let basisEventId: string | null = null;
  for (const job of jobs) {
    const sent = await rec.notificationSent(session, incident, job);
    basisEventId ??= sent?.event_id ?? null;
  }
  if (step.level === "emergency_simulated") {
    const dispatch = await rec.emergencyDispatch(session, incident, index, jobs[0]?.payload.factEventIds ?? []);
    basisEventId ??= dispatch?.event_id ?? null;
  }
  if (nextDue && basisEventId) await rec.stepScheduled(session, incident, index + 1, nextDue, basisEventId);

  const names = step.recipients.map((r) => r.name).join(", ");
  await deps.store.appendIncidentLog(
    incident._id,
    step.level === "emergency_simulated"
      ? { at, kind: "escalation", text: "Escalated to simulated emergency services. No real call or message was placed.", simulated: true }
      : { at, kind: "notification", text: `Alert sent to ${names} (${step.level === "host" ? "session host" : step.level === "group" ? "group and backup contacts" : "backup contacts"}).` },
  );
  return true;
}

/**
 * Opens an incident for the person and alerts the first step. If they already
 * have an active incident, returns it instead: one person, one active incident.
 * `triggerEventId` is the timeline event that caused it (a missed or answered check-in).
 */
export async function openIncident(
  deps: Deps,
  session: SessionDoc,
  subject: ParticipantDoc,
  trigger: IncidentDoc["trigger"],
  at: Date,
  checkInId: string | null,
  triggerEventId: string | null,
): Promise<IncidentDoc> {
  const existing = await deps.store.findActiveIncident(session._id, subject.participantId);
  if (existing) return existing;

  const log: IncidentLogEntry[] = [];
  if (trigger === "checkin_missed") log.push({ at, kind: "checkin", text: "No response to the private check-in within the window." });
  if (trigger === "help_requested") log.push({ at, kind: "checkin", text: `${subject.displayName} asked for help.` });
  if (!subject.deviceOnline) {
    log.push({ at, kind: "connectivity", text: "The participant's device is not sending heartbeats. Escalation continues regardless." });
  }

  const incident: IncidentDoc = {
    _id: newId("inc"),
    sessionId: session._id,
    participantId: subject.participantId,
    trigger,
    checkInId,
    triggerEventId,
    openedEventId: null,
    openedAt: at,
    status: "open",
    activeKey: `${session._id}:${subject.participantId}`,
    steps: buildSteps(session, subject),
    currentStep: -1,
    acknowledged: null,
    resolved: null,
    log,
  };
  if (!(await deps.store.insertIncident(incident))) {
    return (await deps.store.findActiveIncident(session._id, subject.participantId))!;
  }
  if (triggerEventId) {
    const opened = await recorder(deps).incidentOpened(session, incident, triggerEventId);
    if (opened) {
      incident.openedEventId = opened.event_id;
      await deps.store.updateIncident(incident._id, { openedEventId: opened.event_id });
    }
  }
  await notifyStep(deps, session, incident, 0, at);
  return (await deps.store.getIncident(incident._id))!;
}

export function nextDeadline(incident: IncidentDoc): Date | null {
  if (incident.status !== "open") return null;
  return incident.steps[incident.currentStep + 1]?.dueAt ?? null;
}
