/**
 * Live incident demo, end to end through the API with a fake clock: synthetic
 * input only, then the server's own check-in, escalation and a ringing
 * simulated call whose agent reads the demo incident's record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import type { Deps } from "../../src/server/context.js";
import { DemoRegistry } from "../../src/server/demo/live-demo.js";
import { LocationRelay } from "../../src/server/lifecycle/relay.js";
import { runSchedulerPass } from "../../src/server/safety/scheduler.js";
import { MemoryStore } from "../../src/server/store/memory.js";
import { CallService } from "../../src/server/voice/calls.js";
import { defaultTransport } from "../../src/server/alerts/transport.js";
import { Timeline } from "../../src/timeline/timeline.js";
import { APP_ORIGIN, Client, T0, hostSession, signIn } from "./helpers.js";

const CONSENT = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };

async function demoGroup(samConsent: Record<string, unknown> = { ...CONSENT, shareNoteWithResponders: true }) {
  let nowMs = T0;
  const calls = new CallService({ wallClock: () => nowMs });
  const deps: Deps = {
    store: new MemoryStore(),
    config: loadConfig({ APP_ORIGIN, DEMO_INCIDENTS: "true" } as NodeJS.ProcessEnv),
    providers: {
      google: {
        id: "google",
        formPost: false,
        authorizationUrl: (state) => new URL(`https://accounts.example/authorize?state=${state}`),
        identify: async ({ code }) => ({ subject: code, email: `${code}@example.test`, emailVerified: true, displayName: code.charAt(0).toUpperCase() + code.slice(1) }),
      },
    },
    transport: defaultTransport,
    relay: new LocationRelay(),
    now: () => new Date(nowMs),
    calls,
  };
  const demos = new DemoRegistry(calls);
  deps.demos = demos;
  const app = createApp(deps);
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const session = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${session.id}`)).body.session.code as string;
  const joined = await sam.call("POST", "/api/sessions/join", {
    code,
    consent: samConsent,
    backupContacts: [{ name: "Priya", relation: "Sister" }],
    responderNote: "Synthetic demo note: carries an inhaler.",
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  /** One second of server time: a scheduler pass, then the demo's pass, as main.ts runs them. */
  const second = async () => {
    nowMs += 1000;
    await runSchedulerPass(deps);
    await demos.tick(deps);
  };
  const until = async (done: () => Promise<boolean> | boolean, maxSeconds: number) => {
    for (let i = 0; i < maxSeconds; i++) {
      if (await done()) return i;
      await second();
    }
    assert.fail(`not reached within ${maxSeconds} s`);
  };
  return { app, deps, calls, demos, maya, sam, session, samId: joined.body.session.me.participantId as string, second, until };
}

const demoOf = async (c: Client, sessionId: string) => (await c.call("GET", `/api/sessions/${sessionId}/demo`)).body.demo;

test("demo: impact, unanswered check-in, escalation, then a ringing call grounded in this incident", async () => {
  const { maya, sam, session, samId, calls, demos, until } = await demoGroup();

  const started = await maya.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const lead = Date.parse(started.body.demo.impactAt) - Date.parse(started.body.demo.startedAt);
  assert.ok(lead >= 5_000 && lead < 20_000, `impact ${lead} ms after the trigger`);
  // The synthetic evening is already in the record.
  assert.ok(started.body.demo.timelineEvents > 300);

  // The real detector notices the impact; the server opens Sam's private check-in.
  const toCheckIn = await until(async () => (await demoOf(maya, session.id)).phase === "checkin_pending", 60);
  assert.ok(toCheckIn < 45, `check-in after ${toCheckIn} s`);
  const mine = (await sam.call("GET", `/api/sessions/${session.id}/timeline`)).body;
  assert.equal(mine.checkIns.filter((c: any) => c.status === "pending").length, 1);
  // Check-ins stay private: the host sees no check-in and no incident yet.
  const hosts = (await maya.call("GET", `/api/sessions/${session.id}/timeline`)).body;
  assert.equal(hosts.checkIns.length, 0);
  assert.equal(hosts.incidents.length, 0);

  // Nobody answers: missed, incident, host, backup contact, then simulated emergency services.
  await until(async () => (await demoOf(maya, session.id)).phase === "calling", 150);
  const demo = await demoOf(maya, session.id);
  assert.ok(demo.incidentId);
  assert.equal(demo.call.status, "ringing");
  assert.equal((await maya.call("GET", "/api/alerts")).body.alerts.length, 1);

  const incoming = calls.incoming();
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]!.incident_id, demo.incidentId);
  assert.equal(incoming[0]!.about, "Sam");

  // The agent says nothing until the operator answers; then it reads this incident's record.
  const answered = calls.answer(demo.call.id);
  assert.equal(answered.call.status, "active");
  assert.equal(answered.call.incident_id, demo.incidentId);
  assert.match(answered.reply.text, /automated assistant/i);
  assert.match(answered.reply.text, /Sam/);
  assert.match(answered.reply.text, /inhaler/);
  assert.match(answered.reply.text, /Toronto City Hall/);

  const where = await calls.operatorText(demo.call.id, "Where are they right now?");
  assert.ok(where.reply);
  assert.match(where.reply!.text, /last/i);

  // The incident's log says a call is happening, and that it was simulated.
  await until(async () => (await demoOf(maya, session.id)).phase === "on_call", 3);
  const log = (await maya.call("GET", `/api/sessions/${session.id}/timeline`)).body.incidents[0].log as { text: string }[];
  assert.ok(log.some((l) => /simulated emergency operator/.test(l.text)));
  assert.ok(log.some((l) => /operator answered/.test(l.text)));

  // The record is a valid hash-chained timeline, rebuilt from scratch.
  const run = demos.get(session.id)!;
  assert.doesNotThrow(() => Timeline.restore(run.timeline.events, { sessionId: session.id, clock: { now: () => Date.now() } }));
  const types = run.timeline.events.map((e) => e.type);
  for (const t of ["checkin.prompted", "checkin.missed", "incident.opened", "notification.sent", "escalation.step_fired", "emergency.simulated_dispatch_requested", "voice.call_started", "voice.utterance"]) {
    assert.ok(types.includes(t as never), `${t} in the record`);
  }

  // "I'm OK" from their phone reaches the call as their own report, never as a confirmation.
  assert.equal((await sam.raw("POST", `/api/sessions/${session.id}/update`)).status, 204);
  await until(() => run.timeline.events.some((e) => e.type === "incident.participant_update"), 3);
  const said = calls.state(demo.call.id).call.facts.find((f) => /reported from their own phone/.test(f.text));
  assert.ok(said, "the agent's facts include the self-report");
  assert.match(said!.text, /cannot confirm their condition/);

  // Acknowledging mid-call reaches the agent's record at once.
  const alertId = (await maya.call("GET", "/api/alerts")).body.alerts[0].id as string;
  assert.equal((await maya.call("POST", `/api/alerts/${alertId}/acknowledge`)).status, 200);
  await until(() => run.timeline.events.some((e) => e.type === "incident.acknowledged"), 3);
});

