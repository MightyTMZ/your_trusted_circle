import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BriefingError,
  buildOperatorBriefing,
  factsToJsonl,
  timelineFromJsonl,
  toJsonl,
} from "../../src/timeline/index.js";
import {
  FIXTURE_INCIDENT_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_START_MS,
  buildNoResponseTimeline,
} from "../../src/timeline/fixtures/no-response.js";
import { ManualClock } from "../../src/shared/clock.js";

const SAM = "par_0002";

function brief() {
  const fixture = buildNoResponseTimeline();
  const briefing = buildOperatorBriefing(fixture.timeline.events, {
    incidentId: FIXTURE_INCIDENT_ID,
    now: fixture.clock.now(),
  });
  return { ...fixture, briefing };
}

test("briefing reflects the open, unacknowledged incident", () => {
  const { briefing, ids } = brief();
  assert.equal(briefing.schema, "ypc.operator_briefing");
  assert.equal(briefing.participant_id, SAM);
  assert.equal(briefing.incident.state, "open");
  assert.equal(briefing.incident.trigger, "checkin_missed");
  assert.equal(briefing.incident.source_event_id, ids.opened.event_id);
  assert.equal(briefing.incident.acknowledged, null);
  assert.equal(briefing.device.status, "offline");
  assert.equal(briefing.escalation.simulated_emergency_requested, true);
  assert.deepEqual(briefing.escalation.pending_steps, []);
  assert.deepEqual(
    briefing.escalation.fired_steps.map((s) => s.target_role),
    ["backup_contact", "emergency_service_sim"],
  );
});

test("notification status tracks repeats, delivery and failures", () => {
  const { briefing } = brief();
  const [host, backup] = briefing.notifications;
  assert.equal(host!.recipient_role, "host");
  assert.equal(host!.attempts, 2);
  assert.equal(host!.delivered, true);
  assert.equal(host!.acknowledged, false);
  assert.equal(backup!.recipient_role, "backup_contact");
  assert.equal(backup!.delivery_failed, true);
});

test("location is last-known with its age, never current", () => {
  const { briefing, clock, ids } = brief();
  assert.equal(briefing.location.status, "last_known");
  assert.equal(briefing.location.is_current, false);
  assert.equal(briefing.location.last_known!.source_event_id, ids.fix.event_id);
  assert.equal(briefing.location.last_known!.age_ms, clock.now() - (FIXTURE_START_MS + 40 * 60_000));
  assert.ok(briefing.unknowns.some((u) => u.startsWith("Current location is unknown")));
});

test("every fact cites a real event and reuses its rendered summary", () => {
  const { briefing, timeline } = brief();
  assert.ok(briefing.facts.length > 0);
  for (const fact of briefing.facts) {
    const source = timeline.getEvent(fact.event_id);
    assert.ok(source, `${fact.event_id} should exist`);
    assert.equal(fact.statement, source.summary);
    assert.equal(fact.occurred_at, source.occurred_at);
  }
  const lines = factsToJsonl(briefing).trim().split("\n");
  assert.equal(lines.length, briefing.facts.length);
  assert.ok(lines.every((l) => typeof JSON.parse(l).event_id === "string"));
});

test("other participants' events never appear in the briefing", () => {
  const { briefing, timeline } = brief();
  const foreign = timeline.events.filter(
    (e) => e.participant_id !== null && e.participant_id !== SAM && e.type !== "session.created",
  );
  assert.ok(foreign.length > 0);
  const cited = new Set(briefing.facts.map((f) => f.event_id));
  for (const e of foreign) assert.ok(!cited.has(e.event_id), `${e.type} for ${e.participant_id} leaked`);
});

test("revoking responder location consent redacts every location detail", () => {
  const { timeline, clock } = brief();
  timeline.append({
    type: "consent.revoked",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: { component: "ui", data_origin: "synthetic_scenario", simulated: false },
    data: { scopes: ["location.responders"] },
  });
  const briefing = buildOperatorBriefing(timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: clock.now() });
  assert.equal(briefing.location.status, "not_consented");
  assert.equal(briefing.location.last_known, null);
  assert.ok(briefing.redactions.some((r) => r.type === "location.reported"));
  const text = JSON.stringify(briefing);
  assert.ok(!text.includes("43.6629"));
  assert.ok(!text.includes("Synthetic Venue A"));
});

test("leaving the session withdraws profile and location disclosure", () => {
  const { timeline, clock } = brief();
  timeline.append({
    type: "session.participant_left",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: { component: "session_manager", data_origin: "synthetic_scenario", simulated: false },
    data: { reason: "voluntary" },
  });
  const briefing = buildOperatorBriefing(timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: clock.now() });
  assert.equal(briefing.participant.profile_status, "not_consented");
  assert.equal(briefing.participant.profile, null);
  assert.equal(briefing.location.status, "not_consented");
});

test("acknowledgment changes state but is not reported as safety", () => {
  const { timeline, clock } = brief();
  clock.advance(30_000);
  timeline.append({
    type: "incident.acknowledged",
    incident_id: FIXTURE_INCIDENT_ID,
    participant_id: SAM,
    actor: { kind: "backup_contact", id: "con_0001" },
    provenance: { component: "transport_sim", data_origin: "synthetic_scenario", simulated: true },
    data: { acknowledged_by_role: "backup_contact", acknowledged_by_id: "con_0001", notification_id: "ntf_0002" },
  });
  const briefing = buildOperatorBriefing(timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: clock.now() });
  assert.equal(briefing.incident.state, "acknowledged");
  assert.equal(briefing.incident.acknowledged!.by_id, "con_0001");
  assert.equal(briefing.notifications[1]!.acknowledged, true);
  assert.ok(!briefing.unknowns.some((u) => u.includes("No responder")));
  assert.ok(briefing.unknowns.some((u) => u.includes("medical condition")));
  assert.ok(briefing.facts.at(-1)!.statement.includes("does not indicate the participant's condition"));
});

test("unknown incidents are rejected", () => {
  const { timeline, clock } = brief();
  assert.throws(() => buildOperatorBriefing(timeline.events, { incidentId: "inc_9999", now: clock.now() }), BriefingError);
});

test("committed example JSONL matches the fixture and verifies", () => {
  const { timeline } = brief();
  const committed = readFileSync(join(process.cwd(), "docs/examples/no-response-incident.jsonl"), "utf8");
  assert.equal(committed, toJsonl(timeline.events), "run `npm run example:timeline` to regenerate");
  const restored = timelineFromJsonl(committed, { sessionId: FIXTURE_SESSION_ID, clock: new ManualClock(FIXTURE_START_MS) });
  assert.equal(restored.headHash, timeline.headHash);
});
