// Shared domain types. All times are epoch milliseconds from the injected clock.

export type Millis = number;

export type LocationSharing = 'group' | 'host' | 'off';

/** Synthetic position, in metres from the synthetic venue origin. Never a real coordinate. */
export interface LocationReading {
  x: number;
  y: number;
  accuracyM: number;
  recordedAt: Millis;
  source: 'simulated';
}

export interface BackupContact {
  id: string;
  name: string;
  relation: string;
}

export interface ParticipantConsent {
  joinedAt: Millis;
  locationSharing: LocationSharing;
  motionMonitoring: boolean;
  /** Share last-known location with alert recipients beyond the host (backup contacts, simulated emergency services). */
  shareLocationWithResponders: boolean;
  shareNoteWithResponders: boolean;
}

/** Raw input sample. Kept separate from derived baseline statistics. */
export interface MotionSample {
  at: Millis;
  magnitude: number;
  unit: 'm/s²';
  provenance: string;
}

export interface MotionBaseline {
  status: 'uncalibrated' | 'calibrating' | 'calibrated';
  calibrationSamples: number[];
  mean?: number;
  std?: number;
  n: number;
  calibratedAt?: Millis;
}

export interface MotionState {
  consecutiveOutliers: number;
  lastSampleAt?: Millis;
  lastZ?: number;
}

export interface Participant {
  id: string;
  sessionId: string;
  displayName: string;
  role: 'host' | 'participant';
  status: 'active' | 'left';
  leftAt?: Millis;
  consent: ParticipantConsent;
  emergencyNote: string;
  backupContacts: BackupContact[];
  device: { online: boolean; changedAt: Millis };
  /** Oldest first. Only collected while the participant shares location. */
  locations: LocationReading[];
  baseline: MotionBaseline;
  motion: MotionState;
  /** The server's participant id, when the session is on the server. */
  serverId?: string;
  /**
   * Joined from another device. Known only from the server's session view:
   * no simulated readings or check-ins run for them here, and their location
   * comes only from the server's live relay.
   */
  remote?: boolean;
}

export interface SessionConfig {
  durationMin: number;
  checkInWindowSec: number;
  hostAckWindowSec: number;
  backupAckWindowSec: number;
  locationStaleAfterSec: number;
  locationUpdateEverySec: number;
  detector: DetectorConfig;
}

export interface DetectorConfig {
  calibrationSamples: number;
  zThreshold: number;
  consecutiveSamples: number;
  minStd: number;
}

export type SessionStatus = 'active' | 'suspended' | 'ended';

export interface Session {
  id: string;
  code: string;
  name: string;
  hostId: string;
  createdAt: Millis;
  expiresAt: Millis;
  status: SessionStatus;
  suspendedAt?: Millis;
  endedAt?: Millis;
  endedReason?: 'host_ended' | 'expired';
  hostCommitmentAcceptedAt: Millis;
  config: SessionConfig;
  /** The server's id for this session, when it was created or joined through the API. */
  serverId?: string;
}

export interface Observation {
  id: string;
  participantId: string;
  at: Millis;
  kind: 'movement_changed';
  zScore: number;
  consecutive: number;
  baselineMean: number;
  baselineStd: number;
  unit: 'm/s²';
}

/** `cancelled`: closed by the server without an answer (session ended, you left, or an alert was already open). */
export type CheckInStatus = 'pending' | 'responded_ok' | 'requested_help' | 'missed' | 'cancelled';

export interface CheckIn {
  id: string;
  participantId: string;
  observationId: string;
  promptedAt: Millis;
  dueAt: Millis;
  status: CheckInStatus;
  respondedAt?: Millis;
  /**
   * Server-backed sessions only. The server owns the check-in deadline, so this
   * device never opens an incident for it; `id` is null when the server refused it.
   */
  server?: { id: string | null; refused?: string; responseSent?: boolean };
}

