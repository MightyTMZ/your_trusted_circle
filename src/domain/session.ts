import { DEFAULT_CONFIG, MAX_BACKUP_CONTACTS } from './config';
import { emptyBaseline, ingestSample, startCalibration } from './detector';
import { makeId, makeJoinCode } from './ids';
import {
  BACKUP_RECIPIENT_PREFIX,
  EMERGENCY_SIM_RECIPIENT_ID,
  HOST_RECIPIENT_PREFIX,
  activeIncidentFor,
  log,
  openIncident,
} from './incident';
import type {
  AppState,
  BackupContact,
  LocationSharing,
  Millis,
  MotionSample,
  Participant,
  ParticipantConsent,
  Session,
  SessionConfig,
} from './types';

export class SessionError extends Error {}

export function emptyState(): AppState {
  return {
    version: 1,
    clockOffsetMs: 0,
    session: null,
    participants: {},
    recipients: {},
    observations: [],
    checkIns: [],
    incidents: [],
    notifications: [],
    voiceCalls: {},
  };
}

export interface ParticipantInput {
  displayName: string;
  locationSharing: LocationSharing;
  motionMonitoring: boolean;
  shareLocationWithResponders: boolean;
  shareNoteWithResponders: boolean;
  emergencyNote: string;
  backupContacts: Omit<BackupContact, 'id'>[];
}

function makeParticipant(
  sessionId: string,
  role: Participant['role'],
  input: ParticipantInput,
  now: Millis,
): Participant {
  const name = input.displayName.trim();
  if (!name) throw new SessionError('A display name is required.');
  return {
    id: makeId('ptc'),
    sessionId,
    displayName: name,
    role,
    status: 'active',
    consent: {
      joinedAt: now,
      locationSharing: input.locationSharing,
      motionMonitoring: input.motionMonitoring,
      shareLocationWithResponders: input.shareLocationWithResponders,
      shareNoteWithResponders: input.shareNoteWithResponders,
    },
    emergencyNote: input.emergencyNote,
    backupContacts: input.backupContacts
      .filter((c) => c.name.trim())
      .slice(0, MAX_BACKUP_CONTACTS)
      .map((c) => ({ id: makeId('bkc'), name: c.name.trim(), relation: c.relation.trim() })),
    device: { online: true, changedAt: now },
    locations: [],
    baseline: input.motionMonitoring ? startCalibration() : emptyBaseline(),
    motion: { consecutiveOutliers: 0 },
  };
}

function registerBackupRecipients(state: AppState, p: Participant): void {
  for (const c of p.backupContacts) {
    state.recipients[BACKUP_RECIPIENT_PREFIX + c.id] = {
      id: BACKUP_RECIPIENT_PREFIX + c.id,
      kind: 'backup_contact',
      name: c.name,
      participantId: p.id,
    };
  }
}

export interface CreateSessionInput {
  sessionName: string;
  durationMin: number;
  hostCommitment: boolean;
  host: ParticipantInput;
  config?: Partial<SessionConfig>;
}

/** Only a host can initialise a session, and only after accepting the host commitment. */
export function createSession(state: AppState, input: CreateSessionInput, now: Millis): { session: Session; host: Participant } {
  if (!input.hostCommitment) throw new SessionError('The host must accept the host commitment to start a session.');
  const offset = state.clockOffsetMs;
  Object.assign(state, emptyState(), { clockOffsetMs: offset });

  const config: SessionConfig = { ...DEFAULT_CONFIG, ...input.config, durationMin: input.durationMin };
  const sessionId = makeId('ses');
  const host = makeParticipant(sessionId, 'host', input.host, now);
  const session: Session = {
    id: sessionId,
    code: makeJoinCode(),
    name: input.sessionName.trim() || `${host.displayName}'s group`,
    hostId: host.id,
    createdAt: now,
    expiresAt: now + config.durationMin * 60_000,
    status: 'active',
    hostCommitmentAcceptedAt: now,
    config,
  };
  state.session = session;
  state.participants[host.id] = host;
  state.recipients[HOST_RECIPIENT_PREFIX + host.id] = {
    id: HOST_RECIPIENT_PREFIX + host.id,
    kind: 'host',
    name: host.displayName,
    participantId: host.id,
  };
  state.recipients[EMERGENCY_SIM_RECIPIENT_ID] = {
    id: EMERGENCY_SIM_RECIPIENT_ID,
    kind: 'emergency_simulated',
    name: 'Emergency services (simulated)',
  };
  registerBackupRecipients(state, host);
  return { session, host };
}

/** Participants join themselves, with their own consent choices. */
export function joinSession(state: AppState, code: string, input: ParticipantInput, now: Millis): Participant {
  const session = state.session;
  if (!session || session.code !== code.trim().toUpperCase()) throw new SessionError('No session found for that code.');
  if (session.status === 'ended') throw new SessionError('This session has ended.');
  const p = makeParticipant(session.id, 'participant', input, now);
  state.participants[p.id] = p;
  registerBackupRecipients(state, p);
  return p;
}

function requireHost(state: AppState, actorId: string): Session {
  const s = state.session;
  if (!s || s.hostId !== actorId) throw new SessionError('Only the session host can do that.');
  return s;
}

export function suspendSession(state: AppState, actorId: string, now: Millis): void {
  const s = requireHost(state, actorId);
  if (s.status !== 'active') return;
  s.status = 'suspended';
  s.suspendedAt = now;
  // Pending check-ins and open incidents are not cancelled by a suspension.
}

export function resumeSession(state: AppState, actorId: string): void {
  const s = requireHost(state, actorId);
  if (s.status !== 'suspended') return;
  s.status = 'active';
  s.suspendedAt = undefined;
}

