/**
 * Alert orchestration: one notification job per recipient per escalation
 * step (plus one per repeat), dispatched by the scheduler with retries.
 *
 * - Exactly once: jobs are keyed `${incident}:${step}:${recipient}[:r${n}]`
 *   with a unique index, and a worker must claim a job before sending it.
 * - Each job freezes what it tells its recipient (AlertPayload). That frozen
 *   copy is all a recipient may see (CLAUDE.md).
 * - Failures retry with backoff, then give up. A failed delivery never moves
 *   or cancels the escalation deadline (CLAUDE.md).
 * - Once an incident is acknowledged, unsent jobs are cancelled.
 */
import type { Deps } from "../context.js";
import { newId } from "../ids.js";
import { recorder } from "../timeline/recorder.js";
import type { AlertPayload, IncidentDoc, NotificationJobDoc, Recipient, SessionDoc } from "../types.js";
import type { DeliveryResult } from "./transport.js";

export function recipientKey(r: Recipient): string {
  if (r.kind === "user") return `usr:${r.userId}`;
  if (r.kind === "backup_contact") return `con:${r.contactId}`;
  return "emergency_simulated";
}

export function buildPayload(session: SessionDoc, incident: IncidentDoc): AlertPayload {
  const subject = session.participants.find((p) => p.participantId === incident.participantId);
  const about = subject?.displayName ?? "Someone in your group";
  const what = incident.trigger === "checkin_missed" ? "did not answer a private check-in" : "asked for help";
  return {
    about,
    sessionName: session.name,
    trigger: incident.trigger,
    openedAt: incident.openedAt,
    message: `${about} ${what} (${session.name}, ${incident.openedAt.toISOString()}). Please check on them.`,
    factEventIds: [incident.triggerEventId, incident.openedEventId].filter((x): x is string => x !== null),
  };
}

/** Creates the step's jobs. Safe to call twice: duplicates are refused by dedupeKey. Returns the new jobs. */
export async function enqueueStep(
  deps: Deps,
  session: SessionDoc,
  incident: IncidentDoc,
  index: number,
  at: Date,
  repeat: number,
): Promise<NotificationJobDoc[]> {
  const step = incident.steps[index];
  if (!step) return [];
  const subject = session.participants.find((p) => p.participantId === incident.participantId);
  const payload = buildPayload(session, incident);
  const created: NotificationJobDoc[] = [];
  for (const recipient of step.recipients) {
    const job: NotificationJobDoc = {
      _id: newId("ntf"),
      dedupeKey: `${incident._id}:${index}:${recipientKey(recipient)}${repeat > 0 ? `:r${repeat}` : ""}`,
      incidentId: incident._id,
      sessionId: incident.sessionId,
      stepIndex: index,
      level: step.level,
      repeat,
      recipient,
      payload,
      subjectUserId: subject?.userId ?? "",
      status: "queued",
      attempts: 0,
      nextAttemptAt: at,
      leaseUntil: null,
      results: [],
      createdAt: at,
      deliveredAt: null,
      viewedAt: null,
      acknowledgedAt: null,
    };
    if (await deps.store.insertJobIfAbsent(job)) created.push(job);
  }
  return created;
}

export interface DispatchSummary {
  delivered: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

export async function dispatchDue(deps: Deps): Promise<DispatchSummary> {
  const { store, config } = deps;
  const summary: DispatchSummary = { delivered: 0, retrying: 0, failed: 0, cancelled: 0 };
  const now = deps.now();
  const rec = recorder(deps);
  for (const job of await store.listDueJobs(now, 100)) {
    if (!(await store.claimJob(job._id, now, new Date(now.getTime() + config.alertLeaseMs)))) continue;

    const incident = await store.getIncident(job.incidentId);
    const session = await store.getSession(job.sessionId);
    if (!incident || !session || incident.status !== "open") {
      await store.updateJob(job._id, { status: "cancelled", leaseUntil: null });
      summary.cancelled++;
      continue;
    }

    const attempt = job.attempts + 1;
    let result: DeliveryResult;
    try {
      result = await deps.transport.deliver(job);
    } catch {
      result = { ok: false, reason: "transport_error" };
    }

    if (result.ok) {
      await store.updateJob(job._id, { status: "delivered", attempts: attempt, deliveredAt: now, leaseUntil: null }, { at: now, ok: true });
      await rec.notificationDelivered(session, job);
      await store.appendIncidentLog(incident._id, {
        at: now,
        kind: "delivery",
        text: `Alert delivered to ${job.recipient.name}${result.simulated ? " (simulated)" : ""}.`,
        ...(result.simulated ? { simulated: true } : {}),
      });
      summary.delivered++;
      continue;
    }

    const giveUp = attempt >= config.alertMaxAttempts;
    const delays = config.alertRetryDelaysMs;
    const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 60_000;
    await store.updateJob(
      job._id,
      giveUp
        ? { status: "failed", attempts: attempt, leaseUntil: null }
        : { status: "queued", attempts: attempt, nextAttemptAt: new Date(now.getTime() + delay), leaseUntil: null },
      { at: now, ok: false, reason: result.reason },
    );
    await rec.notificationFailed(session, job, !giveUp);
    await store.appendIncidentLog(incident._id, {
      at: now,
      kind: "delivery",
      text:
        `Delivery to ${job.recipient.name} failed (${result.reason}, attempt ${attempt}). ` +
        `${giveUp ? "No more retries." : `Retrying in ${Math.round(delay / 1000)}s.`} The escalation deadline still applies.`,
    });
    if (giveUp) summary.failed++;
    else summary.retrying++;
  }
  return summary;
}
