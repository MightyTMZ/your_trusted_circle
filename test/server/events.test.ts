import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLocation, TooDeepError } from "../../src/server/lifecycle/location.js";
import { UI, hostSession, join, locationFix, setup, signIn, timeline } from "./helpers.js";

async function setupGroup() {
  const env = setup();
  const maya = await signIn(env.app, "maya");
  const sam = await signIn(env.app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  const joined = await join(sam, code);
  return { ...env, maya, sam, sessionId: s.id, hostPid: s.me.participantId, samPid: joined.me.participantId };
}

const ingest = (client: Awaited<ReturnType<typeof setupGroup>>["sam"], items: unknown[]) => client.call("POST", "/api/ingest", { items });

test("ingestion needs a sign-in and a well-formed batch", async () => {
  const { app } = setup();
  const anon = await signIn(app, "x");
  anon.cookies.clear();
  assert.equal((await anon.call("POST", "/api/ingest", { items: [] })).status, 401);
  const x = await signIn(app, "x");
  assert.equal((await x.call("POST", "/api/ingest", { items: [] })).status, 400);
  assert.equal((await x.call("POST", "/api/ingest", { items: [{ kind: "bogus", data: {} }] })).status, 400);
});

test("only catalogued, intact timeline events are accepted", async () => {
  const { sam, sessionId, samPid, store } = await setupGroup();
  const t = timeline(sessionId);
  const good = t.append({
    type: "consent.granted",
    participant_id: samPid,
    actor: { kind: "participant", id: samPid },
    provenance: UI,
    data: { scopes: ["location.group"], consent_text_version: "v1" },
  });
  const tampered = { ...good, summary: "Sam is fine" };
  const res = await ingest(sam, [
    { kind: "event", sessionId, data: good },
    { kind: "event", sessionId, data: tampered },
    { kind: "event", data: good },
  ]);
  assert.equal(res.body.accepted, 1);
  assert.deepEqual(res.body.rejected.map((r: any) => r.code), ["invalid_event", "session_required"]);
  assert.equal(store.traces[0]!.userId, [...store.users.values()].find((u) => u.displayName === "Sam")!._id);
});

test("a participant cannot send events as someone else", async () => {
  const { sam, sessionId, hostPid } = await setupGroup();
  const t = timeline(sessionId);
  const forged = t.append({
    type: "consent.granted",
    participant_id: hostPid,
    actor: { kind: "participant", id: hostPid },
    provenance: UI,
    data: { scopes: ["monitoring"], consent_text_version: "v1" },
  });
  const res = await ingest(sam, [{ kind: "event", sessionId, data: forged }]);
  assert.equal(res.body.rejected[0].code, "actor_mismatch");
});

test("you cannot send data into a session you are not in", async () => {
  const { app, sessionId } = await setupGroup();
  const eve = await signIn(app, "eve");
  const res = await eve.call("POST", "/api/ingest", { items: [{ kind: "log", sessionId, data: { msg: "hi" } }] });
  assert.equal(res.body.rejected[0].code, "not_in_session");
});

test("sensor ingestion respects the participant's monitoring consent", async () => {
  const { sam, sessionId, store } = await setupGroup();
  const consent = await sam.call("PATCH", `/api/sessions/${sessionId}/me/consent`, {
    monitoring: false,
    locationSharing: "group",
    shareLocationWithResponders: true,
    consentTextVersion: "consent-v1",
  });
  assert.equal(consent.status, 200);

  const res = await ingest(sam, [
    { kind: "sensor", sessionId, dataOrigin: "live_device", dataClass: "raw", units: "m/s^2", data: { accel: [0.1, 9.8, 0.2] } },
  ]);

  assert.equal(res.body.accepted, 0);
  assert.equal(res.body.rejected[0].code, "monitoring_off");
  assert.equal(store.rawRecordings.length, 0);
  assert.equal(store.traces.filter((t) => t.kind === "sensor").length, 0);
});

test("location is stored only while the server has an active incident for that person", async () => {
  const { maya, sam, sessionId, samPid, store, tick } = await setupGroup();
  const t = timeline(sessionId);
  t.append({
    type: "consent.granted",
    participant_id: samPid,
    actor: { kind: "participant", id: samPid },
    provenance: UI,
    data: { scopes: ["location.group", "location.responders"], consent_text_version: "v1" },
  });

  // No incident: the fix is dropped, and coordinates are stripped from free-form data.
  let res = await ingest(sam, [
    { kind: "event", sessionId, data: locationFix(t, samPid) },
    { kind: "sensor", sessionId, dataOrigin: "synthetic_scenario", dataClass: "derived", units: "m/s^2", data: { accel: [0.1, 9.8, 0.2], gps: { lat: 43.6, lng: -79.4 }, meta: { position: "x", battery: 0.4 } } },
  ]);
  assert.equal(res.body.locationDropped, 1);
  assert.equal(res.body.locationFieldsRemoved, 2);
  const sensor = store.traces.find((x) => x.kind === "sensor")!;
  assert.deepEqual(sensor.data, { accel: [0.1, 9.8, 0.2], meta: { battery: 0.4 } });
  assert.equal(sensor.locationRedacted, true);

  // A client claiming an incident does not unlock anything; only the server's incidents count.
  res = await ingest(sam, [{ kind: "event", sessionId, data: locationFix(t, samPid) }]);
  assert.equal(res.body.locationDropped, 1);

  // Sam asks for help: the server opens an incident, and location is kept.
  await sam.call("POST", `/api/sessions/${sessionId}/help`);
  res = await ingest(sam, [{ kind: "event", sessionId, data: locationFix(t, samPid) }]);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.locationDropped, 0);

  // Resolved: location is dropped again.
  await tick();
  const [alert] = (await maya.call("GET", "/api/alerts")).body.alerts;
  await maya.call("POST", `/api/alerts/${alert.id}/acknowledge`);
  await maya.call("POST", `/api/incidents/${alert.incidentId}/resolve`, { outcome: "false_alarm" });
  res = await ingest(sam, [{ kind: "event", sessionId, data: locationFix(t, samPid) }]);
  assert.equal(res.body.locationDropped, 1);
});

test("location keys are found at any depth and in any spelling", () => {
  const { value, removed } = stripLocation({
    a: [{ Latitude: 1, nested: { LONG: 2, last_known_location: {}, keep: true } }],
    "geo-hash": "x",
    heading: 90,
  });
  assert.equal(removed, 5);
  assert.deepEqual(value, { a: [{ nested: { keep: true } }] });
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 40; i++) deep = deep.x = {};
  assert.throws(() => stripLocation(root), TooDeepError);
});
