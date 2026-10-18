/**
 * Demo venue and "teleport": the host picks a public place for the whole
 * session, and a phone may relay made-up positions there, always labelled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostSession, join, setup, signIn } from "./helpers.js";

const VENUE = { label: "Rebel, 11 Polson St", lat: 43.6405, lng: -79.354 };

test("the host sets the demo venue for everyone; participants cannot", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);

  assert.equal((await sam.call("PATCH", `/api/sessions/${s.id}/rules`, { demoVenue: VENUE })).status, 403);
  assert.equal((await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { demoVenue: VENUE })).status, 200);
  assert.deepEqual((await sam.call("GET", `/api/sessions/${s.id}`)).body.session.rules.demoVenue, VENUE);

  assert.equal((await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { demoVenue: { ...VENUE, lat: 95 } })).status, 400);
  assert.equal((await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { demoVenue: null })).status, 200);
  assert.equal((await sam.call("GET", `/api/sessions/${s.id}`)).body.session.rules.demoVenue, null);
});

test("a teleported fix is relayed and labelled simulated; a GPS fix is not", async () => {
  const { app, deps } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);
  const fix = (simulated?: boolean) => ({ latitude: VENUE.lat, longitude: VENUE.lng, accuracyM: 5, fixAt: deps.now().toISOString(), ...(simulated === undefined ? {} : { simulated }) });

  await sam.call("POST", `/api/sessions/${s.id}/location`, fix(true));
  await maya.call("POST", `/api/sessions/${s.id}/location`, fix());
  const seen = (await maya.call("GET", `/api/sessions/${s.id}/locations`)).body.locations as any[];
  const by = Object.fromEntries(seen.map((l) => [l.displayName, l.simulated]));
  assert.deepEqual(by, { Sam: true, Maya: false });

  // Clearing the venue drops the teleported position at once; real GPS stays.
  await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { demoVenue: null });
  const after = (await maya.call("GET", `/api/sessions/${s.id}/locations`)).body.locations as any[];
  assert.deepEqual(after.map((l) => l.displayName), ["Maya"]);
});
