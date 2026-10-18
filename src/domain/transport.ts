import { makeId } from './ids';
import { latestReading } from './location';
import type { AppState, Incident, Millis, Notification, NotificationPayload, Recipient } from './types';

/**
 * Simulated transport. Delivers into in-process recipient inboxes only.
 * There is no network, telephony, or messaging integration here or anywhere else.
 */

export const MOCK_OPERATOR_ENDPOINT = 'mock://operator.local' as const;

function fmt(t: Millis): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function buildPayload(state: AppState, incident: Incident, recipient: Recipient): NotificationPayload {
  const p = state.participants[incident.participantId];
  const host = state.session ? state.participants[state.session.hostId] : undefined;
  const obs = state.observations.find((o) => o.id === incident.observationId);
  const checkIn = state.checkIns.find((c) => c.id === incident.checkInId);

  const message =
    incident.trigger === 'help_requested'
      ? `${p.displayName} asked for help from a private check-in at ${fmt(checkIn?.respondedAt ?? incident.openedAt)}.`
      : `Movement changed for ${p.displayName} at ${fmt(obs?.at ?? incident.openedAt)}. No response to the private check-in by ${fmt(checkIn?.dueAt ?? incident.openedAt)}.`;

  const isHost = recipient.kind === 'host';
  const locationAllowed = p.consent.shareLocationWithResponders || (isHost && p.consent.locationSharing !== 'off');
  const reading = latestReading(p);

  return {
    participantName: p.displayName,
    hostName: host?.displayName ?? 'Unknown',
    trigger: incident.trigger,
    observedAt: obs?.at,
    checkInDueAt: checkIn?.dueAt,
    message,
    lastKnownLocation: locationAllowed && reading ? { ...reading } : undefined,
    locationWithheldReason: !locationAllowed
      ? `${p.displayName} did not consent to share location with this recipient.`
      : reading
        ? undefined
        : 'No location reading has been recorded.',
    emergencyNote: p.consent.shareNoteWithResponders && p.emergencyNote.trim() ? p.emergencyNote.trim() : undefined,
  };
}

/** Deliver one notification. Non-repeat deliveries are de-duplicated per incident, step, and recipient. */
export function deliver(
  state: AppState,
  incident: Incident,
  stepKey: string,
  recipientId: string,
  at: Millis,
  repeat = false,
): Notification | null {
  if (
    !repeat &&
    state.notifications.some(
      (n) => n.incidentId === incident.id && n.stepKey === stepKey && n.recipientId === recipientId && !n.repeat,
    )
  ) {
    return null;
  }
  const recipient = state.recipients[recipientId];
  if (!recipient) return null;
  const n: Notification = {
    id: makeId('ntf'),
    incidentId: incident.id,
    recipientId,
    stepKey,
    deliveredAt: at,
    repeat,
    payload: buildPayload(state, incident, recipient),
    transport: 'simulated',
  };
  state.notifications.push(n);
  return n;
}

/**
 * Tell a recipient who was already alerted that the person cancelled the alert
 * themselves. Sent once per recipient. Carries the facts they already had, so
 * nothing new is disclosed, and says plainly that it is the person's own report.
 */
export function deliverCancellation(state: AppState, incident: Incident, recipientId: string, at: Millis): Notification | null {
  if (state.notifications.some((n) => n.incidentId === incident.id && n.recipientId === recipientId && n.stepKey === 'cancelled')) {
    return null;
  }
  const previous = latestPayloadFor(state, incident.id, recipientId);
  if (!previous) return null;
  const n: Notification = {
    id: makeId('ntf'),
    incidentId: incident.id,
    recipientId,
    stepKey: 'cancelled',
    deliveredAt: at,
    repeat: false,
    payload: {
      ...previous,
      kind: 'cancelled',
      message: `${previous.participantName} cancelled this alert from their own device at ${fmt(at)} and says it was a false alarm. Escalation has stopped. This is their own report; no one has checked on them in person.`,
    },
    transport: 'simulated',
  };
  state.notifications.push(n);
  return n;
}

export function inboxFor(state: AppState, recipientId: string): Notification[] {
  return state.notifications.filter((n) => n.recipientId === recipientId).sort((a, b) => b.deliveredAt - a.deliveredAt);
}

/** The most recent payload a recipient received for an incident: the only facts they may use. */
export function latestPayloadFor(state: AppState, incidentId: string, recipientId: string): NotificationPayload | undefined {
  return state.notifications
    .filter((n) => n.incidentId === incidentId && n.recipientId === recipientId)
    .sort((a, b) => b.deliveredAt - a.deliveredAt)[0]?.payload;
}
