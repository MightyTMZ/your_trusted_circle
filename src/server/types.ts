/**
 * Documents stored by the backend in one MongoDB database (docs/YTC Grand
 * Architecture.png): users, auth_sessions, sessions, traces, checkins,
 * incidents, notification_jobs.
 *
 * Deliberately absent: IP addresses, OAuth access/refresh tokens, and
 * location coordinates outside an active incident (lifecycle/location.ts).
 */

export const PROVIDER_IDS = ["google", "github", "apple", "microsoft"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Identity {
  provider: ProviderId;
  /** The provider's stable user id (OIDC `sub`, or GitHub's numeric id). */
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
}

/** Synthetic people with no YTC account. Alerts to them go through the simulated transport. */
export interface BackupContact {
  id: string; // con_<uuid>
  name: string;
  relation: string;
}

export interface ParticipantDoc {
  participantId: string; // par_<uuid>, the id used in timeline events
  userId: string;
  displayName: string;
  role: "host" | "participant";
  joinedAt: Date;
  leftAt: Date | null;
  consent: ParticipantConsent;
  backupContacts: BackupContact[];
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

export type EscalationLevel = "host" | "backup" | "emergency_simulated";

export interface EscalationStep {
  level: EscalationLevel;
  recipients: Recipient[];
  /** When this step fires if nobody has acknowledged. Set when the previous step is notified. */
  dueAt: Date | null;
  notifiedAt: Date | null;
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
  openedAt: Date;
  status: IncidentStatus;
  /** `${sessionId}:${participantId}` while open or acknowledged, so a person has at most one active incident. */
  activeKey: string | null;
  steps: EscalationStep[];
  currentStep: number;
  acknowledged: { byUserId: string; name: string; at: Date } | null;
  resolved: { byUserId: string; name: string; at: Date; outcome: "false_alarm" | "assistance_reached" | "other" } | null;
  log: IncidentLogEntry[];
}

// ── Alert orchestration ────────────────────────────────────────────────

export type JobStatus = "queued" | "sending" | "delivered" | "failed" | "cancelled";

/** One alert to one recipient for one escalation step. `dedupeKey` is unique: never sent twice. */
export interface NotificationJobDoc {
  _id: string; // ntf_<uuid>
  dedupeKey: string; // `${incidentId}:${stepIndex}:${recipientKey}`
  incidentId: string;
  sessionId: string;
  stepIndex: number;
  level: EscalationLevel;
  recipient: Recipient;
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
}
