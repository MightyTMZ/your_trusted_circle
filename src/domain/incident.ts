import { makeId } from './ids';
import { deliver, deliverCancellation } from './transport';
import { relayCancellation, startSimulatedCall } from './voiceAgent';
import type {
  AppState,
  EscalationStep,
  Incident,
  IncidentTrigger,
  Millis,
  ResolutionOutcome,
  TimelineEntry,
} from './types';

export const HOST_RECIPIENT_PREFIX = 'rcp_host_';
export const BACKUP_RECIPIENT_PREFIX = 'rcp_bk_';
export const EMERGENCY_SIM_RECIPIENT_ID = 'rcp_emergency_simulated';

export function fmtTime(t: Millis): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function log(incident: Incident, entry: Omit<TimelineEntry, 'id'>): TimelineEntry {
  const e = { id: makeId('evt'), ...entry };
  incident.timeline.push(e);
  incident.timeline.sort((a, b) => a.at - b.at);
  return e;
}

export function activeIncidentFor(state: AppState, participantId: string): Incident | undefined {
  return state.incidents.find((i) => i.participantId === participantId && i.status !== 'resolved');
}

function ackWindowMs(state: AppState, level: EscalationStep['level']): number {
  const cfg = state.session!.config;
  return (level === 'host' ? cfg.hostAckWindowSec : cfg.backupAckWindowSec) * 1000;
}

function levelLabel(state: AppState, step: EscalationStep): string {
  if (step.level === 'emergency_simulated') return 'simulated emergency services';
  return step.recipientIds.map((id) => state.recipients[id]?.name ?? 'unknown').join(', ');
}

/** Notify every recipient of a step. Safe to call twice: delivery is de-duplicated. */
export function notifyStep(state: AppState, incident: Incident, index: number, at: Millis): void {
  const step = incident.steps[index];
  if (!step || step.notifiedAt !== undefined) return;
  step.notifiedAt = at;
  incident.currentStep = index;
  incident.lastUnackedNotificationAt = at;

  for (const rid of step.recipientIds) deliver(state, incident, step.key, rid, at);

  if (step.level === 'emergency_simulated') {
    log(incident, {
      at,
      kind: 'escalation',
      source: 'scheduler',
      simulated: true,
      text: 'Escalated to simulated emergency services. No real call or message was placed.',
    });
    startSimulatedCall(state, incident, at);
  } else {
    log(incident, {
      at,
      kind: 'notification',
      source: 'transport',
      simulated: true,
      text: `Alert sent to ${levelLabel(state, step)} (${step.level === 'host' ? 'session host' : 'backup contacts'}).`,
    });
  }

  const next = incident.steps[index + 1];
  if (next) next.dueAt = at + ackWindowMs(state, step.level);
}

export function openIncident(
  state: AppState,
  participantId: string,
  trigger: IncidentTrigger,
  now: Millis,
  refs: { observationId?: string; checkInId?: string } = {},
): Incident {
  const existing = activeIncidentFor(state, participantId);
  if (existing) return existing;

  const session = state.session!;
  const p = state.participants[participantId];
  const steps: EscalationStep[] = [];
  if (participantId !== session.hostId) {
    steps.push({ key: 'host', level: 'host', recipientIds: [HOST_RECIPIENT_PREFIX + session.hostId] });
  }
  if (p.backupContacts.length > 0) {
    steps.push({ key: 'backup', level: 'backup', recipientIds: p.backupContacts.map((c) => BACKUP_RECIPIENT_PREFIX + c.id) });
  }
  steps.push({ key: 'emergency_simulated', level: 'emergency_simulated', recipientIds: [EMERGENCY_SIM_RECIPIENT_ID] });

  const incident: Incident = {
    id: makeId('inc'),
    sessionId: session.id,
    participantId,
    openedAt: now,
    trigger,
    observationId: refs.observationId,
    checkInId: refs.checkInId,
    status: 'open',
    steps,
    currentStep: -1,
    timeline: [],
  };

  const obs = state.observations.find((o) => o.id === refs.observationId);
  if (obs) {
    log(incident, {
      at: obs.at,
      kind: 'observation',
      source: 'detector',
      text: `Movement changed: ${obs.consecutive} consecutive samples outside ${p.displayName}'s personal baseline (|z| ≥ threshold). Observation only.`,
    });
  }
  const ci = state.checkIns.find((c) => c.id === refs.checkInId);
  if (ci) {
    log(incident, { at: ci.promptedAt, kind: 'checkin', source: 'system', text: 'Private check-in sent to participant.' });
    if (ci.status === 'missed') {
      log(incident, { at: ci.dueAt, kind: 'checkin', source: 'scheduler', text: 'No response to private check-in within the window.' });
    }
    if (ci.status === 'requested_help' && ci.respondedAt) {
      log(incident, { at: ci.respondedAt, kind: 'checkin', source: 'participant', text: `${p.displayName} chose "I need help".` });
    }
  }
  if (!p.device.online) {
    log(incident, {
      at: now,
      kind: 'connectivity',
      source: 'system',
      text: "Participant's device is offline. Escalation timers continue regardless.",
    });
  }

  state.incidents.push(incident);
  notifyStep(state, incident, 0, now);
  return incident;
}

