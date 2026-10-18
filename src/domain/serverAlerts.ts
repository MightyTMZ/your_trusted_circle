import { BACKUP_RECIPIENT_PREFIX, EMERGENCY_SIM_RECIPIENT_ID, HOST_RECIPIENT_PREFIX } from './incident';
import type {
  AppState,
  CheckIn,
  EscalationStep,
  Incident,
  IncidentTrigger,
  Millis,
  Notification,
  Participant,
  ResolutionOutcome,
  TimelineEntry,
  TimelineKind,
  TimelineSource,
} from './types';

/**
 * Server-backed sessions: the server owns check-in deadlines, incidents and
 * escalation (docs/backend.md). This device keeps a read-only copy of each
 * incident the server lets it see, so the same screens show it. The local
 * scheduler never escalates a copy (see `tick`), and acknowledgment and
 * resolution go to the server, whose answer replaces the copy.
 *
 * Shapes mirror src/server/alerts/routes.ts `incidentView` and
 * src/server/safety/routes.ts `checkInView`, as JSON.
 */

export interface ServerIncidentInput {
  id: string;
  participant: { participantId: string; displayName: string };
  trigger: IncidentTrigger;
  openedAt: string;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledged: { by: string; at: string } | null;
  /** `bySubject`: the person the alert is about cancelled it themselves. */
  resolved: { by: string; at: string; outcome: ResolutionOutcome; bySubject?: boolean } | null;
  steps: { level: EscalationStep['level']; recipients: string[]; notifiedAt: string | null; dueAt: string | null }[];
  log: { at: string; kind: string; text: string; simulated?: boolean }[];
}

export interface ServerCheckInInput {
  id: string;
  status: 'pending' | 'responded_ok' | 'requested_help' | 'missed' | 'cancelled';
  promptedAt?: string;
  dueAt?: string;
}

/** An alert delivered to this viewer (GET /api/alerts). */
export interface ServerAlertInput {
  id: string;
  incidentId: string;
  deliveredAt: string | null;
}

const ms = (iso: string | null | undefined): Millis | undefined => (iso ? new Date(iso).getTime() : undefined);

const KIND: Record<string, { kind: TimelineKind; source: TimelineSource }> = {
  checkin: { kind: 'checkin', source: 'system' },
  participant_update: { kind: 'checkin', source: 'participant' },
  notification: { kind: 'notification', source: 'transport' },
  delivery: { kind: 'notification', source: 'transport' },
  escalation: { kind: 'escalation', source: 'scheduler' },
  acknowledgment: { kind: 'acknowledgment', source: 'recipient' },
  resolution: { kind: 'resolution', source: 'recipient' },
  connectivity: { kind: 'connectivity', source: 'system' },
};

/** The local participant for a server participant id, if this device knows them yet. */
export function participantForServerId(state: AppState, serverParticipantId: string): Participant | undefined {
  return Object.values(state.participants).find((p) => p.serverId === serverParticipantId || p.id === serverParticipantId);
}

function stepRecipients(state: AppState, incidentId: string, step: ServerIncidentInput['steps'][number], index: number): string[] {
  const session = state.session!;
  if (step.level === 'host') return [HOST_RECIPIENT_PREFIX + session.hostId];
  if (step.level === 'emergency_simulated') return [EMERGENCY_SIM_RECIPIENT_ID];
  // Backup contacts are known to this device only by the names the server shows.
  return step.recipients.map((name, i) => {
    const id = `${BACKUP_RECIPIENT_PREFIX}srv_${incidentId}_${index}_${i}`;
    state.recipients[id] ??= { id, kind: 'backup_contact', name };
    return id;
  });
}

/** Builds the local copy of a server incident. Returns null until the subject is known on this device. */
export function incidentFromServer(state: AppState, view: ServerIncidentInput, alertId?: string): Incident | null {
  const session = state.session;
  const subject = participantForServerId(state, view.participant.participantId);
  if (!session || !subject) return null;

  const steps: EscalationStep[] = view.steps.map((s, i) => ({
    key: s.level,
    level: s.level,
    recipientIds: stepRecipients(state, view.id, s, i),
    dueAt: ms(s.dueAt),
    notifiedAt: ms(s.notifiedAt),
  }));
  let currentStep = -1;
  steps.forEach((s, i) => s.notifiedAt !== undefined && (currentStep = i));

  const hostRecipient = HOST_RECIPIENT_PREFIX + session.hostId;
  const hostName = state.participants[session.hostId]?.displayName;
  const responderId = (name: string) => (name === hostName ? hostRecipient : `rcp_srv_${name}`);

  const timeline: TimelineEntry[] = view.log.map((e, i) => ({
    id: `evt_srv_${view.id}_${i}`,
    at: ms(e.at)!,
    ...(KIND[e.kind] ?? { kind: 'session' as const, source: 'system' as const }),
    text: e.text,
    ...(e.simulated ? { simulated: true } : {}),
  }));
  timeline.sort((a, b) => a.at - b.at);

  const ackAt = ms(view.acknowledged?.at);
  return {
    id: view.id,
    sessionId: session.id,
    participantId: subject.id,
    openedAt: ms(view.openedAt)!,
    trigger: view.trigger,
    status: view.status,
    steps,
    currentStep,
    lastUnackedNotificationAt: view.status === 'open' && currentStep >= 0 ? steps[currentStep].notifiedAt : undefined,
    escalationStoppedAt: ackAt ?? (view.resolved?.bySubject ? ms(view.resolved.at) : undefined),
    acknowledged: view.acknowledged ? { recipientId: responderId(view.acknowledged.by), name: view.acknowledged.by, at: ackAt! } : undefined,
    resolution: view.resolved
      ? view.resolved.bySubject
        ? { by: 'participant', name: view.resolved.by, at: ms(view.resolved.at)!, outcome: view.resolved.outcome, note: '' }
        : { by: 'recipient', recipientId: responderId(view.resolved.by), name: view.resolved.by, at: ms(view.resolved.at)!, outcome: view.resolved.outcome, note: '' }
      : undefined,
    timeline,
    server: alertId ? { alertId } : {},
  };
}