export type TimelineKind =
  | 'observation'
  | 'checkin'
  | 'notification'
  | 'acknowledgment'
  | 'escalation'
  | 'resolution'
  | 'connectivity'
  | 'voice'
  | 'session';

export type TimelineSource =
  | 'detector'
  | 'participant'
  | 'scheduler'
  | 'transport'
  | 'recipient'
  | 'voice_agent'
  | 'mock_operator'
  | 'system';

export interface TimelineEntry {
  id: string;
  at: Millis;
  kind: TimelineKind;
  source: TimelineSource;
  text: string;
  simulated?: boolean;
}

export type EscalationLevel = 'host' | 'backup' | 'emergency_simulated';

export interface EscalationStep {
  key: string;
  level: EscalationLevel;
  recipientIds: string[];
  /** Deadline at which this step fires. Set when the previous step was notified. */
  dueAt?: Millis;
  notifiedAt?: Millis;
}

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentTrigger = 'checkin_missed' | 'help_requested';
export type ResolutionOutcome = 'false_alarm' | 'assistance_reached' | 'other';

export interface Incident {
  id: string;
  sessionId: string;
  participantId: string;
  openedAt: Millis;
  trigger: IncidentTrigger;
  observationId?: string;
  checkInId?: string;
  status: IncidentStatus;
  steps: EscalationStep[];
  /** Index of the most recently notified step. */
  currentStep: number;
  lastUnackedNotificationAt?: Millis;
  escalationStoppedAt?: Millis;
  acknowledged?: { recipientId: string; name: string; at: Millis };
  /**
   * `by: 'participant'` means the person the alert is about cancelled it from
   * their own device. That is their own report, not a check by anyone else.
   */
  resolution?: {
    by: 'recipient' | 'participant';
    recipientId?: string;
    name: string;
    at: Millis;
    outcome: ResolutionOutcome;
    note: string;
  };
  timeline: TimelineEntry[];
  /**
   * Set when the incident is a copy of the server's (server-backed sessions).
   * The server owns its deadlines and state; this device only displays it.
   * `alertId` is this viewer's delivered alert, needed to acknowledge.
   */
  server?: { alertId?: string };
}

export type RecipientKind = 'host' | 'backup_contact' | 'emergency_simulated';

export interface Recipient {
  id: string;
  kind: RecipientKind;
  name: string;
  /** For host recipients, the host's participant id. For backups, whose contact they are. */
  participantId?: string;
}

/** Exactly what a recipient was told. Recipients may use only this. */
export interface NotificationPayload {
  /** 'cancelled': the person cancelled the alert themselves; escalation has stopped. */
  kind?: 'alert' | 'cancelled';
  participantName: string;
  hostName: string;
  trigger: IncidentTrigger;
  observedAt?: Millis;
  checkInDueAt?: Millis;
  message: string;
  lastKnownLocation?: LocationReading;
  locationWithheldReason?: string;
  emergencyNote?: string;
}

export interface Notification {
  id: string;
  incidentId: string;
  recipientId: string;
  stepKey: string;
  deliveredAt: Millis;
  repeat: boolean;
  payload: NotificationPayload;
  transport: 'simulated';
}

export interface VoiceUtterance {
  id: string;
  at: Millis;
  speaker: 'agent' | 'operator';
  text: string;
  /** Evidence for agent statements: timeline entry ids or user-provided field names. */
  grounds: string[];
}

export interface VoiceCall {
  incidentId: string;
  endpoint: string;
  startedAt: Millis;
  status: 'connected' | 'ended' | 'disconnected' | 'failed';
  endedAt?: Millis;
  utterances: VoiceUtterance[];
  silenceCount: number;
}

export interface AppState {
  version: 1;
  clockOffsetMs: number;
  session: Session | null;
  participants: Record<string, Participant>;
  recipients: Record<string, Recipient>;
  observations: Observation[];
  checkIns: CheckIn[];
  incidents: Incident[];
  notifications: Notification[];
  voiceCalls: Record<string, VoiceCall>;
}
