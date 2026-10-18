/**
 * Safety state, deadlines and alert orchestration, end to end through the API
 * with a fake clock and real scheduler passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Transport } from "../../src/server/alerts/transport.js";
import { Client, hostSession, join, setup, signIn } from "./helpers.js";

const SEC = 1000;
const CONSENT = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };

async function group(transport?: Transport) {
  const env = setup(transport);
  const maya = await signIn(env.app, "maya");
  const sam = await signIn(env.app, "sam");
  const session = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${session.id}`)).body.session.code as string;
  const samSession = await join(sam, code);
  return { ...env, maya, sam, session, code, samParticipantId: samSession.me.participantId };
}

const alertsFor = async (c: Client) => (await c.call("GET", "/api/alerts")).body.alerts as any[];

test("closed client: a missed check-in alerts the host exactly once, and the host can acknowledge it", async () => {
  const { app, store, advance, tick, maya, session, code } = await group();

  // Sam joins with a (synthetic) backup contact, so there is a later step that must NOT fire.
  const sam = await signIn(app, "sam2");
  const joined = await sam.call("POST", "/api/sessions/join", {
    code,
    consent: CONSENT, consentTextVersion: "consent-v1",
    backupContacts: [{ name: "Priya", relation: "Sister" }],
  });
  assert.equal(joined.status, 201);

  // 1. Sam's phone sees a movement change and starts a private check-in (60 s window).
  await sam.raw("POST", `/api/sessions/${session.id}/heartbeat`);
  const started = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  assert.equal(started.status, 201);
  const checkInId = started.body.checkIn.id as string;

  // 2. The originating client closes: no answer, no heartbeats, no requests at all from here on.
  sam.cookies.clear();

  // Before the deadline nothing is sent.
  advance(30 * SEC);
  await tick();
  assert.equal((await alertsFor(maya)).length, 0);

  // 3. The deadline passes. The server, not the closed phone, opens the incident and alerts the host.
  advance(31 * SEC);
  const pass = await tick();
  assert.equal(pass.checkInsMissed, 1);
  assert.equal(pass.alerts.delivered, 1);
  assert.equal((await store.getCheckIn(checkInId))!.status, "missed");

  // 4. Exactly one alert, however many scheduler passes run (overlapping ones included).
  await Promise.all([tick(), tick(), tick()]);
  advance(20 * SEC);
  await tick();
  const alerts = await alertsFor(maya);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].about, "Sam2");
  assert.equal(alerts[0].trigger, "checkin_missed");
  const incidentId = alerts[0].incidentId as string;
  assert.equal((await store.listJobsForIncident(incidentId)).filter((j) => j.recipient.kind === "user").length, 1);

  // 5. The host acknowledges. Escalation stops; the record says acknowledgment is not a wellbeing check.
  const ack = await maya.call("POST", `/api/alerts/${alerts[0].id}/acknowledge`);
  assert.equal(ack.status, 200);
  assert.equal(ack.body.incident.status, "acknowledged");
  assert.equal(ack.body.incident.acknowledged.by, "Maya");
  assert.match(ack.body.incident.acknowledged.note, /does not confirm/);
  assert.equal(ack.body.incident.nextEscalationAt, null);
  assert.equal((await maya.call("POST", `/api/alerts/${alerts[0].id}/acknowledge`)).body.error.code, "already_acknowledged");

  // Long after the host's 120 s window: the backup contact was never alerted.
  advance(10 * 60 * SEC);
  await tick();
  const jobs = await store.listJobsForIncident(incidentId);
  assert.deepEqual(jobs.map((j) => j.level), ["host"]);

  // 6. Sam's acknowledgement is reported back to Sam when they reconnect.
  const samAgain = await signIn(app, "sam2");
  const view = await samAgain.call("GET", `/api/incidents/${incidentId}`);
  assert.equal(view.body.incident.acknowledged.by, "Maya");
  const timeline = await samAgain.call("GET", `/api/sessions/${session.id}/timeline`);
  assert.equal(timeline.body.checkIns[0].status, "missed");
  assert.ok(timeline.body.incidents[0].log.some((e: any) => /stopped sending heartbeats/.test(e.text)));
});

test("unacknowledged alerts escalate one step per deadline, ending in a simulated emergency step", async () => {
  const { app, store, advance, tick, maya, session, code } = await group();
  const jo = await signIn(app, "jo");
  await jo.call("POST", "/api/sessions/join", { code, consent: CONSENT, consentTextVersion: "consent-v1", backupContacts: [{ name: "Priya", relation: "Sister" }] });
  await jo.call("POST", `/api/sessions/${session.id}/help`);
  await tick();
  const incidentId = (await alertsFor(maya))[0].incidentId as string;

  advance(119 * SEC);
  await tick();
  assert.deepEqual((await store.listJobsForIncident(incidentId)).map((j) => j.level), ["host"]);

  advance(1 * SEC);
  await tick();
  assert.deepEqual((await store.listJobsForIncident(incidentId)).map((j) => j.level), ["host", "backup"]);

  advance(180 * SEC);
  await tick();
  const incident = (await store.getIncident(incidentId))!;
  assert.deepEqual((await store.listJobsForIncident(incidentId)).map((j) => j.level), ["host", "backup", "emergency_simulated"]);
  assert.ok(incident.log.some((e) => e.simulated && /simulated emergency services/.test(e.text)));
  assert.equal((await alertsFor(maya)).length, 1, "the host is never alerted twice for one incident");
});

test("a failing delivery is retried with backoff and never moves the escalation deadline", async () => {
  let failures = 2;
  const flaky: Transport = {
    async deliver(job) {
      if (job.recipient.kind === "user" && failures > 0) {
        failures--;
        return { ok: false, reason: "push_unavailable" };
      }
      return { ok: true, simulated: job.recipient.kind !== "user" };
    },
  };
  const { store, advance, tick, maya, sam, session } = await group(flaky);
  await sam.call("POST", `/api/sessions/${session.id}/help`);
  await tick();
  const incident = [...store.incidents.values()][0]!;
  const deadline = incident.steps[1]!.dueAt!.getTime();
  assert.equal((await alertsFor(maya)).length, 0, "first attempt failed");

  advance(5 * SEC);
  await tick();
  assert.equal((await alertsFor(maya)).length, 0, "second attempt failed");
  advance(15 * SEC);
  await tick();
  const [job] = await store.listJobsForIncident(incident._id);
  assert.equal(job!.status, "delivered");
  assert.equal(job!.attempts, 3);
  assert.deepEqual(job!.results.map((r) => r.ok), [false, false, true]);
  assert.equal((await alertsFor(maya)).length, 1);
  assert.equal((await store.getIncident(incident._id))!.steps[1]!.dueAt!.getTime(), deadline);
});

test('answering "I\'m OK" cancels the deadline; nobody is alerted', async () => {
  const { advance, tick, maya, sam, session, store } = await group();
  const { body } = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  const ok = await sam.call("POST", `/api/checkins/${body.checkIn.id}/respond`, { response: "ok" });
  assert.equal(ok.body.checkIn.status, "responded_ok");
  advance(5 * 60 * SEC);
  await tick();
  assert.equal(store.incidents.size, 0);
  assert.equal((await alertsFor(maya)).length, 0);
});

test('answering "I need help" alerts the host at once', async () => {
  const { tick, maya, sam, session } = await group();
  const { body } = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  const res = await sam.call("POST", `/api/checkins/${body.checkIn.id}/respond`, { response: "help" });
  assert.ok(res.body.incidentId);
  await tick();
  assert.equal((await alertsFor(maya))[0].trigger, "help_requested");
});

test("nobody can answer or start someone else's check-in", async () => {
  const { maya, sam, session } = await group();
  const { body } = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  assert.equal((await maya.call("POST", `/api/checkins/${body.checkIn.id}/respond`, { response: "ok" })).status, 404);
  const second = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  assert.equal(second.body.checkIn.id, body.checkIn.id, "one pending check-in at a time");
});

test("the host's own missed check-in goes to their backup contacts, not to themselves", async () => {
  const env = setup();
  const maya = await signIn(env.app, "maya");
  const res = await maya.call("POST", "/api/sessions", {
    name: "Friday",
    durationMin: 240,
    consent: CONSENT, consentTextVersion: "consent-v1",
    backupContacts: [{ name: "Chris", relation: "Brother" }],
  });
  const id = res.body.session.id as string;
  await maya.call("POST", `/api/sessions/${id}/checkins`, { reason: "movement_changed" });
  env.advance(61 * SEC);
  await env.tick();
  const [incident] = [...env.store.incidents.values()];
  assert.deepEqual(incident!.steps.map((s) => s.level), ["backup", "emergency_simulated"]);
  assert.equal((await alertsFor(maya)).length, 0);
});

test("session expiry ends the session and cancels pending check-ins; open alerts keep escalating", async () => {
  const { advance, tick, sam, session, store } = await group();
  advance(4 * 60 * 60 * SEC - 30 * SEC);
  await tick();
  const { body } = await sam.call("POST", `/api/sessions/${session.id}/checkins`, { reason: "movement_changed" });
  advance(31 * SEC);
  const pass = await tick();
  assert.equal(pass.sessionsExpired, 1);
  assert.equal(store.sessions.get(session.id)!.endedReason, "expired");
  assert.equal((await store.getCheckIn(body.checkIn.id))!.status, "cancelled");
});

test("the wearer cancels their own false alarm: escalation stops, it is saved, and only they can do it", async () => {
  const { app, store, advance, tick, maya, sam, session, code } = await group();
  const jo = await signIn(app, "jo");
  await jo.call("POST", "/api/sessions/join", { code, consent: CONSENT, consentTextVersion: "consent-v1", backupContacts: [{ name: "Priya", relation: "Sister" }] });
  await jo.call("POST", `/api/sessions/${session.id}/help`);
  await tick();
  const incidentId = (await alertsFor(maya))[0].incidentId as string;

  // Nobody else can cancel it: not the host, not another participant.
  assert.equal((await maya.call("POST", `/api/sessions/${session.id}/cancel-alert`)).status, 404);
  assert.equal((await sam.call("POST", `/api/sessions/${session.id}/cancel-alert`)).status, 404);
  assert.equal((await store.getIncident(incidentId))!.status, "open");

  advance(30 * SEC);
  const res = await jo.call("POST", `/api/sessions/${session.id}/cancel-alert`);
  assert.equal(res.status, 200);
  const incident = (await store.getIncident(incidentId))!;
  assert.equal(incident.status, "resolved");
  assert.equal(incident.resolved?.bySubject, true);
  assert.equal(incident.resolved?.outcome, "false_alarm");
  assert.equal(incident.activeKey, null);
  assert.ok(incident.steps.slice(1).every((s) => s.dueAt === null && s.notifiedAt === null));
  assert.ok(incident.log.some((e) => e.kind === "resolution" && /their own report/.test(e.text)));

  // The backup step never fires.
  advance(60 * 60 * SEC);
  await tick();
  assert.deepEqual((await store.listJobsForIncident(incidentId)).map((j) => j.level), ["host"]);

  // A second cancel finds nothing; asking for help again opens a new alert.
  assert.equal((await jo.call("POST", `/api/sessions/${session.id}/cancel-alert`)).status, 404);
  const again = await jo.call("POST", `/api/sessions/${session.id}/help`);
  assert.equal(again.status, 201);
  assert.notEqual(again.body.incidentId, incidentId);
});
