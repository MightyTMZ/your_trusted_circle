/**
 * The Store contract, run against the in-memory store always and against a
 * real MongoDB when MONGODB_TEST_URI is set (CI starts one). It checks the
 * compare-and-set guarantees that "exactly once" and the hash chain rely on.
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../../src/server/store/memory.js";
import { MongoStore } from "../../src/server/store/mongo.js";
import type { Store } from "../../src/server/store/store.js";
import type { IncidentDoc, NotificationJobDoc, SessionDoc, TraceDoc } from "../../src/server/types.js";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import { Timeline } from "../../src/timeline/timeline.js";

const T = new Date(Date.UTC(2026, 9, 17, 22, 0, 0));
const at = (sec: number) => new Date(T.getTime() + sec * 1000);

function session(id: string, code: string): SessionDoc {
  return {
    _id: id,
    code,
    name: "Contract",
    hostUserId: "usr_host",
    status: "active",
    endedReason: null,
    createdAt: T,
    expiresAt: at(4 * 3600),
    endedAt: null,
    suspendedAt: null,
    rules: { checkInWindowSec: 60, hostAckWindowSec: 120, backupAckWindowSec: 180, locationStaleAfterSec: 90, heartbeatTimeoutSec: 120, maxParticipants: 2, allowLocationSharing: true },
    participants: [
      {
        participantId: "par_host",
        userId: "usr_host",
        displayName: "Maya",
        role: "host",
        joinedAt: T,
        leftAt: null,
        consent: { monitoring: true, locationSharing: "group", shareLocationWithResponders: true },
        consentTextVersion: "consent-v1",
        consentUpdatedAt: T,
        backupContacts: [{ id: "con_1", name: "Priya", relation: "Sister", userId: null }],
        lastHeartbeatAt: T,
        deviceOnline: true,
      },
    ],
  };
}

function incident(id: string, sessionId: string): IncidentDoc {
  return {
    _id: id,
    sessionId,
    participantId: "par_sam",
    trigger: "help_requested",
    checkInId: null,
    triggerEventId: null,
    openedEventId: null,
    openedAt: T,
    status: "open",
    activeKey: `${sessionId}:par_sam`,
    steps: [
      { escalationId: "esc_1", level: "host", recipients: [{ kind: "user", userId: "usr_host", name: "Maya" }], dueAt: null, notifiedAt: null, repeats: 0 },
      { escalationId: "esc_2", level: "emergency_simulated", recipients: [{ kind: "emergency_simulated", name: "Sim" }], dueAt: null, notifiedAt: null, repeats: 0 },
    ],
    currentStep: -1,
    acknowledged: null,
    resolved: null,
    log: [],
  };
}

function job(id: string, incidentId: string, sessionId: string): NotificationJobDoc {
  return {
    _id: id,
    dedupeKey: `${incidentId}:0:usr:usr_host`,
    incidentId,
    sessionId,
    stepIndex: 0,
    level: "host",
    repeat: 0,
    recipient: { kind: "user", userId: "usr_host", name: "Maya" },
    payload: { about: "Sam", sessionName: "Contract", trigger: "help_requested", openedAt: T, message: "m", factEventIds: [] },
    subjectUserId: "usr_sam",
    status: "queued",
    attempts: 0,
    nextAttemptAt: T,
    leaseUntil: null,
    results: [],
    createdAt: T,
    deliveredAt: null,
    viewedAt: null,
    acknowledgedAt: null,
  };
}

function trace(id: string, sessionId: string, extra: Partial<TraceDoc>): TraceDoc {
  return {
    _id: id,
    userId: "usr_sam",
    sessionId,
    participantId: "par_sam",
    subjectParticipantId: null,
    kind: "log",
    type: null,
    occurredAt: null,
    receivedAt: T,
    data: { x: 1 },
    locationRedacted: false,
    eventId: null,
    clientItemId: null,
    dataOrigin: "live_device",
    dataClass: null,
    units: null,
    timelineEventId: null,
    ...extra,
  };
}

function contract(name: string, make: () => Promise<Store>, done: () => Promise<void> = async () => {}) {
  describe(`Store contract: ${name}`, () => {
    after(done);

    test("sessions: joining is atomic, once per user, and respects the size limit", async () => {
      const store = await make();
      const sid = `ses_${randomUUID()}`;
      await store.insertSession(session(sid, randomUUID().slice(0, 6).toUpperCase()));
      const sam = { ...session(sid, "X").participants[0]!, participantId: "par_sam", userId: "usr_sam", role: "participant" as const };
      assert.equal(await store.addParticipant(sid, sam, 2), true);
      assert.equal(await store.addParticipant(sid, sam, 5), false, "same user twice");
      assert.equal(await store.addParticipant(sid, { ...sam, participantId: "par_jo", userId: "usr_jo" }, 2), false, "full");
      await store.updateParticipant(sid, "par_sam", { deviceOnline: false, consentTextVersion: "consent-v2" });
      assert.equal((await store.getSession(sid))!.participants[1]!.consentTextVersion, "consent-v2");
      assert.equal(await store.linkBackupContact(sid, "par_host", "con_1", "usr_priya"), true);
      assert.equal(await store.linkBackupContact(sid, "par_host", "con_1", "usr_other"), false, "already linked");
      await store.setSessionSuspended(sid, T);
      assert.ok((await store.getSession(sid))!.suspendedAt);
      assert.equal(await store.endSession(sid, "host_ended", T), true);
      assert.equal(await store.endSession(sid, "host_ended", T), false);
    });

    test("incidents: one active per person; each step and repeat is claimed once; acknowledge and resolve once", async () => {
      const store = await make();
      const sid = `ses_${randomUUID()}`;
      const iid = `inc_${randomUUID()}`;
      assert.equal(await store.insertIncident(incident(iid, sid)), true);
      assert.equal(await store.insertIncident(incident(`inc_${randomUUID()}`, sid)), false, "second active incident refused");
      const [a, b] = await Promise.all([store.claimStep(iid, 0, T, at(120)), store.claimStep(iid, 0, T, at(120))]);
      assert.equal(Number(a) + Number(b), 1, "exactly one worker wins the step");
      assert.equal((await store.getIncident(iid))!.steps[1]!.dueAt!.getTime(), at(120).getTime());
      assert.equal(await store.claimRepeat(iid, 0, 0), true);
      assert.equal(await store.claimRepeat(iid, 0, 0), false);
      assert.equal(await store.acknowledgeIncident(iid, { byUserId: "usr_host", name: "Maya", at: T }), true);
      assert.equal(await store.acknowledgeIncident(iid, { byUserId: "usr_host", name: "Maya", at: T }), false);
      assert.equal((await store.getIncident(iid))!.steps[1]!.dueAt, null, "pending step stopped");
      assert.equal(await store.resolveIncident(iid, { byUserId: "usr_host", name: "Maya", at: T, outcome: "other" }), true);
      assert.equal(await store.findActiveIncident(sid, "par_sam"), null);
      assert.equal(await store.insertIncident(incident(`inc_${randomUUID()}`, sid)), true, "a new incident is allowed after resolution");
    });

    test("jobs: de-duplicated, claimed once, viewed once", async () => {
      const store = await make();
      const sid = `ses_${randomUUID()}`;
      const iid = `inc_${randomUUID()}`;
      const jid = `ntf_${randomUUID()}`;
      assert.equal(await store.insertJobIfAbsent(job(jid, iid, sid)), true);
      assert.equal(await store.insertJobIfAbsent(job(`ntf_${randomUUID()}`, iid, sid)), false, "same dedupeKey");
      assert.equal((await store.listDueJobs(T, 10)).filter((j) => j._id === jid).length, 1);
      const [a, b] = await Promise.all([store.claimJob(jid, T, at(30)), store.claimJob(jid, T, at(30))]);
      assert.equal(Number(a) + Number(b), 1, "exactly one worker sends it");
      await store.updateJob(jid, { status: "delivered", deliveredAt: T }, { at: T, ok: true });
      assert.equal(await store.markJobViewed(jid, T), true);
      assert.equal(await store.markJobViewed(jid, T), false);
      assert.equal((await store.getJob(jid))!.results.length, 1);
    });

    test("traces: resends are stored once; raw samples are kept apart", async () => {
      const store = await make();
      const sid = `ses_${randomUUID()}`;
      assert.equal(await store.insertTraceIfAbsent(trace(`trc_${randomUUID()}`, sid, { kind: "event", eventId: "evt_1" })), true);
      assert.equal(await store.insertTraceIfAbsent(trace(`trc_${randomUUID()}`, sid, { kind: "event", eventId: "evt_1" })), false);
      const cid = `c-${randomUUID()}`;
      assert.equal(await store.insertTraceIfAbsent(trace(`trc_${randomUUID()}`, sid, { clientItemId: cid })), true);
      assert.equal(await store.insertTraceIfAbsent(trace(`trc_${randomUUID()}`, sid, { clientItemId: cid })), false);
      const user = `usr_${randomUUID()}`;
      assert.equal(await store.insertRawRecordingIfAbsent(trace(`trc_${randomUUID()}`, sid, { userId: user, kind: "sensor", dataClass: "raw" })), true);
      assert.equal((await store.listRawRecordingsForUser(user)).length, 1);
      assert.equal((await store.listTracesForUser(user, [])).length, 0, "raw samples are not in traces");
    });

    test("timeline: one event per position; read back exactly, so the chain re-verifies", async () => {
      const store = await make();
      const sid = `ses_${randomUUID().replace(/-/g, "")}`;
      const t = new Timeline({ sessionId: sid, clock: new ManualClock(T.getTime()), ids: new SequentialIds() });
      const e1 = t.append({
        type: "session.created",
        participant_id: "par_host",
        actor: { kind: "host", id: "par_host" },
        provenance: { component: "session_manager", data_origin: "system_generated", simulated: false },
        data: {
          expires_at: at(3600).toISOString(),
          checkin_response_window_ms: 60000,
          escalation_steps: [{ step: 1, target_role: "emergency_service_sim", ack_window_ms: 0, max_repeats: 0 }],
          thresholds_validated: false,
        },
      });
      assert.equal(await store.insertTimelineEvent(e1), true);
      assert.equal(await store.insertTimelineEvent({ ...e1, event_id: "evt_other" }), false, "position 1 is taken");
      const back = await store.listTimelineEvents(sid);
      assert.equal(back.length, 1);
      assert.equal(Timeline.restore(back, { sessionId: sid, clock: new ManualClock(T.getTime()) }).length, 1);
      assert.equal(await store.countTimelineEvents(sid), 1);
      await store.replaceTimeline(sid, []);
      assert.equal(await store.countTimelineEvents(sid), 0);
    });
  });
}

contract("memory", async () => new MemoryStore());

const uri = process.env.MONGODB_TEST_URI;
if (uri) {
  let store: MongoStore | null = null;
  const db = `ytc_contract_${Date.now()}`;
  contract(
    "mongodb",
    async () => (store ??= await MongoStore.connect(uri, db)),
    async () => {
      if (store) await store.close();
    },
  );
}
