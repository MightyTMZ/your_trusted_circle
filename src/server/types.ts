/**
 * Documents stored by the backend in one MongoDB database (docs/YTC Grand
 * Architecture.png): users, auth_sessions, sessions, traces, raw_recordings,
 * checkins, incidents, notification_jobs, timeline_events, contact_invites.
 *
 * Deliberately absent: IP addresses, OAuth access/refresh tokens, and
 * location coordinates outside an active incident (lifecycle/location.ts).
 */

import type { DataOrigin } from "../timeline/schema/envelope.js";

export const PROVIDER_IDS = ["google", "apple", "microsoft"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** "test" is the localhost-only test sign-in (config.testSignIn); never an OAuth provider. */
export type IdentityProvider = ProviderId | "test";

export interface Identity {
  provider: IdentityProvider;
  /** The provider's stable user id (OIDC `sub`). */
  subject: string;
  linkedAt: Date;
}

export interface UserDoc {
  _id: string; // usr_<uuid>
  displayName: string;
  /** Profile picture as a small image data URL (PNG, JPEG or WebP); null or absent shows initials. */
  avatar?: string | null;
  email: string | null;
  emailVerified: boolean;
  identities: Identity[];
  createdAt: Date;
  updatedAt: Date;
}

/** A signed-in browser. Only the SHA-256 of the cookie token is stored. */
export interface AuthSessionDoc {
  _id: string; // sha256 hex of the session token
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

// ── Sessions ───────────────────────────────────────────────────────────

export type LocationSharing = "group" | "host" | "off";

/** Each participant sets these for themselves only; the host cannot. */
export interface ParticipantConsent {
  monitoring: boolean;
  locationSharing: LocationSharing;
  /** Share last-known location with responders during an incident. */
  shareLocationWithResponders: boolean;
  /** Share their name and note with responders (simulated emergency services) during an incident. */
  shareNoteWithResponders?: boolean;
}

/**
 * Someone a participant wants alerted if their host doesn't respond. Without
 * an account (userId null) alerts go through the simulated transport; once
 * they accept an invite, alerts reach their YTC inbox and they can acknowledge.
 */
export interface BackupContact {
  id: string; // con_<uuid>
  name: string;
  relation: string;
  userId: string | null;
}

export interface ParticipantDoc {
  participantId: string; // par_<uuid>, the id used in timeline events
  userId: string;
  displayName: string;
  role: "host" | "participant";
  joinedAt: Date;
  leftAt: Date | null;
  consent: ParticipantConsent;
  /** Which consent text the person agreed to, and when they last chose. The full history is in the timeline. */
  consentTextVersion: string;
  consentUpdatedAt: Date;
  backupContacts: BackupContact[];
  /** Self-reported note for responders (synthetic in demos). Disclosed only under consent.shareNoteWithResponders. */
  responderNote?: string | null;
  /** Last heartbeat from this participant's device. Missing heartbeats never cancel a deadline. */
  lastHeartbeatAt: Date | null;
  deviceOnline: boolean;
}

/** Session-wide rules. Only the host sets them. Values are unvalidated demo defaults. */
export interface SessionRules {
  checkInWindowSec: number;
  hostAckWindowSec: number;
  backupAckWindowSec: number;
  locationStaleAfterSec: number;
  /** A device silent for this long is marked offline. */
  heartbeatTimeoutSec: number;
  maxParticipants: number;
  /** When false, nobody in the session may share location, whatever they choose. */
  allowLocationSharing: boolean;
  /**
   * Demo only: a public place (a club, a hall) the host picks so simulated and
   * "teleported" people appear there. Never a participant's own position.
   */
  demoVenue?: { label: string; lat: number; lng: number } | null;
}

export type EndedReason = "host_ended" | "expired" | "host_deleted_account";

export interface SessionDoc {
  _id: string; // ses_<uuid>
  code: string; // 6-character join code, also encoded in the QR join link
  name: string;
  hostUserId: string;
  status: "active" | "ended";
  endedReason: EndedReason | null;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  /** Set while the host has paused the session: no new check-ins or live location; open alerts keep escalating. */
  suspendedAt: Date | null;
  rules: SessionRules;
  participants: ParticipantDoc[];
}

// ── Safety state and deadlines ─────────────────────────────────────────

export type CheckInStatus = "pending" | "responded_ok" | "requested_help" | "missed" | "cancelled";

/** A private "Are you OK?" for one participant, with a server-held deadline. */
export interface CheckInDoc {
  _id: string; // chk_<uuid>
  sessionId: string;
  participantId: string;
  reason: "movement_changed" | "manual";
  /** The timeline event (on the originating device) that caused it, if any. */
  observationEventId: string | null;
  promptedAt: Date;
  dueAt: Date;
  status: CheckInStatus;
  respondedAt: Date | null;
  cancelledReason: "participant_left" | "session_ended" | null;
  incidentId: string | null;
}

export type Recipient =
  | { kind: "user"; userId: string; name: string }
  | { kind: "backup_contact"; contactId: string; name: string }
  | { kind: "emergency_simulated"; name: string };

export type EscalationLevel = "host" | "group" | "backup" | "emergency_simulated";

export interface EscalationStep {
  /** esc_<uuid>, the id timeline escalation events use for this step. */
  escalationId: string;
  level: EscalationLevel;
  recipients: Recipient[];
  /** When this step fires if nobody has acknowledged. Set when the previous step is notified. */
  dueAt: Date | null;
  notifiedAt: Date | null;
  /** Times this step was repeated. Repeats never move the deadline. */
  repeats: number;
}

export interface IncidentLogEntry {
  at: Date;
  kind: "checkin" | "notification" | "delivery" | "escalation" | "connectivity" | "acknowledgment" | "resolution" | "participant_update";
  text: string;
  simulated?: boolean;
}

export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface IncidentDoc {
  _id: string; // inc_<uuid>
  sessionId: string;
  participantId: string;
  trigger: "checkin_missed" | "help_requested";
  checkInId: string | null;
  /** Timeline events: what triggered it, and the incident.opened event itself. */
  triggerEventId: string | null;
  openedEventId: string | null;
  openedAt: Date;
  status: IncidentStatus;
  /** `${sessionId}:${participantId}` while open or acknowledged, so a person has at most one active incident. */
  activeKey: string | null;
  steps: EscalationStep[];
  currentStep: number;
  acknowledged: { byUserId: string; name: string; at: Date } | null;
  /** `bySubject`: the person the alert is about cancelled it themselves (their own report). */
  resolved: { byUserId: string; name: string; at: Date; outcome: "false_alarm" | "assistance_reached" | "other"; bySubject?: boolean } | null;
  log: IncidentLogEntry[];
}

// ── Alert orchestration ────────────────────────────────────────────────

export type JobStatus = "queued" | "sending" | "delivered" | "failed" | "cancelled";

/**
 * Exactly what an alert told its recipient, frozen when it was sent.
 * Recipients see this and nothing more (CLAUDE.md: recipients may use only
 * information actually delivered to them).
 */
export interface AlertPayload {
  about: string;
  sessionName: string;
  trigger: IncidentDoc["trigger"];
  openedAt: Date;
  message: string;
  /** The timeline events this alert's facts come from. */
  factEventIds: string[];
}

/** One alert to one recipient for one escalation step. `dedupeKey` is unique: never sent twice. */
export interface NotificationJobDoc {
  _id: string; // ntf_<uuid>
  dedupeKey: string; // `${incidentId}:${stepIndex}:${recipientKey}`
  incidentId: string;
  sessionId: string;
  stepIndex: number;
  level: EscalationLevel;
  /** 0 for the first send, 1.. for repeats of the same step. */
  repeat: number;
  recipient: Recipient;
  payload: AlertPayload;
  /** The user this alert concerns, so account deletion can find it. */
  subjectUserId: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: Date;
  /** A worker that claimed the job owns it until then; afterwards another may retry. */
  leaseUntil: Date | null;
  results: { at: Date; ok: boolean; reason?: string }[];
  createdAt: Date;
  deliveredAt: Date | null;
  /** First time the recipient opened it. Not an acknowledgment. */
  viewedAt: Date | null;
  acknowledgedAt: Date | null;
}

// ── Traces ─────────────────────────────────────────────────────────────

export const TRACE_KINDS = ["event", "log", "action", "sensor", "device", "app"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** Anything a client sends: timeline events, logs, UI actions, sensor batches, device info. */
export interface TraceDoc {
  _id: string; // trc_<uuid>
  /** The signed-in user who sent it. Never taken from the request body. */
  userId: string;
  sessionId: string | null;
  /** The sender's participant id in that session. */
  participantId: string | null;
  /** Who the trace is about, when that differs from the sender (e.g. the host reporting about someone). */
  subjectParticipantId: string | null;
  kind: TraceKind;
  /** For timeline events, the event type (e.g. "checkin.responded"). */
  type: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
  data: unknown;
  /** True when location fields were removed before storing. */
  locationRedacted: boolean;
  /** For timeline events, the client's event_id: a resent event is stored once. */
  eventId: string | null;
  /** Optional client id for other items, for the same de-duplication. */
  clientItemId: string | null;
  /** Where the data came from; recorded and synthetic data are never mixed up (CLAUDE.md). */
  dataOrigin: DataOrigin | null;
  /** Sensor data only: raw samples (stored in raw_recordings) or derived features. */
  dataClass: "raw" | "derived" | null;
  units: string | null;
  /** The server timeline event this was copied into, if any. */
  timelineEventId: string | null;
}

export { DATA_ORIGINS, type DataOrigin } from "../timeline/schema/envelope.js";

/** A link that lets a backup contact attach their own YTC account. Only the hash of the token is stored. */
export interface ContactInviteDoc {
  _id: string; // sha256 hex of the invite token
  sessionId: string;
  participantId: string;
  contactId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedByUserId: string | null;
}
