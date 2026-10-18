/**
 * The backend gaps from docs/backend.md, end to end through the API. Every
 * test runs with strictTimeline: any server event the catalog would refuse
 * fails the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport, type Transport } from "../../src/server/alerts/transport.js";
import { ManualClock } from "../../src/shared/clock.js";
import { buildOperatorBriefing } from "../../src/timeline/briefing.js";
import { MOCK_OPERATOR_ENDPOINT_ID } from "../../src/timeline/schema/envelope.js";
import { Timeline } from "../../src/timeline/timeline.js";
import { Client, UI, hostSession, setup, signIn, timeline } from "./helpers.js";

const SEC = 1000;
const V = "consent-v1";
const CONSENT = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };

async function night(opts: { transport?: Transport; env?: Record<string, string> } = {}) {
  const env = setup(opts.transport, opts.env);
  const maya = await signIn(env.app, "maya");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  const sam = await signIn(env.app, "sam");
  const joined = await sam.call("POST", "/api/sessions/join", {
    code,
    consent: CONSENT,
    consentTextVersion: V,
    backupContacts: [{ name: "Priya", relation: "Sister" }],
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const me = joined.body.session.me;
  return { ...env, maya, sam, code, sessionId: s.id as string, samPid: me.participantId as string, contactId: me.backupContacts[0].id as string };
}

type Night = Awaited<ReturnType<typeof night>>;

async function missCheckIn(n: Night) {
  const res = await n.sam.call("POST", `/api/sessions/${n.sessionId}/checkins`, { reason: "movement_changed" });
  assert.equal(res.status, 201);
  n.advance(61 * SEC);
  await n.tick();
  return [...n.store.incidents.values()].at(-1)!;
}

const types = (events: readonly { type: string }[]) => events.map((e) => e.type);
const restore = (sessionId: string, events: readonly unknown[]) => Timeline.restore(events, { sessionId, clock: new ManualClock(0) });

// ── 1. The server writes its actions to the timeline ─────────────────────
test("#1 incidents, alerts, escalation and acknowledgment are on the hash-chained timeline, and the briefing builds from it", async () => {
  const n = await night();
  const incident = await missCheckIn(n);
  const [alert] = (await n.maya.call("GET", "/api/alerts")).body.alerts;
  await n.maya.call("POST", `/api/alerts/${alert.id}/acknowledge`);

  const events = await n.deps.timeline.events(n.sessionId);
  const seen = types(events);
  for (const t of [
    "session.created",
    "session.participant_joined",
    "consent.granted",
    "checkin.prompted",
    "checkin.missed",
    "incident.opened",
    "notification.sent",
    "escalation.step_scheduled",
    "notification.delivered",
    "incident.acknowledged",
    "escalation.step_cancelled",
  ]) {
    assert.ok(seen.includes(t), `missing ${t}`);
  }
  assert.ok(seen.indexOf("checkin.missed") < seen.indexOf("incident.opened"));
  // The stored chain verifies end to end.
  assert.equal(restore(n.sessionId, n.store.timelines.get(n.sessionId)!).length, events.length);
  const briefing = buildOperatorBriefing(events, { incidentId: incident._id, now: n.deps.now().getTime() });
  assert.ok(JSON.stringify(briefing).includes(incident._id));
});

// ── 2. Voice-agent trigger and service endpoints ─────────────────────────
test("#2 the simulated emergency step triggers the voice-agent service, which can read the briefing and record grounded turns only", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  const token = "voice-token-0123456789";
  const n = await night({
    transport: createTransport({ voiceAgentUrl: "http://voice.test", voiceAgentToken: token }, fakeFetch),
    env: { VOICE_AGENT_URL: "http://voice.test", VOICE_AGENT_TOKEN: token },
  });
  const service = new Client(n.app);
  const auth = { Authorization: `Bearer ${token}` };

  const incident = await missCheckIn(n);
  assert.equal((await service.raw("GET", `/api/service/incidents/${incident._id}/briefing`, undefined, auth)).status, 404, "not at the emergency step yet");
  n.advance(120 * SEC);
  await n.tick();
  n.advance(180 * SEC);
  await n.tick();

  assert.equal(calls.length, 1, "triggered exactly once");
  assert.equal(calls[0]!.url, "http://voice.test/escalations");
  const sent = JSON.parse(String(calls[0]!.init.body));
  assert.equal(sent.mockEndpointId, MOCK_OPERATOR_ENDPOINT_ID);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
  assert.ok(types(await n.deps.timeline.events(n.sessionId)).includes("emergency.simulated_dispatch_requested"));

  assert.equal((await service.raw("GET", `/api/service/incidents/${incident._id}/briefing`)).status, 401);
  assert.equal((await service.raw("GET", `/api/service/incidents/${incident._id}/briefing`, undefined, { Authorization: "Bearer wrong" })).status, 401);
  const briefing = await service.raw("GET", `/api/service/incidents/${incident._id}/briefing`, undefined, auth);
  assert.equal(briefing.status, 200);

  const opened = n.store.incidents.get(incident._id)!.openedEventId!;
  const post = (body: unknown) => service.raw("POST", `/api/service/incidents/${incident._id}/voice-events`, body, auth);
  assert.equal((await post({ type: "voice.call_started", data: { call_id: "call_1", mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID } })).status, 201);
  const utter = (grounding: string[]) => ({
    type: "voice.utterance",
    data: { call_id: "call_1", turn_index: 0, speaker: "voice_agent", text: "This is an automated assistant.", grounding_event_ids: grounding, interrupted: false },
  });
  assert.equal((await post(utter([opened]))).status, 201);
  assert.equal((await post(utter(["evt_does-not-exist"]))).status, 400, "ungrounded speech is refused");
  assert.equal((await post(utter([]))).status, 400, "an agent turn must cite something");
});

test("#2 without a configured token the service endpoints are off", async () => {
  const n = await night();
  const res = await new Client(n.app).raw("GET", "/api/service/incidents/inc_x/briefing", undefined, { Authorization: "Bearer x" });
  assert.equal(res.status, 503);
});

// ── 3 and 9. Incident Card; recipients see only what was delivered ──────
test("#3 #9 the host gets the full Incident Card; a backup contact sees only what their alert delivered", async () => {
  const n = await night();
  // Sam invites Priya, who signs in and accepts.
  const invite = await n.sam.call("POST", `/api/sessions/${n.sessionId}/me/backup-contacts/${n.contactId}/invite`);
  assert.equal(invite.status, 201);
  const token = new URL(invite.body.inviteUrl).hash.split("=")[1]!;
  const priya = await signIn(n.app, "priya");
  assert.equal((await priya.call("POST", "/api/contact-invites/accept", { token })).status, 200);

  const incident = await missCheckIn(n);
  n.advance(120 * SEC);
  await n.tick();
  const [toPriya] = (await priya.call("GET", "/api/alerts")).body.alerts;
  assert.ok(toPriya, "Priya's alert reached her inbox");
  assert.equal(toPriya.about, "Sam");

  const hostCard = (await n.maya.call("GET", `/api/incidents/${incident._id}/card`)).body.card;
  assert.equal(hostCard.view, "full");
  assert.ok(types(hostCard.entries).includes("checkin.prompted"));
  assert.ok(types(hostCard.entries).includes("incident.opened"));

  const priyaCard = (await priya.call("GET", `/api/incidents/${incident._id}/card`)).body.card;
  assert.equal(priyaCard.view, "delivered");
  assert.ok(!types(priyaCard.entries).includes("checkin.prompted"), "not delivered to her");
  assert.ok(types(priyaCard.entries).includes("incident.opened"));

  const priyaView = (await priya.call("GET", `/api/incidents/${incident._id}`)).body.incident;
  assert.equal(priyaView.log, undefined, "no internal log for a recipient");
  assert.equal(priyaView.alerts[0].about, "Sam");

  // Priya can acknowledge; the timeline records a backup contact did.
  assert.equal((await priya.call("POST", `/api/alerts/${toPriya.id}/acknowledge`)).status, 200);
  const ack = (await n.deps.timeline.events(n.sessionId)).find((e) => e.type === "incident.acknowledged")!;
  assert.equal((ack.data as { acknowledged_by_role: string }).acknowledged_by_role, "backup_contact");
});

// ── 5. Repeat alert ──────────────────────────────────────────────────────
test("#5 repeating an alert sends it again without moving the escalation deadline, up to a limit", async () => {
  const n = await night();
  const incident = await missCheckIn(n);
  const due = n.store.incidents.get(incident._id)!.steps[1]!.dueAt!.getTime();
  const repeat = () => n.maya.call("POST", `/api/incidents/${incident._id}/repeat`);
  assert.equal((await repeat()).status, 202);
  assert.equal((await repeat()).status, 202);
  assert.equal((await repeat()).body.error.code, "repeat_limit");
  await n.tick();
  assert.equal((await n.maya.call("GET", "/api/alerts")).body.alerts.length, 3);
  assert.equal(n.store.incidents.get(incident._id)!.steps[1]!.dueAt!.getTime(), due);
  const repeats = (await n.deps.timeline.events(n.sessionId)).filter((e) => e.type === "notification.sent" && (e.data as { is_repeat: boolean }).is_repeat);
  assert.equal(repeats.length, 2);
  assert.equal((await n.sam.call("POST", `/api/incidents/${incident._id}/repeat`)).status, 403, "the subject cannot repeat their own alert");
});

// ── 6. Suspend and resume ────────────────────────────────────────────────
test("#6 suspend pauses new check-ins and live location; a pending check-in still escalates; resume restores", async () => {
  const n = await night();
  await n.sam.call("POST", `/api/sessions/${n.sessionId}/checkins`, { reason: "movement_changed" });
  assert.equal((await n.sam.call("POST", `/api/sessions/${n.sessionId}/suspend`)).status, 403, "host only");
  const s = await n.maya.call("POST", `/api/sessions/${n.sessionId}/suspend`);
  assert.equal(s.body.session.suspended, true);

  const fix = { latitude: 1, longitude: 1, accuracyM: 5, fixAt: n.deps.now().toISOString() };
  assert.equal((await n.sam.call("POST", `/api/sessions/${n.sessionId}/location`, fix)).body.reason, "session_suspended");
  n.advance(61 * SEC);
  const pass = await n.tick();
  assert.equal(pass.checkInsMissed, 1, "the pending deadline was not cancelled");
  assert.equal(n.store.incidents.size, 1);

  n.advance(10 * 60 * SEC);
  assert.equal((await n.tick()).devicesWentSilent, 0, "silence is expected while suspended");
  assert.equal((await n.maya.call("POST", `/api/sessions/${n.sessionId}/resume`)).body.session.suspended, false);
});

// ── 7. De-duplication ────────────────────────────────────────────────────
test("#7 a resent event or item is stored once", async () => {
  const n = await night();
  const t = timeline(n.sessionId);
  const event = t.append({
    type: "consent.granted",
    participant_id: n.samPid,
    actor: { kind: "participant", id: n.samPid },
    provenance: UI,
    data: { scopes: ["monitoring"], consent_text_version: V },
  });
  const send = (items: unknown[]) => n.sam.call("POST", "/api/ingest", { items });
  assert.equal((await send([{ kind: "event", sessionId: n.sessionId, data: event }])).body.accepted, 1);
  assert.equal((await send([{ kind: "event", sessionId: n.sessionId, data: event }])).body.duplicates, 1);
  const log = { kind: "log", dataOrigin: "live_device", clientItemId: "log-1", data: { msg: "hello" } };
  assert.equal((await send([log, log])).body.duplicates, 1);
});

// ── 8. Data origin, raw vs derived ───────────────────────────────────────
test("#8 data must say where it came from; raw sensor samples are stored apart from derived features", async () => {
  const n = await night();
  const send = (items: unknown[]) => n.sam.call("POST", "/api/ingest", { items });
  const res = await send([
    { kind: "log", data: { msg: "x" } },
    { kind: "sensor", dataOrigin: "live_device", data: { x: 1 } },
    { kind: "sensor", sessionId: n.sessionId, dataOrigin: "live_device", dataClass: "raw", units: "m/s^2", data: { t: [0, 1], x: [0.1, 0.2] } },
    { kind: "sensor", sessionId: n.sessionId, dataOrigin: "synthetic_scenario", dataClass: "derived", units: "m/s^2", data: { mean: 0.15 } },
  ]);
  assert.deepEqual(res.body.rejected.map((r: { code: string }) => r.code), ["data_origin_required", "sensor_metadata_required"]);
  assert.equal(n.store.rawRecordings.length, 1);
  assert.equal(n.store.traces.filter((t) => t.kind === "sensor").length, 1);
  assert.equal(n.store.traces.find((t) => t.kind === "sensor")!.dataOrigin, "synthetic_scenario");
  const exported = (await (await n.sam.raw("GET", "/api/me/export")).json()) as { rawRecordings: unknown[] };
  assert.equal(exported.rawRecordings.length, 1);
});

// ── 10. Consent audit trail ──────────────────────────────────────────────
test("#10 every consent choice is recorded with its text version and time, and exported", async () => {
  const n = await night();
  const noVersion = await n.sam.call("PATCH", `/api/sessions/${n.sessionId}/me/consent`, CONSENT);
  assert.equal(noVersion.status, 400, "the consent text version is required");
  await n.sam.call("PATCH", `/api/sessions/${n.sessionId}/me/consent`, { ...CONSENT, locationSharing: "off", shareLocationWithResponders: false, consentTextVersion: "consent-v2" });
  await n.sam.call("PATCH", `/api/sessions/${n.sessionId}/me/consent`, { ...CONSENT, consentTextVersion: "consent-v2" });
  const mine = (await n.deps.timeline.events(n.sessionId)).filter((e) => e.participant_id === n.samPid && e.type.startsWith("consent."));
  assert.deepEqual(types(mine), ["consent.granted", "consent.revoked", "consent.granted"]);
  assert.equal((mine[2]!.data as { consent_text_version: string }).consent_text_version, "consent-v2");
  const exported = (await (await n.sam.raw("GET", "/api/me/export")).json()) as { timelineEvents: { type: string }[]; sessions: { me: { consentTextVersion: string } }[] };
  assert.equal(exported.timelineEvents.filter((e) => e.type.startsWith("consent.")).length, 3);
  assert.equal(exported.sessions[0]!.me.consentTextVersion, "consent-v2");
});

// ── 11. Viewed ───────────────────────────────────────────────────────────
test('#11 "viewed" is recorded once and is not an acknowledgment', async () => {
  const n = await night();
  const incident = await missCheckIn(n);
  const [alert] = (await n.maya.call("GET", "/api/alerts")).body.alerts;
  assert.equal(alert.viewedAt, null);
  await n.maya.call("POST", `/api/alerts/${alert.id}/viewed`);
  await n.maya.call("POST", `/api/alerts/${alert.id}/viewed`);
  assert.ok((await n.maya.call("GET", "/api/alerts")).body.alerts[0].viewedAt);
  assert.equal(n.store.incidents.get(incident._id)!.status, "open");
  assert.equal((await n.deps.timeline.events(n.sessionId)).filter((e) => e.type === "notification.viewed").length, 1);
});

// ── 13. Backup contact invites ───────────────────────────────────────────
test("#13 only the owner can invite a contact; an invite works once and never for yourself", async () => {
  const n = await night();
  assert.equal((await n.maya.call("POST", `/api/sessions/${n.sessionId}/me/backup-contacts/${n.contactId}/invite`)).status, 404);
  const invite = await n.sam.call("POST", `/api/sessions/${n.sessionId}/me/backup-contacts/${n.contactId}/invite`);
  const token = new URL(invite.body.inviteUrl).hash.split("=")[1]!;
  assert.equal((await n.sam.call("POST", "/api/contact-invites/accept", { token })).body.error.code, "own_invite");
  const priya = await signIn(n.app, "priya");
  assert.equal((await priya.call("GET", `/api/contact-invites/${token}`)).body.invite.from, "Sam");
  assert.equal((await priya.call("POST", "/api/contact-invites/accept", { token })).status, 200);
  const jo = await signIn(n.app, "jo");
  assert.equal((await jo.call("POST", "/api/contact-invites/accept", { token })).status, 404, "used once");
  assert.ok(n.store.invites.size === 1 && [...n.store.invites.keys()][0] !== token, "only the hash is stored");
});

test("#13 rate limits answer 429 with Retry-After", async () => {
  const n = await night();
  let last;
  for (let i = 0; i < 31; i++) last = await n.sam.raw("GET", `/api/sessions/join/${n.code}`);
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get("Retry-After")) > 0);
});

test("GitHub sign-in is not offered", async () => {
  const n = await night();
  assert.equal((await new Client(n.app).raw("GET", "/api/auth/github/start")).status, 404);
  assert.ok(!(await new Client(n.app).call("GET", "/api/auth/providers")).body.providers.includes("github"));
});

// ── Deletion keeps the chain verifiable ──────────────────────────────────
test("deleting an account removes the person from other sessions' timelines and re-seals the chain", async () => {
  const n = await night();
  await missCheckIn(n);
  const jo = await signIn(n.app, "jo");
  await jo.call("POST", "/api/sessions/join", { code: n.code, consent: CONSENT, consentTextVersion: V });
  // Maya resolves Sam's alert so Sam's data can go; then Sam deletes their account.
  const [alert] = (await n.maya.call("GET", "/api/alerts")).body.alerts;
  await n.maya.call("POST", `/api/alerts/${alert.id}/acknowledge`);
  await n.maya.call("POST", `/api/incidents/${alert.incidentId}/resolve`, { outcome: "false_alarm" });
  const res = await n.sam.call("DELETE", "/api/me", { confirm: "DELETE" });
  assert.ok(res.body.deleted.timelineEvents > 0);

  const events = n.store.timelines.get(n.sessionId)!;
  assert.ok(!JSON.stringify(events).includes(n.samPid), "nothing about Sam remains");
  assert.equal(restore(n.sessionId, events).length, events.length, "the re-sealed chain verifies");
  assert.ok(types(events).includes("session.created"));
});

// ── 12. Serverless tick ──────────────────────────────────────────────────
test("#12 the cron tick needs its secret and runs a scheduler pass", async () => {
  const n = await night({ env: { CRON_SECRET: "cron-secret-1" } });
  const c = new Client(n.app);
  assert.equal((await c.raw("GET", "/api/internal/tick")).status, 401);
  const ok = await c.raw("GET", "/api/internal/tick", undefined, { Authorization: "Bearer cron-secret-1" });
  assert.equal(ok.status, 200);
  assert.ok("pass" in ((await ok.json()) as object));
});
