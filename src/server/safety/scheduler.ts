/**
 * The server's clock-driven work, run every second by main.ts and directly by
 * tests. Deadlines live in the database, not in timers, so a restart, a
 * closed phone or a lost connection never cancels one. Every pass is
 * idempotent: running it twice at the same time changes nothing.
 */
import { dispatchDue, type DispatchSummary } from "../alerts/jobs.js";
import type { Deps } from "../context.js";
import { recorder } from "../timeline/recorder.js";
import { nextDeadline, notifyStep, openIncident } from "./escalation.js";

export interface PassSummary {
  sessionsExpired: number;
  devicesWentSilent: number;
  checkInsMissed: number;
  stepsEscalated: number;
  alerts: DispatchSummary;
}

export async function runSchedulerPass(deps: Deps): Promise<PassSummary> {
  const { store } = deps;
  const now = deps.now();
  const summary: PassSummary = { sessionsExpired: 0, devicesWentSilent: 0, checkInsMissed: 0, stepsEscalated: 0, alerts: { delivered: 0, retrying: 0, failed: 0, cancelled: 0 } };
  const rec = recorder(deps);

  // 1. Session expiry and missed heartbeats.
  for (const session of await store.listActiveSessions()) {
    if (session.expiresAt.getTime() <= now.getTime()) {
      if (await store.endSession(session._id, "expired", session.expiresAt)) {
        summary.sessionsExpired++;
        deps.relay.clearSession(session._id);
        await rec.expired(session);
        // Pending check-ins end with the session; open incidents keep escalating.
        for (const c of await store.listPendingCheckIns(session._id)) {
          await store.transitionCheckIn(c._id, "pending", { status: "cancelled", cancelledReason: "session_ended" });
        }
      }
      continue;
    }
    // While the host has the session suspended, silent devices are expected.
    if (session.suspendedAt !== null) continue;
    const timeoutMs = session.rules.heartbeatTimeoutSec * 1000;
    for (const p of session.participants) {
      if (p.leftAt !== null || !p.deviceOnline || p.lastHeartbeatAt === null) continue;
      if (now.getTime() - p.lastHeartbeatAt.getTime() < timeoutMs) continue;
      await store.updateParticipant(session._id, p.participantId, { deviceOnline: false });
      summary.devicesWentSilent++;
      await rec.deviceOffline(session, p, p.lastHeartbeatAt);
      const incident = await store.findActiveIncident(session._id, p.participantId);
      if (incident) {
        await store.appendIncidentLog(incident._id, {
          at: now,
          kind: "connectivity",
          text: `${p.displayName}'s device stopped sending heartbeats (last at ${p.lastHeartbeatAt.toISOString()}). Escalation continues regardless.`,
        });
      }
    }
  }

  // 2. Missed check-ins open an incident, dated at the deadline.
  for (const checkIn of await store.listDueCheckIns(now)) {
    if (!(await store.transitionCheckIn(checkIn._id, "pending", { status: "missed" }))) continue;
    summary.checkInsMissed++;
    const session = await store.getSession(checkIn.sessionId);
    const subject = session?.participants.find((p) => p.participantId === checkIn.participantId);
    if (!session || !subject) continue;
    const missed = await rec.checkInMissed(session, checkIn);
    const incident = await openIncident(deps, session, subject, "checkin_missed", checkIn.dueAt, checkIn._id, missed?.event_id ?? null);
    await store.transitionCheckIn(checkIn._id, "missed", { incidentId: incident._id });
  }

  // 3. Escalate unacknowledged incidents, one step per elapsed deadline.
  for (const open of await store.listOpenIncidents()) {
    const session = await store.getSession(open.sessionId);
    if (!session) continue;
    let incident = open;
    for (;;) {
      const due = nextDeadline(incident);
      if (!due || due.getTime() > now.getTime()) break;
      const index = incident.currentStep + 1;
      const prev = incident.steps[incident.currentStep];
      const waited = Math.round((due.getTime() - (prev?.notifiedAt?.getTime() ?? due.getTime())) / 1000);
      const firing = incident;
      if (!(await notifyStep(deps, session, incident, index, due, () => rec.stepFired(session, firing, index, due, now)))) break;
      await store.appendIncidentLog(incident._id, {
        at: due,
        kind: "escalation",
        text: `No acknowledgment ${waited}s after the last alert. Escalated to the next step.`,
      });
      summary.stepsEscalated++;
      const reloaded = await store.getIncident(incident._id);
      if (!reloaded) break;
      incident = reloaded;
    }
  }

  // 4. Send whatever alerts are due, including the ones just queued.
  summary.alerts = await dispatchDue(deps);

  // 5. Forget live positions past their keep time (memory only; nothing to delete on disk).
  deps.relay.sweep(now);
  return summary;
}
