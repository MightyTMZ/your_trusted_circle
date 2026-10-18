/**
 * Persistence boundary. Routes and the scheduler talk only to this
 * interface, so the same behaviour runs on MongoDB (mongo.ts) and in memory
 * for tests (memory.ts).
 *
 * Methods that move state forward ("transition", "claim", "insert...IfAbsent")
 * are compare-and-set: they return false if another worker got there first.
 * That is what makes "exactly one alert per recipient per step" hold even
 * if two scheduler passes overlap.
 */
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import type {
  AuthSessionDoc,
  ContactInviteDoc,
  CheckInDoc,
  CheckInStatus,
  IncidentDoc,
  IncidentLogEntry,
  NotificationJobDoc,
  ParticipantConsent,
  ParticipantDoc,
  IdentityProvider,
  SessionDoc,
  SessionRules,
  TraceDoc,
  UserDoc,
} from "../types.js";

export interface DeletionCounts {
  traces: number;
  authSessions: number;
  sessionsDeleted: number;
  sessionsLeft: number;
  checkIns: number;
  incidents: number;
  notifications: number;
  rawRecordings: number;
}

export type ParticipantPatch = Partial<Pick<ParticipantDoc, "consent" | "consentTextVersion" | "consentUpdatedAt" | "leftAt" | "lastHeartbeatAt" | "deviceOnline">>;

export interface Store {
  // users and sign-in
  findUserByIdentity(provider: IdentityProvider, subject: string): Promise<UserDoc | null>;
  getUser(id: string): Promise<UserDoc | null>;
  insertUser(user: UserDoc): Promise<void>;
  updateUser(id: string, patch: Partial<Pick<UserDoc, "displayName" | "avatar" | "email" | "emailVerified">>, now: Date): Promise<void>;
  insertAuthSession(session: AuthSessionDoc): Promise<void>;
  getAuthSession(tokenHash: string): Promise<AuthSessionDoc | null>;
  deleteAuthSession(tokenHash: string): Promise<void>;
  listAuthSessions(userId: string): Promise<AuthSessionDoc[]>;

  // session lifecycle
  insertSession(session: SessionDoc): Promise<void>;
  getSession(id: string): Promise<SessionDoc | null>;
  getSessionByCode(code: string): Promise<SessionDoc | null>;
  isCodeTaken(code: string): Promise<boolean>;
  listSessionsForUser(userId: string): Promise<SessionDoc[]>;
  listActiveSessions(): Promise<SessionDoc[]>;
  /** Adds the participant unless that user is already in the session or it is full. */
  addParticipant(sessionId: string, participant: ParticipantDoc, maxParticipants: number): Promise<boolean>;
  updateParticipant(sessionId: string, participantId: string, patch: ParticipantPatch): Promise<void>;
  setParticipantConsent(sessionId: string, participantId: string, consent: ParticipantConsent): Promise<void>;
  setSessionRules(sessionId: string, rules: SessionRules): Promise<void>;
  /** active -> ended. Returns false if it had already ended. */
  endSession(sessionId: string, reason: SessionDoc["endedReason"], at: Date): Promise<boolean>;
  setSessionSuspended(sessionId: string, at: Date | null): Promise<void>;
  /** Attaches an account to a backup contact. False if it already has one. */
  linkBackupContact(sessionId: string, participantId: string, contactId: string, userId: string): Promise<boolean>;

  // contact invites
  insertContactInvite(invite: ContactInviteDoc): Promise<void>;
  getContactInvite(tokenHash: string): Promise<ContactInviteDoc | null>;
  acceptContactInvite(tokenHash: string, userId: string): Promise<boolean>;

  // server timeline (append-only, hash-chained per session)
  /** False if that seq is already taken (another writer appended first). */
  insertTimelineEvent(event: TimelineEvent): Promise<boolean>;
  listTimelineEvents(sessionId: string): Promise<TimelineEvent[]>;
  countTimelineEvents(sessionId: string): Promise<number>;
  /** Replaces a session's whole timeline, after an account deletion re-seals it. */
  replaceTimeline(sessionId: string, events: TimelineEvent[]): Promise<void>;