test("demo: answering the check-in ends it with no incident", async () => {
  const { maya, sam, session, samId, until } = await demoGroup();
  assert.equal((await maya.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId })).status, 201);
  await until(async () => (await demoOf(maya, session.id)).phase === "checkin_pending", 60);
  const checkIn = (await sam.call("GET", `/api/sessions/${session.id}/timeline`)).body.checkIns.find((c: any) => c.status === "pending");
  assert.equal((await sam.call("POST", `/api/checkins/${checkIn.id}/respond`, { response: "ok" })).status, 200);
  await until(async () => (await demoOf(maya, session.id)).phase === "answered_ok", 3);
  assert.equal((await maya.call("GET", "/api/alerts")).body.alerts.length, 0);
});

test("demo: host only, and never for someone who turned check-ins off", async () => {
  const { maya, sam, session, samId } = await demoGroup({ ...CONSENT, monitoring: false });
  const byGuest = await sam.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId });
  assert.equal(byGuest.status, 403);
  const off = await maya.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId });
  assert.equal(off.status, 409);
  assert.equal(off.body.error.code, "monitoring_off");
});

test("demo: without their consent the call does not name them or read their note", async () => {
  const { maya, session, samId, calls, until } = await demoGroup({ ...CONSENT, shareNoteWithResponders: false });
  assert.equal((await maya.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId })).status, 201);
  await until(async () => (await demoOf(maya, session.id)).phase === "calling", 200);
  const [ring] = calls.incoming();
  assert.doesNotMatch(ring!.about, /Sam/);
  const answered = calls.answer(ring!.call_id);
  assert.doesNotMatch(answered.reply.text, /Sam|inhaler/);
});


test("story: the demo person's movements as sentences, shown only to those they share location with", async () => {
  const { app, maya, sam, session, samId, until } = await demoGroup({ ...CONSENT, locationSharing: "host", shareNoteWithResponders: true });
  const code = (await maya.call("GET", `/api/sessions/${session.id}`)).body.session.code as string;
  const alex = await signIn(app, "alex");
  assert.equal((await alex.call("POST", "/api/sessions/join", { code, consent: CONSENT })).status, 201);
  assert.equal((await maya.call("POST", `/api/sessions/${session.id}/demo`, { participantId: samId })).status, 201);

  const story = async (c: Client) => (await c.call("GET", `/api/sessions/${session.id}/story`)).body as { items: { kind: string; text: string }[]; noMovementRecord: string[] };
  const moves = (s: Awaited<ReturnType<typeof story>>) => s.items.filter((i) => i.kind === "movement").map((i) => i.text);

  // Sam shares location with the host only: the host and Sam see the moves, Alex does not.
  const hostMoves = moves(await story(maya));
  assert.ok(hostMoves.some((t) => /^Sam arrived at Toronto City Hall, entrance \(simulated\)\.$/.test(t)), hostMoves.join(" | "));
  assert.ok(hostMoves.some((t) => /^Sam moved from the entrance to the main room, about \d+ m \(simulated\)\.$/.test(t)), hostMoves.join(" | "));
  assert.ok(hostMoves.some((t) => /walking at about 1\.\d m\/s heading east/.test(t)), hostMoves.join(" | "));
  assert.ok(moves(await story(sam)).length > 0);
  const alexStory = await story(alex);
  assert.equal(moves(alexStory).length, 0);
  assert.ok(alexStory.noMovementRecord.includes("Sam"));

  // The alert's own log joins the story for the host and Sam, never for Alex.
  await until(async () => (await demoOf(maya, session.id)).phase === "calling", 200);
  const alerts = (s: Awaited<ReturnType<typeof story>>) => s.items.filter((i) => i.kind === "alert").map((i) => i.text);
  assert.ok(alerts(await story(maya)).some((t) => /simulated emergency operator/.test(t)));
  assert.ok(alerts(await story(sam)).length > 0);
  assert.equal(alerts(await story(alex)).length, 0);
});