/** Re-send the current step. Does not move the escalation deadline. */
export function repeatAlert(state: AppState, incidentId: string, now: Millis): void {
  const incident = state.incidents.find((i) => i.id === incidentId);
  if (!incident || incident.status !== 'open' || incident.currentStep < 0) return;
  const step = incident.steps[incident.currentStep];
  for (const rid of step.recipientIds) deliver(state, incident, step.key, rid, now, true);
  log(incident, {
    at: now,
    kind: 'notification',
    source: 'transport',
    simulated: true,
    text: `Alert repeated to ${levelLabel(state, step)}. Escalation deadline unchanged.`,
  });
}

export function acknowledge(state: AppState, incidentId: string, recipientId: string, now: Millis): void {
  const incident = state.incidents.find((i) => i.id === incidentId);
  if (!incident || incident.status !== 'open') return;
  const name = state.recipients[recipientId]?.name ?? 'Unknown recipient';
  incident.status = 'acknowledged';
  incident.acknowledged = { recipientId, name, at: now };
  incident.escalationStoppedAt = now;
  for (const s of incident.steps) if (s.notifiedAt === undefined) s.dueAt = undefined;
  log(incident, {
    at: now,
    kind: 'acknowledgment',
    source: 'recipient',
    text: `Acknowledged by ${name}. Pending escalation stopped. This does not confirm ${state.participants[incident.participantId].displayName}'s wellbeing.`,
  });
}

/** A separate action from acknowledgment. Only an acknowledged incident can be resolved. */
export function resolve(
  state: AppState,
  incidentId: string,
  recipientId: string,
  outcome: ResolutionOutcome,
  note: string,
  now: Millis,
): void {
  const incident = state.incidents.find((i) => i.id === incidentId);
  if (!incident || incident.status !== 'acknowledged') return;
  const name = state.recipients[recipientId]?.name ?? 'Unknown recipient';
  incident.status = 'resolved';
  incident.resolution = { by: 'recipient', recipientId, name, at: now, outcome, note: note.trim() };
  const label =
    outcome === 'false_alarm' ? 'False alarm' : outcome === 'assistance_reached' ? 'Someone reached them in person' : 'Other';
  log(incident, {
    at: now,
    kind: 'resolution',
    source: 'recipient',
    text: `Resolved by ${name}: ${label}.${note.trim() ? ` Note: "${note.trim()}"` : ''}`,
  });
}

/** Who has been sent this alert so far, by name, as a readable list. */
export function alertedNames(state: AppState, incident: Incident): string {
  const names = alertedRecipientIds(incident).map((id) =>
    id === EMERGENCY_SIM_RECIPIENT_ID ? 'simulated emergency services' : (state.recipients[id]?.name ?? 'unknown'),
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'nobody yet');
}

/** Everyone who has been sent this alert so far, in the order they were alerted. */
export function alertedRecipientIds(incident: Incident): string[] {
  return incident.steps.filter((s) => s.notifiedAt !== undefined).flatMap((s) => s.recipientIds);
}

/**
 * Close an open or acknowledged incident as a false alarm reported by the
 * person it is about. Callers check that the actor is that person
 * (see `cancelOwnAlert` in session.ts). Stops pending escalation, tells
 * everyone already alerted, and has the voice agent relay the cancellation
 * before ending the simulated call. Recorded as the person's own report.
 */
export function cancelBySubject(state: AppState, incident: Incident, now: Millis): void {
  if (incident.status === 'resolved') return;
  const name = state.participants[incident.participantId]?.displayName ?? 'The participant';

  incident.status = 'resolved';
  incident.escalationStoppedAt ??= now;
  for (const s of incident.steps) if (s.notifiedAt === undefined) s.dueAt = undefined;
  incident.resolution = { by: 'participant', name, at: now, outcome: 'false_alarm', note: '' };
  const entry = log(incident, {
    at: now,
    kind: 'resolution',
    source: 'participant',
    text: `${name} cancelled the alert from their own device: false alarm. Pending escalation stopped. This is their own report; no one has checked on them in person.`,
  });

  const told = alertedRecipientIds(incident);
  for (const rid of told) deliverCancellation(state, incident, rid, now);
  if (told.length > 0) {
    const names = told.map((id) => (id === EMERGENCY_SIM_RECIPIENT_ID ? 'simulated emergency services' : state.recipients[id]?.name ?? 'unknown'));
    log(incident, {
      at: now,
      kind: 'notification',
      source: 'transport',
      simulated: true,
      text: `Cancellation sent to ${names.join(', ')}.`,
    });
  }
  relayCancellation(state, incident, entry, now);
}

export function nextDeadline(incident: Incident): Millis | undefined {
  if (incident.status !== 'open') return undefined;
  return incident.steps[incident.currentStep + 1]?.dueAt;
}
