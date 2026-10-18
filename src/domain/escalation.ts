import { MAX_LOCATION_HISTORY } from './config';
import { log, notifyStep, openIncident } from './incident';
import { latestReading, nextSimulatedReading } from './location';
import type { AppState, Millis } from './types';

/**
 * Scheduler. Deadlines live in state, not in timers, so a disconnected device,
 * a sleeping tab, or a fast-forwarded clock never silently cancels one.
 * Every pass is idempotent: running it twice at the same `now` changes nothing.
 */
export function tick(state: AppState, now: Millis): void {
  const session = state.session;
  if (!session) return;

  // Session expiry. Open incidents keep escalating after the session ends.
  if (session.status !== 'ended' && now >= session.expiresAt) {
    session.status = 'ended';
    session.endedAt = session.expiresAt;
    session.endedReason = 'expired';
  }

  // Missed private check-ins open an incident.
  for (const ci of state.checkIns) {
    // Server-backed: the server holds this deadline and opens the incident everyone sees.
    if (session.serverId) continue;
    if (ci.status !== 'pending' || now < ci.dueAt) continue;
    ci.status = 'missed';
    openIncident(state, ci.participantId, 'checkin_missed', ci.dueAt, {
      observationId: ci.observationId,
      checkInId: ci.id,
    });
  }

  // Escalate unacknowledged incidents, one step per elapsed deadline.
  for (const incident of state.incidents) {
    // A copy of the server's incident: the server escalates it, never this device.
    if (incident.server) continue;
    while (incident.status === 'open') {
      const nextIndex = incident.currentStep + 1;
      const next = incident.steps[nextIndex];
      if (!next || next.dueAt === undefined || next.dueAt > now) break;
      const prev = incident.steps[incident.currentStep];
      const waitedSec = Math.round((next.dueAt - (prev?.notifiedAt ?? next.dueAt)) / 1000);
      log(incident, {
        at: next.dueAt,
        kind: 'escalation',
        source: 'scheduler',
        text: `No acknowledgment ${waitedSec}s after the last alert. Escalating to the next step.`,
      });
      notifyStep(state, incident, nextIndex, next.dueAt);
    }
  }

  // Simulated location input for participants who chose to share.
  if (session.status === 'active') {
    const every = session.config.locationUpdateEverySec * 1000;
    for (const p of Object.values(state.participants)) {
      if (p.remote || p.status !== 'active' || !p.device.online || p.consent.locationSharing === 'off') continue;
      const last = latestReading(p);
      if (last && now - last.recordedAt < every) continue;
      p.locations.push(nextSimulatedReading(last, now));
      if (p.locations.length > MAX_LOCATION_HISTORY) p.locations.shift();
    }
  }
}