  // check-ins
  insertCheckIn(checkIn: CheckInDoc): Promise<void>;
  getCheckIn(id: string): Promise<CheckInDoc | null>;
  findPendingCheckIn(sessionId: string, participantId: string): Promise<CheckInDoc | null>;
  listDueCheckIns(now: Date): Promise<CheckInDoc[]>;
  listPendingCheckIns(sessionId: string): Promise<CheckInDoc[]>;
  listCheckInsForSession(sessionId: string): Promise<CheckInDoc[]>;
  transitionCheckIn(id: string, from: CheckInStatus, patch: Partial<CheckInDoc>): Promise<boolean>;

  // incidents
  /** Fails (returns false) if the person already has an active incident. */
  insertIncident(incident: IncidentDoc): Promise<boolean>;
  getIncident(id: string): Promise<IncidentDoc | null>;
  findActiveIncident(sessionId: string, participantId: string): Promise<IncidentDoc | null>;
  listOpenIncidents(): Promise<IncidentDoc[]>;
  listIncidentsForSession(sessionId: string): Promise<IncidentDoc[]>;
  updateIncident(id: string, patch: Partial<Pick<IncidentDoc, "triggerEventId" | "openedEventId">>): Promise<void>;
  /** Marks step `index` notified, if the incident is still open and the step has not been notified. */
  claimStep(id: string, index: number, at: Date, nextDueAt: Date | null): Promise<boolean>;
  /** Counts one more repeat of a step, if nobody else repeated it first. */
  claimRepeat(id: string, index: number, expectedRepeats: number): Promise<boolean>;
  acknowledgeIncident(id: string, ack: NonNullable<IncidentDoc["acknowledged"]>): Promise<boolean>;
  resolveIncident(id: string, res: NonNullable<IncidentDoc["resolved"]>): Promise<boolean>;
  /** The subject cancels their own open or acknowledged incident. Pending steps lose their deadlines. Once only. */
  cancelIncidentBySubject(id: string, res: NonNullable<IncidentDoc["resolved"]>): Promise<boolean>;
  appendIncidentLog(id: string, entry: IncidentLogEntry): Promise<void>;

  // notification jobs
  insertJobIfAbsent(job: NotificationJobDoc): Promise<boolean>;
  getJob(id: string): Promise<NotificationJobDoc | null>;
  listDueJobs(now: Date, limit: number): Promise<NotificationJobDoc[]>;
  /** Takes ownership of a due job until `leaseUntil`. */
  claimJob(id: string, now: Date, leaseUntil: Date): Promise<boolean>;
  updateJob(id: string, patch: Partial<NotificationJobDoc>, result?: NotificationJobDoc["results"][number]): Promise<void>;
  /** First view only: false if it was already viewed. */
  markJobViewed(id: string, at: Date): Promise<boolean>;
  listJobsForUser(userId: string): Promise<NotificationJobDoc[]>;
  listJobsForIncident(incidentId: string): Promise<NotificationJobDoc[]>;
  markIncidentJobsAcknowledged(incidentId: string, at: Date): Promise<void>;

  // traces and raw recordings
  insertTraces(traces: TraceDoc[]): Promise<void>;
  /** Stores the trace unless one with the same (sessionId, eventId) or (userId, clientItemId) exists. */
  insertTraceIfAbsent(trace: TraceDoc): Promise<boolean>;
  setTraceTimelineEvent(traceId: string, timelineEventId: string): Promise<void>;
  /** Raw sensor samples, kept apart from derived features (CLAUDE.md). */
  insertRawRecordingIfAbsent(doc: TraceDoc): Promise<boolean>;
  listRawRecordingsForUser(userId: string): Promise<TraceDoc[]>;
  listTracesForUser(userId: string, participantIds: string[]): Promise<TraceDoc[]>;
  listTracesForSession(sessionId: string): Promise<TraceDoc[]>;

  // retention
  /**
   * Deletes traces and raw recordings received before `cutoff`, and sessions
   * that ended before it with their check-ins, incidents, alerts, timeline and
   * invites. Sessions with an active incident are kept.
   */
  pruneBefore(cutoff: Date): Promise<{ traces: number; rawRecordings: number; sessions: number }>;
  /** Removes every record of the user. See data/account.ts for what that covers. */
  deleteUserCascade(userId: string): Promise<DeletionCounts>;
}