export function unacknowledgedIncidents(state: AppState) {
  return state.incidents.filter((i) => i.status === 'open');
}

export function endSession(state: AppState, actorId: string, now: Millis): void {
  const s = requireHost(state, actorId);
  if (unacknowledgedIncidents(state).length > 0) {
    throw new SessionError('Acknowledge every open alert before ending the session.');
  }
  if (s.status === 'ended') return;
  s.status = 'ended';
  s.endedAt = now;
  s.endedReason = 'host_ended';
}

/** Any participant may leave at any time. For the host, leaving ends the session. */
export function leaveSession(state: AppState, participantId: string, now: Millis): void {
  const s = state.session;
  const p = state.participants[participantId];
  if (!s || !p || p.status === 'left') return;
  if (participantId === s.hostId) {
    endSession(state, participantId, now);
    return;
  }
  p.status = 'left';
  p.leftAt = now;
  p.consent.locationSharing = 'off';
  p.consent.motionMonitoring = false;
  state.checkIns.filter((c) => c.participantId === p.id && c.status === 'pending').forEach((c) => (c.status = 'responded_ok'));
  const inc = activeIncidentFor(state, p.id);
  if (inc) log(inc, { at: now, kind: 'session', source: 'participant', text: `${p.displayName} left the session. The alert stays open.` });
}

/** Only the participant themself can change their consent. */
export function updateConsent(
  state: AppState,
  actorId: string,
  participantId: string,
  patch: Partial<Omit<ParticipantConsent, 'joinedAt'>>,
): void {
  if (actorId !== participantId) throw new SessionError("Only participants can change their own sharing settings.");
  const p = state.participants[participantId];
  if (!p || p.status !== 'active') return;
  if (patch.motionMonitoring === true && !p.consent.motionMonitoring && p.baseline.status === 'uncalibrated') {
    p.baseline = startCalibration();
  }
  if (patch.motionMonitoring === false) {
    p.motion = { consecutiveOutliers: 0 };
  }
  Object.assign(p.consent, patch);
}

export function recalibrate(state: AppState, actorId: string, participantId: string): void {
  if (actorId !== participantId) throw new SessionError('Only participants can recalibrate their own baseline.');
  const p = state.participants[participantId];
  if (!p) return;
  p.baseline = startCalibration();
  p.motion = { consecutiveOutliers: 0 };
}

export function setDeviceOnline(state: AppState, participantId: string, online: boolean, now: Millis): void {
  const p = state.participants[participantId];
  if (!p || p.device.online === online) return;
  p.device = { online, changedAt: now };
  const inc = activeIncidentFor(state, participantId);
  if (inc) {
    log(inc, {
      at: now,
      kind: 'connectivity',
      source: 'system',
      text: online
        ? `${p.displayName}'s device reconnected.`
        : `${p.displayName}'s device went offline. Registered escalation timers continue.`,
    });
  }
}

/** Feed raw motion samples through the detector. Inputs only: outcomes come from the detector. */
export function ingestMotion(state: AppState, participantId: string, samples: MotionSample[]): void {
  const s = state.session;
  const p = state.participants[participantId];
  if (!s || !p || s.status !== 'active' || p.status !== 'active' || !p.consent.motionMonitoring || !p.device.online) return;

  for (const sample of samples) {
    const r = ingestSample(p.baseline, p.motion, sample, s.config.detector);
    p.baseline = r.baseline;
    p.motion = r.motion;
    if (!r.movementChanged) continue;

    const hasPending = state.checkIns.some((c) => c.participantId === p.id && c.status === 'pending');
    if (hasPending || activeIncidentFor(state, p.id)) continue;

    const obs = {
      id: makeId('obs'),
      participantId: p.id,
      at: sample.at,
      kind: 'movement_changed' as const,
      zScore: r.movementChanged.zScore,
      consecutive: r.movementChanged.consecutive,
      baselineMean: r.movementChanged.mean,
      baselineStd: r.movementChanged.std,
      unit: 'm/s²' as const,
    };
    state.observations.push(obs);
    state.checkIns.push({
      id: makeId('chk'),
      participantId: p.id,
      observationId: obs.id,
      promptedAt: sample.at,
      dueAt: sample.at + s.config.checkInWindowSec * 1000,
      status: 'pending',
    });
  }
}

export function respondToCheckIn(
  state: AppState,
  actorId: string,
  checkInId: string,
  response: 'ok' | 'help',
  now: Millis,
): void {
  const ci = state.checkIns.find((c) => c.id === checkInId);
  if (!ci || ci.participantId !== actorId || ci.status !== 'pending') return;
  ci.respondedAt = now;
  if (response === 'ok') {
    ci.status = 'responded_ok';
    return;
  }
  ci.status = 'requested_help';
  openIncident(state, actorId, 'help_requested', now, { observationId: ci.observationId, checkInId: ci.id });
}

/** Participant asks for help directly, without a preceding observation. */
export function requestHelp(state: AppState, actorId: string, now: Millis): void {
  const p = state.participants[actorId];
  if (!p || p.status !== 'active') return;
  const inc = openIncident(state, actorId, 'help_requested', now);
  if (!inc.timeline.some((e) => e.source === 'participant')) {
    log(inc, { at: now, kind: 'checkin', source: 'participant', text: `${p.displayName} chose "I need help".` });
  }
}

/** A participant's own message on an open alert. Logged only: it never acknowledges or resolves. */
export function participantUpdate(state: AppState, actorId: string, now: Millis): void {
  const inc = activeIncidentFor(state, actorId);
  if (!inc) return;
  log(inc, {
    at: now,
    kind: 'checkin',
    source: 'participant',
    text: `${state.participants[actorId].displayName} responded "I'm OK" from their device. The alert stays open until a recipient acknowledges and resolves it.`,
  });
}
