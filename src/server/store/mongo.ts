/**
 * MongoDB Store: one database, one collection per document type, as in
 * docs/YTC Grand Architecture.png. Compare-and-set methods put the expected
 * state in the update filter, so concurrent workers cannot both win.
 */
import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";
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

const isDuplicateKey = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

export class MongoStore implements Store {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly users: Collection<UserDoc>,
    private readonly authSessions: Collection<AuthSessionDoc>,
    private readonly sessions: Collection<SessionDoc>,
    private readonly checkIns: Collection<CheckInDoc>,
    private readonly incidents: Collection<IncidentDoc>,
    private readonly jobs: Collection<NotificationJobDoc>,
    private readonly traces: Collection<TraceDoc>,
    private readonly rawRecordings: Collection<TraceDoc>,
    private readonly timeline: Collection<TimelineEvent>,
    private readonly invites: Collection<ContactInviteDoc>,
  ) {}

  static async connect(uri: string, dbName: string): Promise<MongoStore> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    const store = new MongoStore(
      client,
      db,
      db.collection("users"),
      db.collection("auth_sessions"),
      db.collection("sessions"),
      db.collection("checkins"),
      db.collection("incidents"),
      db.collection("notification_jobs"),
      db.collection("traces"),
      db.collection("raw_recordings"),
      db.collection("timeline_events"),
      db.collection("contact_invites"),
    );
    await store.ensureIndexes();
    return store;
  }

  /**
   * Drop every non-_id index on every collection so ensureIndexes can
   * recreate exactly the set the current schema needs. This is fine
   * because ensureIndexes runs immediately after and is idempotent.
   */
  private async dropStaleIndexes(): Promise<void> {
    const collections = [this.users, this.authSessions, this.sessions, this.checkIns, this.incidents, this.jobs, this.traces];
    for (const col of collections) {
      try {
        await col.dropIndexes();
      } catch {
        // Collection may not exist yet on first run.
      }
      // Remove any collection-level JSON Schema validators from earlier migrations.
      try {
        await this.db.command({ collMod: col.collectionName, validator: {}, validationLevel: "off" });
      } catch {
        // Collection may not exist yet.
      }
    }
  }

  private async ensureIndexes(): Promise<void> {
    // Drop stale indexes left over from earlier schema versions. They conflict
    // with the current schema because documents lack the old fields, causing
    // unique-index violations on null values.
    await this.dropStaleIndexes();

    await Promise.all([
      this.users.createIndex({ "identities.provider": 1, "identities.subject": 1 }, { unique: true }),
      this.authSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.authSessions.createIndex({ userId: 1 }),
      this.sessions.createIndex({ code: 1 }, { unique: true }),
      this.sessions.createIndex({ "participants.userId": 1 }),
      this.sessions.createIndex({ status: 1 }),
      this.checkIns.createIndex({ status: 1, dueAt: 1 }),
      this.checkIns.createIndex({ sessionId: 1, participantId: 1 }),
      // At most one active incident per person per session.
      this.incidents.createIndex({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: "string" } } }),
      this.incidents.createIndex({ status: 1 }, { name: "ix_status" }),
      this.incidents.createIndex({ sessionId: 1 }),
      // Never two jobs for the same recipient and step.
      this.jobs.createIndex({ dedupeKey: 1 }, { unique: true }),
      this.jobs.createIndex({ status: 1, nextAttemptAt: 1 }),
      this.jobs.createIndex({ "recipient.userId": 1 }),
      this.jobs.createIndex({ incidentId: 1 }),
      this.traces.createIndex({ userId: 1, receivedAt: 1 }),
      this.traces.createIndex({ subjectParticipantId: 1 }),
      this.traces.createIndex({ sessionId: 1, receivedAt: 1 }),
      this.traces.createIndex({ receivedAt: 1 }),
      // A resent event or item is stored once.
      this.traces.createIndex({ sessionId: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: "string" } } }),
      this.traces.createIndex({ userId: 1, clientItemId: 1 }, { unique: true, partialFilterExpression: { clientItemId: { $type: "string" } } }),
      this.rawRecordings.createIndex({ userId: 1, receivedAt: 1 }),
      this.rawRecordings.createIndex({ receivedAt: 1 }),
      this.rawRecordings.createIndex({ userId: 1, clientItemId: 1 }, { unique: true, partialFilterExpression: { clientItemId: { $type: "string" } } }),
      // One event per position in each session's hash chain.
      this.timeline.createIndex({ session_id: 1, seq: 1 }, { unique: true }),
      this.timeline.createIndex({ event_id: 1 }, { unique: true }),
      this.invites.createIndex({ sessionId: 1 }),
    ]);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  // users and sign-in
  findUserByIdentity(provider: string, subject: string) {
    return this.users.findOne({ identities: { $elemMatch: { provider, subject } } } as never);
  }
  getUser(id: string) {
    return this.users.findOne({ _id: id });
  }
  async insertUser(user: UserDoc) {
    await this.users.insertOne(user);
  }
  async updateUser(id: string, patch: Partial<UserDoc>, now: Date) {
    await this.users.updateOne({ _id: id }, { $set: { ...patch, updatedAt: now } });
  }
  async insertAuthSession(s: AuthSessionDoc) {
    await this.authSessions.insertOne(s);
  }
  getAuthSession(hash: string) {
    return this.authSessions.findOne({ _id: hash });
  }
  async deleteAuthSession(hash: string) {
    await this.authSessions.deleteOne({ _id: hash });
  }
  listAuthSessions(userId: string) {
    return this.authSessions.find({ userId }).toArray();
  }

  // session lifecycle
  async insertSession(s: SessionDoc) {
    await this.sessions.insertOne(s);
  }
  getSession(id: string) {
    return this.sessions.findOne({ _id: id });
  }
  getSessionByCode(code: string) {
    return this.sessions.findOne({ code });
  }
  async isCodeTaken(code: string) {
    return (await this.sessions.countDocuments({ code }, { limit: 1 })) > 0;
  }
  listSessionsForUser(userId: string) {
    return this.sessions.find({ "participants.userId": userId }).toArray();
  }
  listActiveSessions() {
    return this.sessions.find({ status: "active" }).toArray();
  }
  async addParticipant(sessionId: string, participant: ParticipantDoc, maxParticipants: number) {
    const result = await this.sessions.updateOne(
      {
        _id: sessionId,
        "participants.userId": { $ne: participant.userId },
        $expr: {
          $lt: [{ $size: { $filter: { input: "$participants", cond: { $eq: ["$$this.leftAt", null] } } } }, maxParticipants],
        },
      },
      { $push: { participants: participant } },
    );
    return result.modifiedCount === 1;
  }
  async updateParticipant(sessionId: string, participantId: string, patch: ParticipantPatch) {
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`participants.$.${k}`, v]));
    if (Object.keys(set).length === 0) return;
    await this.sessions.updateOne({ _id: sessionId, "participants.participantId": participantId }, { $set: set });
  }
  setParticipantConsent(sessionId: string, participantId: string, consent: ParticipantDoc["consent"]) {
    return this.updateParticipant(sessionId, participantId, { consent });
  }
  async setSessionRules(sessionId: string, rules: SessionDoc["rules"]) {
    await this.sessions.updateOne({ _id: sessionId }, { $set: { rules } });
  }
  async endSession(sessionId: string, reason: SessionDoc["endedReason"], at: Date) {
    const r = await this.sessions.updateOne(
      { _id: sessionId, status: "active" },
      { $set: { status: "ended", endedReason: reason, endedAt: at } },
    );
    return r.modifiedCount === 1;
  }

  async setSessionSuspended(sessionId: string, at: Date | null) {
    await this.sessions.updateOne({ _id: sessionId }, { $set: { suspendedAt: at } });
  }
  async linkBackupContact(sessionId: string, participantId: string, contactId: string, userId: string) {
    const r = await this.sessions.updateOne(
      { _id: sessionId },
      { $set: { "participants.$[p].backupContacts.$[c].userId": userId } },
      { arrayFilters: [{ "p.participantId": participantId }, { "c.id": contactId, "c.userId": null }] },
    );
    return r.modifiedCount === 1;
  }

  // contact invites
  async insertContactInvite(invite: ContactInviteDoc) {
    await this.invites.insertOne(invite);
  }
  getContactInvite(hash: string) {
    return this.invites.findOne({ _id: hash });
  }
  async acceptContactInvite(hash: string, userId: string) {
    const r = await this.invites.updateOne({ _id: hash, acceptedByUserId: null }, { $set: { acceptedByUserId: userId } });
    return r.modifiedCount === 1;
  }

  // Server timeline. Mongo's own _id is never read back: the timeline validator rejects unknown fields.
  async insertTimelineEvent(event: TimelineEvent) {
    try {
      await this.timeline.insertOne({ ...event });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }
  listTimelineEvents(sessionId: string) {
    return this.timeline.find({ session_id: sessionId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray() as Promise<TimelineEvent[]>;
  }
  countTimelineEvents(sessionId: string) {
    return this.timeline.countDocuments({ session_id: sessionId });
  }
  async replaceTimeline(sessionId: string, events: TimelineEvent[]) {
    await this.timeline.deleteMany({ session_id: sessionId });
    if (events.length > 0) await this.timeline.insertMany(events.map((e) => ({ ...e })), { ordered: true });
  }

  // check-ins
  async insertCheckIn(c: CheckInDoc) {
    await this.checkIns.insertOne(c);
  }
  getCheckIn(id: string) {
    return this.checkIns.findOne({ _id: id });
  }
  findPendingCheckIn(sessionId: string, participantId: string) {
    return this.checkIns.findOne({ sessionId, participantId, status: "pending" });
  }
  listDueCheckIns(now: Date) {
    return this.checkIns.find({ status: "pending", dueAt: { $lte: now } }).toArray();
  }
  listPendingCheckIns(sessionId: string) {
    return this.checkIns.find({ sessionId, status: "pending" }).toArray();
  }
  listCheckInsForSession(sessionId: string) {
    return this.checkIns.find({ sessionId }).sort({ promptedAt: 1 }).toArray();
  }
  async transitionCheckIn(id: string, from: CheckInStatus, patch: Partial<CheckInDoc>) {
    const r = await this.checkIns.updateOne({ _id: id, status: from }, { $set: patch });
    return r.modifiedCount === 1;
  }

  // incidents
  async insertIncident(i: IncidentDoc) {
    try {
      await this.incidents.insertOne(i);
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }
  getIncident(id: string) {
    return this.incidents.findOne({ _id: id });
  }
  findActiveIncident(sessionId: string, participantId: string) {
    return this.incidents.findOne({ activeKey: `${sessionId}:${participantId}` });
  }
  listOpenIncidents() {
    return this.incidents.find({ status: "open" }).toArray();
  }
  listIncidentsForSession(sessionId: string) {
    return this.incidents.find({ sessionId }).sort({ openedAt: 1 }).toArray();
  }
  async updateIncident(id: string, patch: Partial<IncidentDoc>) {
    await this.incidents.updateOne({ _id: id }, { $set: patch });
  }
  async claimRepeat(id: string, index: number, expectedRepeats: number) {
    const field = `steps.${index}.repeats`;
    const r = await this.incidents.updateOne({ _id: id, [field]: expectedRepeats } as never, { $inc: { [field]: 1 } } as never);
    return r.modifiedCount === 1;
  }
  async claimStep(id: string, index: number, at: Date, nextDueAt: Date | null) {
    const set: Record<string, unknown> = { [`steps.${index}.notifiedAt`]: at, currentStep: index };
    set[`steps.${index + 1}.dueAt`] = nextDueAt;
    const filter = { _id: id, status: "open", [`steps.${index}.notifiedAt`]: null } as never;
    // Only set the next step's deadline if that step exists.
    const incident = await this.incidents.findOne({ _id: id }, { projection: { steps: 1 } });
    if (!incident || !incident.steps[index + 1]) delete set[`steps.${index + 1}.dueAt`];
    const r = await this.incidents.updateOne(filter, { $set: set });
    return r.modifiedCount === 1;
  }
  async acknowledgeIncident(id: string, ack: NonNullable<IncidentDoc["acknowledged"]>) {
    const r = await this.incidents.updateOne({ _id: id, status: "open" }, { $set: { status: "acknowledged", acknowledged: ack } });
    if (r.modifiedCount !== 1) return false;
    // Pending steps lose their deadlines: escalation stops.
    await this.incidents.updateOne({ _id: id }, { $set: { "steps.$[pending].dueAt": null } }, { arrayFilters: [{ "pending.notifiedAt": null }] });
    return true;
  }
  async resolveIncident(id: string, res: NonNullable<IncidentDoc["resolved"]>) {
    const r = await this.incidents.updateOne(
      { _id: id, status: "acknowledged" },
      { $set: { status: "resolved", resolved: res, activeKey: null } },
    );
    return r.modifiedCount === 1;
  }
  async cancelIncidentBySubject(id: string, res: NonNullable<IncidentDoc["resolved"]>) {
    const r = await this.incidents.updateOne(
      { _id: id, status: { $in: ["open", "acknowledged"] } },
      { $set: { status: "resolved", resolved: res, activeKey: null } },
    );
    if (r.modifiedCount !== 1) return false;
    await this.incidents.updateOne({ _id: id }, { $set: { "steps.$[pending].dueAt": null } }, { arrayFilters: [{ "pending.notifiedAt": null }] });
    return true;
  }
  async appendIncidentLog(id: string, entry: IncidentLogEntry) {
    await this.incidents.updateOne({ _id: id }, { $push: { log: entry } });
  }

  // notification jobs
  async insertJobIfAbsent(job: NotificationJobDoc) {
    try {
      await this.jobs.insertOne(job);
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }
  getJob(id: string) {
    return this.jobs.findOne({ _id: id });
  }
  private dueFilter(now: Date) {
    return {
      $or: [
        { status: "queued" as const, nextAttemptAt: { $lte: now } },
        { status: "sending" as const, leaseUntil: { $lte: now } },
      ],
    };
  }
  listDueJobs(now: Date, limit: number) {
    return this.jobs.find(this.dueFilter(now)).sort({ nextAttemptAt: 1 }).limit(limit).toArray();
  }
  async claimJob(id: string, now: Date, leaseUntil: Date) {
    const r = await this.jobs.updateOne({ _id: id, ...this.dueFilter(now) }, { $set: { status: "sending", leaseUntil } });
    return r.modifiedCount === 1;
  }
  async updateJob(id: string, patch: Partial<NotificationJobDoc>, result?: NotificationJobDoc["results"][number]) {
    await this.jobs.updateOne({ _id: id }, { $set: patch, ...(result ? { $push: { results: result } } : {}) });
  }
  async markJobViewed(id: string, at: Date) {
    const r = await this.jobs.updateOne({ _id: id, viewedAt: null }, { $set: { viewedAt: at } });
    return r.modifiedCount === 1;
  }
  listJobsForUser(userId: string) {
    return this.jobs.find({ "recipient.kind": "user", "recipient.userId": userId }).sort({ createdAt: -1 }).toArray();
  }
  listJobsForIncident(incidentId: string) {
    return this.jobs.find({ incidentId }).sort({ createdAt: 1 }).toArray();
  }
  async markIncidentJobsAcknowledged(incidentId: string, at: Date) {
    await this.jobs.updateMany({ incidentId, acknowledgedAt: null }, { $set: { acknowledgedAt: at } });
  }

  // traces
  async insertTraces(traces: TraceDoc[]) {
    if (traces.length > 0) await this.traces.insertMany(traces, { ordered: true });
  }
  private async insertIfAbsent(col: Collection<TraceDoc>, doc: TraceDoc) {
    try {
      await col.insertOne(doc);
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }
  insertTraceIfAbsent(doc: TraceDoc) {
    return this.insertIfAbsent(this.traces, doc);
  }
  async setTraceTimelineEvent(traceId: string, timelineEventId: string) {
    await this.traces.updateOne({ _id: traceId }, { $set: { timelineEventId } });
  }
  insertRawRecordingIfAbsent(doc: TraceDoc) {
    return this.insertIfAbsent(this.rawRecordings, doc);
  }
  listRawRecordingsForUser(userId: string) {
    return this.rawRecordings.find({ userId }).sort({ receivedAt: 1 }).toArray();
  }
  listTracesForUser(userId: string, participantIds: string[]) {
    return this.traces.find({ $or: [{ userId }, { subjectParticipantId: { $in: participantIds } }] }).sort({ receivedAt: 1 }).toArray();
  }
  listTracesForSession(sessionId: string) {
    return this.traces.find({ sessionId }).sort({ receivedAt: 1 }).toArray();
  }

  // retention
  private async dropSessionData(sessionIds: string[]) {
    await Promise.all([
      this.checkIns.deleteMany({ sessionId: { $in: sessionIds } }),
      this.incidents.deleteMany({ sessionId: { $in: sessionIds } }),
      this.jobs.deleteMany({ sessionId: { $in: sessionIds } }),
      this.invites.deleteMany({ sessionId: { $in: sessionIds } }),
      this.timeline.deleteMany({ session_id: { $in: sessionIds } }),
    ]);
    return (await this.sessions.deleteMany({ _id: { $in: sessionIds } })).deletedCount;
  }
  async pruneBefore(cutoff: Date) {
    const traces = await this.traces.deleteMany({ receivedAt: { $lt: cutoff } });
    const raw = await this.rawRecordings.deleteMany({ receivedAt: { $lt: cutoff } });
    const busy = await this.incidents.distinct("sessionId", { activeKey: { $type: "string" } });
    const old = await this.sessions
      .find({
        _id: { $nin: busy },
        $or: [{ status: "ended", endedAt: { $lt: cutoff } }, { status: "active", expiresAt: { $lt: cutoff } }],
      })
      .project<{ _id: string }>({ _id: 1 })
      .toArray();
    const sessions = await this.dropSessionData(old.map((s) => s._id));
    return { traces: traces.deletedCount, rawRecordings: raw.deletedCount, sessions };
  }

  /** Data first, the user last, so a failure part-way can simply be retried. */
  async deleteUserCascade(userId: string): Promise<DeletionCounts> {
    const mine = await this.listSessionsForUser(userId);
    const participantIds = mine.flatMap((s) => s.participants.filter((p) => p.userId === userId).map((p) => p.participantId));
    const hosted = mine.filter((s) => s.hostUserId === userId).map((s) => s._id);

    const traces = await this.traces.deleteMany({
      $or: [{ userId }, { subjectParticipantId: { $in: participantIds } }, { sessionId: { $in: hosted } }],
    });
    const raw = await this.rawRecordings.deleteMany({ $or: [{ userId }, { subjectParticipantId: { $in: participantIds } }] });
    await this.invites.deleteMany({
      $or: [{ acceptedByUserId: userId }, { participantId: { $in: participantIds } }, { sessionId: { $in: hosted } }],
    });
    await this.timeline.deleteMany({ session_id: { $in: hosted } });
    const checkIns = await this.checkIns.deleteMany({ $or: [{ participantId: { $in: participantIds } }, { sessionId: { $in: hosted } }] });
    const incidents = await this.incidents.deleteMany({ $or: [{ participantId: { $in: participantIds } }, { sessionId: { $in: hosted } }] });
    const jobs = await this.jobs.deleteMany({
      $or: [{ "recipient.userId": userId }, { subjectUserId: userId }, { sessionId: { $in: hosted } }],
    });
    const deletedSessions = await this.sessions.deleteMany({ _id: { $in: hosted } });
    const left = await this.sessions.updateMany({ "participants.userId": userId }, { $pull: { participants: { userId } } });
    // Stop being anyone's linked backup contact.
    await this.sessions.updateMany(
      { "participants.backupContacts.userId": userId },
      { $set: { "participants.$[].backupContacts.$[c].userId": null } },
      { arrayFilters: [{ "c.userId": userId }] },
    );
    const auth = await this.authSessions.deleteMany({ userId });
    await this.users.deleteOne({ _id: userId });
    return {
      traces: traces.deletedCount,
      authSessions: auth.deletedCount,
      sessionsDeleted: deletedSessions.deletedCount,
      sessionsLeft: left.modifiedCount,
      checkIns: checkIns.deletedCount,
      incidents: incidents.deletedCount,
      notifications: jobs.deletedCount,
      rawRecordings: raw.deletedCount,
    };
  }
}
