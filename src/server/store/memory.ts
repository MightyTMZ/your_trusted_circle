/** In-memory Store for tests and for running the API without MongoDB. Not durable. */
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import type { DeletionCounts, ParticipantPatch, Store } from "./store.js";
import type {
  AuthSessionDoc,
  CheckInDoc,
  CheckInStatus,
  ContactInviteDoc,
  IncidentDoc,
  IncidentLogEntry,
  NotificationJobDoc,
  ParticipantDoc,
  SessionDoc,
  TraceDoc,
  UserDoc,
} from "../types.js";

const clone = <T>(value: T): T => structuredClone(value);
const t = (d: Date | null) => (d ? d.getTime() : Number.NaN);

export class MemoryStore implements Store {
  readonly users = new Map<string, UserDoc>();
  readonly authSessions = new Map<string, AuthSessionDoc>();
  readonly sessions = new Map<string, SessionDoc>();
  readonly checkIns = new Map<string, CheckInDoc>();
  readonly incidents = new Map<string, IncidentDoc>();
  readonly jobs = new Map<string, NotificationJobDoc>();
  readonly invites = new Map<string, ContactInviteDoc>();
  readonly timelines = new Map<string, TimelineEvent[]>();
  readonly traces: TraceDoc[] = [];
  readonly rawRecordings: TraceDoc[] = [];

  private participant(sessionId: string, participantId: string): ParticipantDoc | undefined {
    return this.sessions.get(sessionId)?.participants.find((p) => p.participantId === participantId);
  }

  // users and sign-in
  async findUserByIdentity(provider: string, subject: string) {
    const user = [...this.users.values()].find((u) => u.identities.some((i) => i.provider === provider && i.subject === subject));
    return user ? clone(user) : null;
  }
  async getUser(id: string) {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }
  async insertUser(user: UserDoc) {
    this.users.set(user._id, clone(user));
  }
  async updateUser(id: string, patch: Partial<UserDoc>, now: Date) {
    const u = this.users.get(id);
    if (u) Object.assign(u, clone(patch), { updatedAt: now });
  }
  async insertAuthSession(s: AuthSessionDoc) {
    this.authSessions.set(s._id, clone(s));
  }
  async getAuthSession(hash: string) {
    const s = this.authSessions.get(hash);
    return s ? clone(s) : null;
  }
  async deleteAuthSession(hash: string) {
    this.authSessions.delete(hash);
  }
  async listAuthSessions(userId: string) {
    return [...this.authSessions.values()].filter((s) => s.userId === userId).map(clone);
  }

