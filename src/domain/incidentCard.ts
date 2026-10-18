import { latestPayloadFor } from './transport';
import type { AppState, EscalationStep, Incident, LocationReading, Millis, TimelineEntry } from './types';

export interface IncidentCard {
  incidentId: string;
  participantName: string;
  status: Incident['status'];
  trigger: Incident['trigger'];
  openedAt: Millis;
  events: TimelineEntry[];
  steps: EscalationStep[];
  lastKnownLocation?: LocationReading;
  locationNote?: string;
  emergencyNote?: string;
  acknowledged?: Incident['acknowledged'];
  resolution?: Incident['resolution'];
  disclaimers: string[];
}

export const CARD_DISCLAIMERS = [
  'Movement observations are compared with a personal baseline. They are observations, not medical conclusions.',
  'Acknowledgment means a recipient is responding. It does not confirm the person’s wellbeing.',
  'Emergency-service delivery and the voice call are simulated. No real call or message was placed.',
  'Detection thresholds and escalation intervals are unvalidated demo values.',
];

export const SELF_CANCEL_DISCLAIMER =
  'The person cancelled this alert from their own device. That is their own report; no one has checked on them in person.';

/**
 * Builds the card for one recipient from the incident timeline and only the
 * personal fields that were actually delivered to that recipient.
 */
export function buildIncidentCard(state: AppState, incidentId: string, recipientId: string): IncidentCard | null {
  const incident = state.incidents.find((i) => i.id === incidentId);
  if (!incident) return null;
  const payload = latestPayloadFor(state, incidentId, recipientId);
  return {
    incidentId,
    participantName: payload?.participantName ?? state.participants[incident.participantId]?.displayName ?? 'Unknown',
    status: incident.status,
    trigger: incident.trigger,
    openedAt: incident.openedAt,
    events: [...incident.timeline].sort((a, b) => a.at - b.at),
    steps: incident.steps,
    lastKnownLocation: payload?.lastKnownLocation,
    locationNote: payload?.locationWithheldReason,
    emergencyNote: payload?.emergencyNote,
    acknowledged: incident.acknowledged,
    resolution: incident.resolution,
    disclaimers:
      incident.resolution?.by === 'participant' ? [...CARD_DISCLAIMERS, SELF_CANCEL_DISCLAIMER] : CARD_DISCLAIMERS,
  };
}
