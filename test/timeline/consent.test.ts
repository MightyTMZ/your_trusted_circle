import { test } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import { ConsentLedger, Timeline, type ConsentScope, type Provenance } from "../../src/timeline/index.js";

const T0 = Date.UTC(2026, 9, 17, 23, 0, 0, 0);
const P = "par_0001";
const UI: Provenance = { component: "ui", data_origin: "synthetic_scenario", simulated: false };

function setup() {
  return new Timeline({ sessionId: "ses_0001", clock: new ManualClock(T0), ids: new SequentialIds() });
}

const grant = (t: Timeline, scopes: ConsentScope[]) =>
  t.append({
    type: "consent.granted",
    participant_id: P,
    actor: { kind: "participant", id: P },
    provenance: UI,
    data: { scopes, consent_text_version: "v1" },
  });

const fix = (t: Timeline) =>
  t.append({
    type: "location.reported",
    participant_id: P,
    actor: { kind: "participant", id: P },
    provenance: { component: "sensor_adapter", data_origin: "synthetic_scenario", simulated: false },
    data: {
      latitude: 43.66,
      longitude: -79.39,
      accuracy_m: 10,
      fix_at: "2026-10-17T23:00:00.000Z",
      source: "synthetic",
      speed_m_s: 1.3,
      heading_deg: 90,
    },
  });

const window = (t: Timeline) =>
  t.append({
    type: "sensor.motion_window",
    participant_id: P,
    actor: { kind: "detector", id: null },
    provenance: { component: "sensor_adapter", data_origin: "synthetic_scenario", simulated: false, raw_ref: "rec_0001#1" },
    data: {
      window_start: "2026-10-17T22:59:00.000Z",
      window_end: "2026-10-17T23:00:00.000Z",
      sample_count: 600,
      rejected_sample_count: 0,
      effective_rate_hz: 10,
      coverage_ratio: 1,
      max_gap_ms: 100,
      clipped_sample_count: 0,
      dynamic_mean_m_s2: 0.8,
      dynamic_std_m_s2: 0.4,
      dynamic_peak_m_s2: 3.1,
      stillness_ratio: 0.05,
      longest_still_ms: 300,
      cadence_hz: 1.8,
      rhythm_regularity: 0.7,
      impact_count: 0,
      impacts: [],
      gravity_vector_m_s2: [0.1, 9.5, 2.4],
      tilt_change_deg: null,
      activity_level: "moderate",
    },
  });

test("sensor data is refused until the participant consents to monitoring", () => {
  const t = setup();
  assert.throws(() => window(t), /has not granted monitoring/);
  grant(t, ["monitoring"]);
  assert.doesNotThrow(() => window(t));
});

test("location is refused without a location-sharing scope", () => {
  const t = setup();
  grant(t, ["monitoring"]);
  assert.throws(() => fix(t), /location.group or location.responders/);
  grant(t, ["location.group"]);
  assert.match(fix(t).summary, /speed 1.3 m\/s heading 90°/);
});

test("revoking or leaving stops further recording", () => {
  const t = setup();
  grant(t, ["monitoring", "location.group"]);
  t.append({
    type: "consent.revoked",
    participant_id: P,
    actor: { kind: "participant", id: P },
    provenance: UI,
    data: { scopes: ["location.group"] },
  });
  assert.throws(() => fix(t), /has not granted/);
  assert.doesNotThrow(() => window(t));
  t.append({
    type: "session.participant_left",
    participant_id: P,
    actor: { kind: "participant", id: P },
    provenance: UI,
    data: { reason: "voluntary" },
  });
  assert.throws(() => window(t), /has not granted monitoring/);
});

test("ConsentLedger replays grants, revocations and departures", () => {
  const t = setup();
  grant(t, ["monitoring", "location.responders"]);
  const ledger = ConsentLedger.from(t.events);
  assert.deepEqual(ledger.scopesOf(P).sort(), ["location.responders", "monitoring"]);
  assert.equal(ledger.hasAny(P, ["location.group", "location.responders"]), true);
  assert.equal(ledger.has("par_9999", "monitoring"), false);
});
