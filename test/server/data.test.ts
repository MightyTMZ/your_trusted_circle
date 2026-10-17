import { test } from "node:test";
import assert from "node:assert/strict";
import { runRetention } from "../../src/server/data/retention.js";
import { hostSession, join, setup, signIn } from "./helpers.js";

async function scenario() {
  const env = setup();
  const maya = await signIn(env.app, "maya");
  const sam = await signIn(env.app, "sam");
  const jo = await signIn(env.app, "jo");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);
  await join(jo, code);
  // Sam misses a check-in; Maya is alerted.
  await sam.call("POST", `/api/sessions/${s.id}/checkins`, { reason: "movement_changed" });
  env.advance(61_000);
  await env.tick();
  return { ...env, maya, sam, jo, sessionId: s.id };
}

test("timelines show each person only what they are permitted to see", async () => {
  const { maya, sam, jo, sessionId } = await scenario();
  const host = (await maya.call("GET", `/api/sessions/${sessionId}/timeline`)).body;
  assert.equal(host.incidents.length, 1, "the host sees incidents about others");
  assert.equal(host.checkIns.length, 0, "check-ins stay private to the person");

  const own = (await sam.call("GET", `/api/sessions/${sessionId}/timeline`)).body;
  assert.equal(own.incidents.length, 1);
  assert.equal(own.checkIns.length, 1);

  const other = (await jo.call("GET", `/api/sessions/${sessionId}/timeline`)).body;
  assert.equal(other.incidents.length, 0, "other participants do not see Sam's incident");
});

test("export contains my check-ins, incidents about me and alerts sent to me", async () => {
  const { maya, sam } = await scenario();
  const res = await sam.raw("GET", "/api/me/export");
  assert.match(res.headers.get("Content-Disposition")!, /attachment; filename="ytc-data-/);
  const data = (await res.json()) as any;
  assert.equal(data.user.displayName, "Sam");
  assert.equal(data.checkIns.length, 1);
  assert.equal(data.incidentsAboutMe.length, 1);
  const hostData = (await (await maya.raw("GET", "/api/me/export")).json()) as any;
  assert.equal(hostData.alertsSentToMe.length, 1);
  assert.equal(hostData.incidentsAboutMe.length, 0);
});

test("deleting an account removes everything about the person, including alerts others received", async () => {
  const { maya, sam, store } = await scenario();
  assert.equal((await sam.call("DELETE", "/api/me", {})).status, 400, "needs explicit confirmation");
  const res = await sam.call("DELETE", "/api/me", { confirm: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted.checkIns, 1);
  assert.equal(res.body.deleted.incidents, 1);
  assert.equal(res.body.deleted.notifications, 1);
  assert.equal([...store.users.values()].some((u) => u.displayName === "Sam"), false);
  assert.equal((await maya.call("GET", "/api/alerts")).body.alerts.length, 0);
  assert.equal((await sam.call("GET", "/api/me")).status, 401);
});

test("a host with an open alert must resolve it before deleting their account", async () => {
  const { maya } = await scenario();
  const res = await maya.call("DELETE", "/api/me", { confirm: "DELETE" });
  assert.equal(res.status, 409);
});

test("retention deletes finished sessions and old traces, but keeps active incidents", async () => {
  const { app, deps, store, advance, sessionId } = await scenario();
  advance(40 * 24 * 60 * 60 * 1000);
  await runRetention(deps);
  assert.ok(store.sessions.has(sessionId), "kept while Sam's incident is active");

  // 40 days on, Maya's sign-in has expired too; she signs in again to resolve.
  const maya = await signIn(app, "maya");
  const [alert] = (await maya.call("GET", "/api/alerts")).body.alerts;
  await maya.call("POST", `/api/alerts/${alert.id}/acknowledge`);
  await maya.call("POST", `/api/incidents/${alert.incidentId}/resolve`, { outcome: "assistance_reached" });
  await runRetention(deps);
  assert.equal(store.sessions.has(sessionId), false);
  assert.equal(store.incidents.size, 0);
  assert.equal(store.jobs.size, 0);
});
