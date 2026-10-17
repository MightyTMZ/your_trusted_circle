/**
 * Alert orchestration: one notification job per recipient per escalation
 * step, dispatched by the scheduler with retries.
 *
 * - Exactly once: jobs are keyed `${incident}:${step}:${recipient}` with a
 *   unique index, and a worker must claim a job before sending it.
 * - Failures retry with backoff, then give up. A failed delivery never moves
 *   or cancels the escalation deadline (CLAUDE.md).
 * - Once an incident is acknowledged, unsent jobs are cancelled.
 */
import type { Deps } from "../context.js";
import { newId } from "../ids.js";
import type { IncidentDoc, NotificationJobDoc, Recipient } from "../types.js";
import type { DeliveryResult } from "./transport.js";

export function recipientKey(r: Recipient): string {
  if (r.kind === "user") return `usr:${r.userId}`;
  if (r.kind === "backup_contact") return `con:${r.contactId}`;
  return "emergency_simulated";
}

/** Creates the step's jobs. Safe to call twice: duplicates are refused by dedupeKey. */
export async function enqueueStep(deps: Deps, incident: IncidentDoc, index: number, at: Date, subjectUserId: string): Promise<number> {
  const step = incident.steps[index];
  if (!step) return 0;
  let created = 0;
  for (const recipient of step.recipients) {
    const job: NotificationJobDoc = {
      _id: newId("ntf"),
      dedupeKey: `${incident._id}:${index}:${recipientKey(recipient)}`,
      incidentId: incident._id,
      sessionId: incident.sessionId,
      stepIndex: index,
      level: step.level,
      recipient,
      subjectUserId,
      status: "queued",
      attempts: 0,
      nextAttemptAt: at,
      leaseUntil: null,
      results: [],
      createdAt: at,
      deliveredAt: null,
      acknowledgedAt: null,
    };
    if (await deps.store.insertJobIfAbsent(job)) created++;
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
  for (const job of await store.listDueJobs(now, 100)) {
    if (!(await store.claimJob(job._id, now, new Date(now.getTime() + config.alertLeaseMs)))) continue;

    const incident = await store.getIncident(job.incidentId);
    if (!incident || incident.status !== "open") {
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