  // session lifecycle
  async insertSession(s: SessionDoc) {
    this.sessions.set(s._id, clone(s));
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }
  async getSessionByCode(code: string) {
    const s = [...this.sessions.values()].find((x) => x.code === code);
    return s ? clone(s) : null;
  }
  async isCodeTaken(code: string) {
    return [...this.sessions.values()].some((s) => s.code === code);
  }
  async listSessionsForUser(userId: string) {
    return [...this.sessions.values()].filter((s) => s.participants.some((p) => p.userId === userId)).map(clone);
  }
  async listActiveSessions() {
    return [...this.sessions.values()].filter((s) => s.status === "active").map(clone);
  }
  async addParticipant(sessionId: string, participant: ParticipantDoc, maxParticipants: number) {
    const s = this.sessions.get(sessionId);
    if (!s || s.participants.some((p) => p.userId === participant.userId)) return false;
    if (s.participants.filter((p) => p.leftAt === null).length >= maxParticipants) return false;
    s.participants.push(clone(participant));
    return true;
  }
  async updateParticipant(sessionId: string, participantId: string, patch: ParticipantPatch) {
    const p = this.participant(sessionId, participantId);
    if (p) Object.assign(p, clone(patch));
  }
  async setParticipantConsent(sessionId: string, participantId: string, consent: ParticipantDoc["consent"]) {
    await this.updateParticipant(sessionId, participantId, { consent });
  }
  async setSessionRules(sessionId: string, rules: SessionDoc["rules"]) {
    const s = this.sessions.get(sessionId);
    if (s) s.rules = clone(rules);
  }
  async endSession(sessionId: string, reason: SessionDoc["endedReason"], at: Date) {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== "active") return false;
    Object.assign(s, { status: "ended", endedReason: reason, endedAt: at });
    return true;
  }
  async setSessionSuspended(sessionId: string, at: Date | null) {
    const s = this.sessions.get(sessionId);
    if (s) s.suspendedAt = at;
  }
  async linkBackupContact(sessionId: string, participantId: string, contactId: string, userId: string) {
    const c = this.participant(sessionId, participantId)?.backupContacts.find((x) => x.id === contactId);
    if (!c || c.userId !== null) return false;
    c.userId = userId;
    return true;
  }

  // contact invites
  async insertContactInvite(invite: ContactInviteDoc) {
    this.invites.set(invite._id, clone(invite));
  }
  async getContactInvite(hash: string) {
    const i = this.invites.get(hash);
    return i ? clone(i) : null;
  }
  async acceptContactInvite(hash: string, userId: string) {
    const i = this.invites.get(hash);
    if (!i || i.acceptedByUserId !== null) return false;
    i.acceptedByUserId = userId;
    return true;
  }

  // server timeline
  async insertTimelineEvent(event: TimelineEvent) {
    const list = this.timelines.get(event.session_id) ?? [];
    if (list.some((e) => e.seq === event.seq || e.event_id === event.event_id)) return false;
    list.push(clone(event));
    this.timelines.set(event.session_id, list);
    return true;
  }
  async listTimelineEvents(sessionId: string) {
    return (this.timelines.get(sessionId) ?? []).slice().sort((a, b) => a.seq - b.seq).map(clone);
  }
  async countTimelineEvents(sessionId: string) {
    return this.timelines.get(sessionId)?.length ?? 0;
  }
  async replaceTimeline(sessionId: string, events: TimelineEvent[]) {
    if (events.length === 0) this.timelines.delete(sessionId);
    else this.timelines.set(sessionId, events.map(clone));
  }

  // check-ins
  async insertCheckIn(c: CheckInDoc) {
    this.checkIns.set(c._id, clone(c));
  }
  async getCheckIn(id: string) {
    const c = this.checkIns.get(id);
    return c ? clone(c) : null;
  }
  async findPendingCheckIn(sessionId: string, participantId: string) {
    const c = [...this.checkIns.values()].find((x) => x.sessionId === sessionId && x.participantId === participantId && x.status === "pending");
    return c ? clone(c) : null;
  }
  async listDueCheckIns(now: Date) {
    return [...this.checkIns.values()].filter((c) => c.status === "pending" && t(c.dueAt) <= now.getTime()).map(clone);
  }
  async listPendingCheckIns(sessionId: string) {
    return [...this.checkIns.values()].filter((c) => c.sessionId === sessionId && c.status === "pending").map(clone);
  }
  async listCheckInsForSession(sessionId: string) {
    return [...this.checkIns.values()].filter((c) => c.sessionId === sessionId).map(clone);
  }
  async transitionCheckIn(id: string, from: CheckInStatus, patch: Partial<CheckInDoc>) {
    const c = this.checkIns.get(id);
    if (!c || c.status !== from) return false;
    Object.assign(c, clone(patch));
    return true;
  }

  // incidents
  async insertIncident(i: IncidentDoc) {
    if (i.activeKey && [...this.incidents.values()].some((x) => x.activeKey === i.activeKey)) return false;
    this.incidents.set(i._id, clone(i));
    return true;
  }
  async getIncident(id: string) {
    const i = this.incidents.get(id);
    return i ? clone(i) : null;
  }
  async findActiveIncident(sessionId: string, participantId: string) {
    const i = [...this.incidents.values()].find((x) => x.activeKey === `${sessionId}:${participantId}`);
    return i ? clone(i) : null;
  }
  async listOpenIncidents() {
    return [...this.incidents.values()].filter((i) => i.status === "open").map(clone);
  }
  async listIncidentsForSession(sessionId: string) {
    return [...this.incidents.values()].filter((i) => i.sessionId === sessionId).map(clone);
  }
  async updateIncident(id: string, patch: Partial<IncidentDoc>) {
    const i = this.incidents.get(id);
    if (i) Object.assign(i, clone(patch));
  }
  async claimStep(id: string, index: number, at: Date, nextDueAt: Date | null) {
    const i = this.incidents.get(id);
    const step = i?.steps[index];
    if (!i || !step || i.status !== "open" || step.notifiedAt !== null) return false;
    step.notifiedAt = at;
    i.currentStep = index;
    const next = i.steps[index + 1];
    if (next) next.dueAt = nextDueAt;
    return true;
  }
  async claimRepeat(id: string, index: number, expectedRepeats: number) {
    const step = this.incidents.get(id)?.steps[index];
    if (!step || step.repeats !== expectedRepeats) return false;
    step.repeats++;
    return true;
  }
  async acknowledgeIncident(id: string, ack: NonNullable<IncidentDoc["acknowledged"]>) {
    const i = this.incidents.get(id);
    if (!i || i.status !== "open") return false;
    i.status = "acknowledged";
    i.acknowledged = clone(ack);
    for (const s of i.steps) if (s.notifiedAt === null) s.dueAt = null;
    return true;
  }
  async resolveIncident(id: string, res: NonNullable<IncidentDoc["resolved"]>) {
    const i = this.incidents.get(id);
    if (!i || i.status !== "acknowledged") return false;
    Object.assign(i, { status: "resolved", resolved: clone(res), activeKey: null });
    return true;
  }
  async cancelIncidentBySubject(id: string, res: NonNullable<IncidentDoc["resolved"]>) {
    const i = this.incidents.get(id);
    if (!i || i.status === "resolved") return false;
    for (const s of i.steps) if (s.notifiedAt === null) s.dueAt = null;
    Object.assign(i, { status: "resolved", resolved: clone(res), activeKey: null });
    return true;
  }
  async appendIncidentLog(id: string, entry: IncidentLogEntry) {
    this.incidents.get(id)?.log.push(clone(entry));
  }

  // notification jobs
  async insertJobIfAbsent(job: NotificationJobDoc) {
    if ([...this.jobs.values()].some((j) => j.dedupeKey === job.dedupeKey)) return false;
    this.jobs.set(job._id, clone(job));
    return true;
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }
  private due(j: NotificationJobDoc, now: number) {
    return (j.status === "queued" && t(j.nextAttemptAt) <= now) || (j.status === "sending" && t(j.leaseUntil) <= now);
  }
  async listDueJobs(now: Date, limit: number) {
    return [...this.jobs.values()].filter((j) => this.due(j, now.getTime())).slice(0, limit).map(clone);
  }
  async claimJob(id: string, now: Date, leaseUntil: Date) {
    const j = this.jobs.get(id);
    if (!j || !this.due(j, now.getTime())) return false;
    Object.assign(j, { status: "sending", leaseUntil });
    return true;
  }
  async updateJob(id: string, patch: Partial<NotificationJobDoc>, result?: NotificationJobDoc["results"][number]) {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, clone(patch));
    if (result) j.results.push(clone(result));
  }
  async markJobViewed(id: string, at: Date) {
    const j = this.jobs.get(id);
    if (!j || j.viewedAt !== null) return false;
    j.viewedAt = at;
    return true;
  }
  async listJobsForUser(userId: string) {
    return [...this.jobs.values()].filter((j) => j.recipient.kind === "user" && j.recipient.userId === userId).map(clone);
  }
  async listJobsForIncident(incidentId: string) {
    return [...this.jobs.values()].filter((j) => j.incidentId === incidentId).map(clone);
  }
  async markIncidentJobsAcknowledged(incidentId: string, at: Date) {
    for (const j of this.jobs.values()) if (j.incidentId === incidentId && j.acknowledgedAt === null) j.acknowledgedAt = at;
  }

  // traces and raw recordings
  async insertTraces(traces: TraceDoc[]) {
    this.traces.push(...traces.map(clone));
  }
  private duplicate(list: TraceDoc[], doc: TraceDoc) {
    return list.some(
      (x) =>
        (doc.eventId !== null && x.sessionId === doc.sessionId && x.eventId === doc.eventId) ||
        (doc.clientItemId !== null && x.userId === doc.userId && x.clientItemId === doc.clientItemId),
    );
  }
  async insertTraceIfAbsent(doc: TraceDoc) {
    if (this.duplicate(this.traces, doc)) return false;
    this.traces.push(clone(doc));
    return true;
  }
  async setTraceTimelineEvent(traceId: string, timelineEventId: string) {
    const tr = this.traces.find((x) => x._id === traceId);
    if (tr) tr.timelineEventId = timelineEventId;
  }
  async insertRawRecordingIfAbsent(doc: TraceDoc) {
    if (this.duplicate(this.rawRecordings, doc)) return false;
    this.rawRecordings.push(clone(doc));
    return true;
  }
  async listRawRecordingsForUser(userId: string) {
    return this.rawRecordings.filter((r) => r.userId === userId).map(clone);
  }
  private aboutUser(tr: TraceDoc, userId: string, participantIds: string[]) {
    return tr.userId === userId || (tr.subjectParticipantId !== null && participantIds.includes(tr.subjectParticipantId));
  }
  async listTracesForUser(userId: string, participantIds: string[]) {
    return this.traces.filter((tr) => this.aboutUser(tr, userId, participantIds)).map(clone);
  }
  async listTracesForSession(sessionId: string) {
    return this.traces.filter((tr) => tr.sessionId === sessionId).map(clone);
  }

  // retention
  private dropSessionData(sessionIds: Set<string>) {
    for (const [id, c] of this.checkIns) if (sessionIds.has(c.sessionId)) this.checkIns.delete(id);
    for (const [id, i] of this.incidents) if (sessionIds.has(i.sessionId)) this.incidents.delete(id);
    for (const [id, j] of this.jobs) if (sessionIds.has(j.sessionId)) this.jobs.delete(id);
    for (const [id, inv] of this.invites) if (sessionIds.has(inv.sessionId)) this.invites.delete(id);
    for (const id of sessionIds) {
      this.sessions.delete(id);
      this.timelines.delete(id);
    }
  }
  private removeWhere(list: TraceDoc[], pred: (x: TraceDoc) => boolean) {
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) (list.splice(i, 1), n++);
    return n;
  }
  async pruneBefore(cutoff: Date) {
    const traces = this.removeWhere(this.traces, (x) => t(x.receivedAt) < cutoff.getTime());
    const rawRecordings = this.removeWhere(this.rawRecordings, (x) => t(x.receivedAt) < cutoff.getTime());
    const busy = new Set([...this.incidents.values()].filter((i) => i.activeKey).map((i) => i.sessionId));
    const old = new Set(
      [...this.sessions.values()]
        .filter((s) => (s.status === "ended" ? t(s.endedAt) : t(s.expiresAt)) < cutoff.getTime() && !busy.has(s._id))
        .map((s) => s._id),
    );
    this.dropSessionData(old);
    return { traces, rawRecordings, sessions: old.size };
  }

  async deleteUserCascade(userId: string): Promise<DeletionCounts> {
    const mine = [...this.sessions.values()].filter((s) => s.participants.some((p) => p.userId === userId));
    const participantIds = mine.flatMap((s) => s.participants.filter((p) => p.userId === userId).map((p) => p.participantId));
    const hosted = new Set(mine.filter((s) => s.hostUserId === userId).map((s) => s._id));

    const traces = this.removeWhere(this.traces, (x) => this.aboutUser(x, userId, participantIds) || hosted.has(x.sessionId ?? ""));
    const rawRecordings = this.removeWhere(this.rawRecordings, (x) => this.aboutUser(x, userId, participantIds));
    let checkIns = 0;
    for (const [id, c] of this.checkIns) {
      if (participantIds.includes(c.participantId) || hosted.has(c.sessionId)) (this.checkIns.delete(id), checkIns++);
    }
    let incidents = 0;
    for (const [id, i] of this.incidents) {
      if (participantIds.includes(i.participantId) || hosted.has(i.sessionId)) (this.incidents.delete(id), incidents++);
    }
    let notifications = 0;
    for (const [id, j] of this.jobs) {
      const toMe = j.recipient.kind === "user" && j.recipient.userId === userId;
      if (toMe || j.subjectUserId === userId || hosted.has(j.sessionId)) (this.jobs.delete(id), notifications++);
    }
    for (const [id, inv] of this.invites) {
      if (inv.acceptedByUserId === userId || participantIds.includes(inv.participantId) || hosted.has(inv.sessionId)) this.invites.delete(id);
    }
    for (const id of hosted) {
      this.sessions.delete(id);
      this.timelines.delete(id);
    }
    // Leave other sessions; and stop being anyone's linked backup contact.
    for (const s of this.sessions.values()) {
      s.participants = s.participants.filter((p) => p.userId !== userId);
      for (const p of s.participants) for (const c of p.backupContacts) if (c.userId === userId) c.userId = null;
    }
    let authSessions = 0;
    for (const [hash, a] of this.authSessions) if (a.userId === userId) (this.authSessions.delete(hash), authSessions++);
    this.users.delete(userId);
    return {
      traces,
      authSessions,
      sessionsDeleted: hosted.size,
      sessionsLeft: mine.length - hosted.size,
      checkIns,
      incidents,
      notifications,
      rawRecordings,
    };
  }
}
