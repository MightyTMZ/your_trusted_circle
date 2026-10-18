import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BriefingError,
  buildOperatorBriefing,
  evidenceToJsonl,
  selectEvidence,
  timelineFromJsonl,
  toJsonl,
} from "../../src/timeline/index.js";
import {
  FIXTURE_INCIDENT_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_START_MS,
  buildNoResponseScenario,
} from "../../src/timeline/fixtures/no-response.js";
import { ManualClock } from "../../src/shared/clock.js";

const SAM = "par_0002";

function brief(motionLookbackMs?: number) {
  const fixture = buildNoResponseScenario();
  const briefing = buildOperatorBriefing(fixture.timeline.events, {
    incidentId: FIXTURE_INCIDENT_ID,
    now: fixture.clock.now(),
    ...(motionLookbackMs === undefined ? {} : { motionLookbackMs }),
  });
  return { ...fixture, briefing };
}

const rebrief = (f: ReturnType<typeof brief>) =>
  buildOperatorBriefing(f.timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: f.clock.now() });

test("incident, escalation and alert state are derived from the log", () => {
  const { briefing, ids } = brief();
  assert.equal(briefing.participant_id, SAM);
  assert.equal(briefing.incident.state, "open");
  assert.equal(briefing.incident.trigger, "checkin_missed");
  assert.equal(briefing.incident.source_event_id, ids.opened.event_id);
  assert.equal(briefing.device.status, "offline");
  assert.equal(briefing.escalation.simulated_emergency_requested, true);
  assert.deepEqual(briefing.escalation.pending, []);
  assert.deepEqual(briefing.escalation.fired.map((s) => s.target_role), ["participant", "emergency_service_sim"]);
  const [host, , backup] = briefing.alerts;
  assert.deepEqual(
    { attempts: host!.attempts, delivered: host!.delivered, viewed: host!.viewed, acknowledged: host!.acknowledged },
    { attempts: 2, delivered: true, viewed: true, acknowledged: false },
  );
  assert.equal(backup!.delivery_failed, true);
});

test("location is the last fix with velocity and age, never current", () => {
  const { briefing, clock, ids } = brief();
  const loc = briefing.location.last_known!;
  assert.equal(briefing.location.is_current, false);
  assert.equal(loc.source_event_id, ids.lastFix.event_id);
  assert.equal(loc.speed_m_s, 0.9);
  assert.equal(loc.heading_deg, 100);
  assert.equal(loc.age_ms, clock.now() - (FIXTURE_START_MS + 230 * 60_000 + 30_000));
  assert.ok(briefing.unknowns.some((u) => u.startsWith("Current location is unknown")));
});

test("motion section explains why the check-in was sent", () => {
  const { briefing, ids } = brief();
  const { baseline, observation, latest_window } = briefing.motion;
  assert.equal(baseline!.source_event_id, ids.baseline.event_id);
  assert.equal(observation!.source_event_id, ids.anomaly.event_id);
  assert.ok(observation!.z_score <= -3, `z = ${observation!.z_score}`);
  // The newest window is the partial one cut short when the phone dropped off at 23:52:40.
  assert.equal(latest_window!.window_end, "2026-10-17T23:53:00.000Z");
  assert.ok(latest_window!.stillness_ratio > 0.9);
  assert.ok(latest_window!.coverage_ratio < 0.7);
  // The phone stopped sending data 11 minutes before the briefing.
  assert.ok(briefing.unknowns.some((u) => u.startsWith("No motion data has arrived since")));
});

test("evidence is the permitted timeline lines, and every reference resolves into it", () => {
  const { briefing, timeline } = brief();
  const evidence = selectEvidence(timeline.events, briefing);
  assert.deepEqual(evidence.map((e) => e.event_id), briefing.evidence.event_ids);
  const lines = evidenceToJsonl(timeline.events, briefing).trim().split("\n");
  assert.equal(lines.length, evidence.length);
  const permitted = new Set(briefing.evidence.event_ids);
  const refs = [...JSON.stringify(briefing).matchAll(/"source_event_id":"(evt_\d+)"/g)].map((m) => m[1]!);
  assert.ok(refs.length >= 8);
  for (const ref of refs) assert.ok(permitted.has(ref), `${ref} not in evidence`);
});

test("old motion windows stay in the timeline but drop out of the evidence, except the newest", () => {
  const windowsIn = (b: ReturnType<typeof brief>) =>
    selectEvidence(b.timeline.events, b.briefing).filter((e) => e.type === "sensor.motion_window").length;
  const all = brief().timeline.events.filter((e) => e.type === "sensor.motion_window").length;
  assert.equal(all, 226, "four hours, minus the 7 minutes the app was backgrounded");
  // Phone went silent 11 min before the briefing: only the newest (stale) window survives a 10 min lookback.
  assert.equal(windowsIn(brief()), 1);
  assert.equal(windowsIn(brief(20 * 60_000)), 9);
});

