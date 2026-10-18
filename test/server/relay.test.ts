/**
 * Live group location (option A): relayed in memory, shown per consent,
 * never stored unless an incident about the person is active.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, hostSession, setup, signIn } from "./helpers.js";

const SEC = 1000;

async function group() {
  const env = setup();
  const maya = await signIn(env.app, "maya");
  const s = await hostSession(maya, { monitoring: true, locationSharing: "group", shareLocationWithResponders: true });
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  const joinAs = async (name: string, locationSharing: string, shareLocationWithResponders = false) => {
    const c = await signIn(env.app, name);
    const res = await c.call("POST", "/api/sessions/join", {
      code,
      consent: { monitoring: true, locationSharing, shareLocationWithResponders },
      consentTextVersion: "consent-v1",
      backupContacts: [{ name: "Rin", relation: "Friend" }],
    });
    assert.equal(res.status, 201);
    return c;
  };
  const sam = await joinAs("sam", "group");
  const jo = await joinAs("jo", "host");
  const kim = await joinAs("kim", "off", true);
  const send = (c: Client, lat = 43.6532) =>
    c.call("POST", `/api/sessions/${s.id}/location`, {
      latitude: lat,
      longitude: -79.3832,
      accuracyM: 12,
      fixAt: env.deps.now().toISOString(),
    });
  const seen = async (c: Client) =>
    ((await c.call("GET", `/api/sessions/${s.id}/locations`)).body.locations as any[]).map((l) => `${l.displayName}:${l.status}`).sort();
  return { ...env, maya, sam, jo, kim, sessionId: s.id, send, seen };
}

test("live positions are relayed but nothing reaches the database", async () => {
  const { store, sam, maya, send, seen } = await group();
  const res = await send(sam, 43.65321);
  assert.deepEqual(res.body, { relayed: true, stored: false });
  assert.deepEqual(await seen(maya), ["Sam:live"]);
  assert.equal(store.traces.length, 0);
  const everything = JSON.stringify({ sessions: [...store.sessions.values()], traces: store.traces, incidents: [...store.incidents.values()] });
  assert.ok(!everything.includes("43.65321"), "no coordinate anywhere in storage");
});

test("each person's sharing choice decides who sees them", async () => {
  const { maya, sam, jo, kim, send, seen } = await group();
  await send(maya);
  await send(sam);
  await send(jo);
  const off = await send(kim);
  assert.deepEqual(off.body, { relayed: false, stored: false, reason: "sharing_off" });

  // Maya (host) sees group sharers and Jo, who shares with the host only.
  assert.deepEqual(await seen(maya), ["Jo:live", "Maya:live", "Sam:live"]);
  // Sam sees group sharers, not Jo.
  assert.deepEqual(await seen(sam), ["Maya:live", "Sam:live"]);
  // Jo sees group sharers and always themselves.
  assert.deepEqual(await seen(jo), ["Jo:live", "Maya:live", "Sam:live"]);
  // Kim shares with nobody, but still sees others who share with the group.
  assert.deepEqual(await seen(kim), ["Maya:live", "Sam:live"]);
});

test("during an active incident, responder sharing reaches the host and the fix is stored", async () => {
  const { store, maya, sam, kim, sessionId, send, seen, tick } = await group();
  await kim.call("POST", `/api/sessions/${sessionId}/help`);
  const res = await send(kim);
  assert.deepEqual(res.body, { relayed: true, stored: true });
  assert.equal(store.traces.filter((t) => t.type === "location.fix").length, 1);
  assert.ok((await seen(maya)).includes("Kim:live"), "the host, as responder, sees Kim");
  assert.ok(!(await seen(sam)).includes("Kim:live"), "other participants do not");

  // Resolved: Kim's sharing is "off" again, so the relay stops showing them.
  await tick();
  const [alert] = (await maya.call("GET", "/api/alerts")).body.alerts;
  await maya.call("POST", `/api/alerts/${alert.id}/acknowledge`);
  await maya.call("POST", `/api/incidents/${alert.incidentId}/resolve`, { outcome: "false_alarm" });
  assert.ok(!(await seen(maya)).includes("Kim:live"));
  assert.equal((await send(kim)).body.reason, "sharing_off");
});

test("a fix is live, then stale (last known), then forgotten", async () => {
  const { maya, sam, send, seen, advance, tick, deps } = await group();
  await send(sam);
  advance(90 * SEC);
  assert.deepEqual(await seen(maya), ["Sam:live"]);
  advance(1 * SEC);
  assert.deepEqual(await seen(maya), ["Sam:stale"]);
  advance(90 * SEC);
  await tick();
  assert.deepEqual(await seen(maya), []);
  assert.equal(deps.relay.size, 0);
});

test("old and future fixes are refused", async () => {
  const { sam, sessionId, deps } = await group();
  const at = (offsetMs: number) => new Date(deps.now().getTime() + offsetMs).toISOString();
  const body = (fixAt: string) => ({ latitude: 1, longitude: 1, accuracyM: 5, fixAt });
  assert.equal((await sam.call("POST", `/api/sessions/${sessionId}/location`, body(at(5 * 60 * SEC)))).status, 400);
  assert.equal((await sam.call("POST", `/api/sessions/${sessionId}/location`, body(at(-10 * 60 * SEC)))).body.reason, "too_old");
});

test("turning sharing off, leaving, and ending the session clear positions at once", async () => {
  const { maya, sam, jo, sessionId, send, seen, deps } = await group();
  await send(maya);
  await send(sam);
  await send(jo);

  await sam.call("PATCH", `/api/sessions/${sessionId}/me/consent`, { monitoring: true, locationSharing: "off", shareLocationWithResponders: false, consentTextVersion: "consent-v1" });
  assert.ok(!(await seen(maya)).some((x) => x.startsWith("Sam")));

  await jo.call("POST", `/api/sessions/${sessionId}/leave`);
  assert.ok(!(await seen(maya)).some((x) => x.startsWith("Jo")));

  await maya.call("POST", `/api/sessions/${sessionId}/end`);
  assert.equal(deps.relay.size, 0);
});

test("the host switching location off for the session clears everyone", async () => {
  const { maya, sam, sessionId, send, deps } = await group();
  await send(maya);
  await send(sam);
  await maya.call("PATCH", `/api/sessions/${sessionId}/rules`, { allowLocationSharing: false });
  assert.equal(deps.relay.size, 0);
  assert.equal((await send(sam)).body.reason, "sharing_off");
});

test("deleting an account clears that person's live position", async () => {
  const { maya, sam, send, seen, deps } = await group();
  await send(sam);
  await sam.call("DELETE", "/api/me", { confirm: "DELETE" });
  assert.deepEqual(await seen(maya), []);
  assert.equal(deps.relay.size, 0);
});

test("only members can send or read positions", async () => {
  const { app, sessionId } = await group();
  const eve = await signIn(app, "eve");
  assert.equal((await eve.call("GET", `/api/sessions/${sessionId}/locations`)).status, 404);
  const res = await eve.call("POST", `/api/sessions/${sessionId}/location`, { latitude: 1, longitude: 1, accuracyM: 1, fixAt: new Date().toISOString() });
  assert.equal(res.status, 404);
});