/**
 * Records the alert the server delivered to this viewer, holding only what the
 * server's alert carries: who, why and when. Location and notes are not part
 * of a server alert, so none are shown as delivered.
 */
function recordDelivery(state: AppState, incident: Incident, alert: ServerAlertInput, viewerId: string): void {
  const recipientId = HOST_RECIPIENT_PREFIX + viewerId;
  if (state.notifications.some((n) => n.id === alert.id)) return;
  const subject = state.participants[incident.participantId];
  const at = ms(alert.deliveredAt) ?? incident.openedAt;
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const n: Notification = {
    id: alert.id,
    incidentId: incident.id,
    recipientId,
    stepKey: 'host',
    deliveredAt: at,
    repeat: false,
    transport: 'simulated',
    payload: {
      participantName: subject?.displayName ?? 'Unknown',
      hostName: state.participants[viewerId]?.displayName ?? 'Unknown',
      trigger: incident.trigger,
      message:
        incident.trigger === 'help_requested'
          ? `${subject?.displayName ?? 'They'} asked for help. Alert received at ${time}.`
          : `${subject?.displayName ?? 'They'} did not answer a private check-in after a movement change. Alert received at ${time}.`,
      locationWithheldReason: 'Not part of the alert. If they share their location with you, it is on the group map.',
    },
  };
  state.notifications.push(n);
}

/** Replaces (or adds) the local copy of one server incident. */
export function applyServerIncident(state: AppState, view: ServerIncidentInput, viewerId: string, alert?: ServerAlertInput): Incident | null {
  const existing = state.incidents.findIndex((i) => i.id === view.id);
  const alertId = alert?.id ?? state.incidents[existing]?.server?.alertId;
  const next = incidentFromServer(state, view, alertId);
  if (!next) return null;
  if (existing >= 0) state.incidents[existing] = next;
  else state.incidents.push(next);
  if (alert) recordDelivery(state, next, alert, viewerId);
  return next;
}

/**
 * Applies one poll of the server: every incident this viewer may see, their
 * own check-ins, and the alerts delivered to them (the host's inbox).
 * Local check-ins the server has closed as missed close here too, so this
 * device stops asking while the server's alert takes over. A pending check-in
 * the server started itself (the presenter's live demo) is shown here like
 * one this phone started, and the answer goes back to the server.
 */
export function applyServerTimeline(
  state: AppState,
  input: { incidents: ServerIncidentInput[]; checkIns: ServerCheckInInput[]; alerts: ServerAlertInput[] },
  viewerId: string,
): void {
  if (!state.session?.serverId) return;
  const alertFor = new Map<string, ServerAlertInput>();
  for (const a of input.alerts) {
    const prev = alertFor.get(a.incidentId);
    // The latest delivery is the one to acknowledge; any of them works on the server.
    if (!prev || (ms(a.deliveredAt) ?? 0) > (ms(prev.deliveredAt) ?? 0)) alertFor.set(a.incidentId, a);
  }
  for (const view of input.incidents) applyServerIncident(state, view, viewerId, alertFor.get(view.id));

  // A check-in this phone is still sending has no server id yet; never mistake it for a new one.
  const sending = state.checkIns.some((c) => c.participantId === viewerId && c.status === 'pending' && !c.server);
  for (const sc of input.checkIns) {
    const local = state.checkIns.find((c) => c.server?.id === sc.id);
    if (!local) {
      const promptedAt = ms(sc.promptedAt);
      const dueAt = ms(sc.dueAt);
      if (sc.status === 'pending' && !sending && promptedAt !== undefined && dueAt !== undefined) {
        state.checkIns.push({ id: `chk_srv_${sc.id}`, participantId: viewerId, observationId: '', promptedAt, dueAt, status: 'pending', server: { id: sc.id } });
      }
      continue;
    }
    if (local.status !== 'pending') continue;
    if (sc.status === 'missed' || sc.status === 'cancelled') local.status = sc.status;
  }
}

/** True while the server has not yet heard about this check-in or its answer. */
export function checkInNeedsSync(c: CheckIn): boolean {
  if (!c.server) return c.status !== 'cancelled' && c.status !== 'responded_ok';
  if (c.server.id === null) return false;
  return (c.status === 'responded_ok' || c.status === 'requested_help') && !c.server.responseSent;
}