test("other participants' events never reach the evidence", () => {
  const { briefing, timeline } = brief();
  const permitted = new Set(briefing.evidence.event_ids);
  const foreign = timeline.events.filter((e) => e.participant_id && e.participant_id !== SAM && e.type !== "session.created");
  assert.ok(foreign.length > 0);
  for (const e of foreign) assert.ok(!permitted.has(e.event_id), `${e.type} for ${e.participant_id} leaked`);
});

test("revoking responder location consent withholds every location detail", () => {
  const f = brief();
  f.timeline.append({
    type: "consent.revoked",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: { component: "ui", data_origin: "synthetic_scenario", simulated: false },
    data: { scopes: ["location.responders"] },
  });
  const briefing = rebrief(f);
  assert.equal(briefing.location.status, "not_consented");
  assert.equal(briefing.evidence.redacted.filter((r) => r.type === "location.reported").length, 7);
  const visible = JSON.stringify(briefing) + evidenceToJsonl(f.timeline.events, briefing);
  assert.ok(!visible.includes("43.6629") && !visible.includes("Synthetic Venue A"));
});

test("leaving the session withdraws person details and location", () => {
  const f = brief();
  f.timeline.append({
    type: "session.participant_left",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: { component: "session_manager", data_origin: "synthetic_scenario", simulated: false },
    data: { reason: "voluntary" },
  });
  const briefing = rebrief(f);
  assert.equal(briefing.person.status, "not_consented");
  assert.equal(briefing.person.details, null);
  assert.equal(briefing.location.status, "not_consented");
});

test("acknowledgment changes state but is never reported as safety", () => {
  const f = brief();
  f.clock.advance(30_000);
  f.timeline.append({
    type: "incident.acknowledged",
    incident_id: FIXTURE_INCIDENT_ID,
    participant_id: SAM,
    actor: { kind: "participant", id: "par_0003" },
    provenance: { component: "transport_sim", data_origin: "synthetic_scenario", simulated: true },
    data: { acknowledged_by_role: "participant", acknowledged_by_id: "par_0003", notification_id: "ntf_0003" },
  });
  const briefing = rebrief(f);
  assert.equal(briefing.incident.state, "acknowledged");
  assert.equal(briefing.alerts[1]!.acknowledged, true);
  assert.ok(!briefing.unknowns.some((u) => u.includes("No responder")));
  assert.ok(briefing.unknowns.some((u) => u.includes("condition")));
  const ack = f.timeline.getEvent(briefing.incident.acknowledged!.source_event_id)!;
  assert.ok(ack.summary.includes("does not indicate the participant's condition"));
});

test("unknown incidents are rejected", () => {
  const { timeline, clock } = brief();
  assert.throws(() => buildOperatorBriefing(timeline.events, { incidentId: "inc_9999", now: clock.now() }), BriefingError);
});

test("committed examples match the fixture (run `npm run examples` to regenerate)", () => {
  const { timeline, briefing } = brief();
  const read = (name: string) => readFileSync(join(process.cwd(), "docs/examples", name), "utf8");
  assert.equal(read("no-response-incident.jsonl"), toJsonl(timeline.events));
  assert.equal(read("no-response-briefing.json"), `${JSON.stringify(briefing, null, 2)}\n`);
  const restored = timelineFromJsonl(read("no-response-incident.jsonl"), {
    sessionId: FIXTURE_SESSION_ID,
    clock: new ManualClock(FIXTURE_START_MS),
  });
  assert.equal(restored.headHash, timeline.headHash);
});

test("the briefing carries the night's activity history, recent patterns and precise unknowns", () => {
  const { briefing, ids } = brief();
  const { history, patterns, config_source_event_id } = briefing.motion;
  assert.ok(config_source_event_id);
  assert.equal(history.segments.at(-1)!.activity, "no_data", "the phone has been offline since 23:53");
  assert.ok(history.segments.some((s) => s.activity === "vigorous" && s.duration_ms === 78 * 60_000));
  assert.ok(patterns.some((p) => p.pattern === "impact_then_stillness" && p.impact_peak_clipped && p.source_event_id === ids.impactPattern.event_id));
  assert.ok(briefing.unknowns.some((u) => u.includes("saturated the sensor")));
  // The 21:01 false alarm was answered; the 23:52 check-in was not, and that is what is reported.
  assert.ok(briefing.unknowns.includes("The participant has not answered the check-in sent at 2026-10-17T23:52:02.000Z."));
});
