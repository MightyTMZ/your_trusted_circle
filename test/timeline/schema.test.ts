import { test } from "node:test";
import assert from "node:assert/strict";
import { v, validate } from "../../src/timeline/schema/validate.js";
import {
  EVENT_CATALOG,
  EVENT_TYPES,
  categoryOf,
  checkTypedFields,
  type PayloadOf,
  type ScopedFields,
} from "../../src/timeline/schema/catalog.js";
import { MOCK_OPERATOR_ENDPOINT_ID } from "../../src/timeline/schema/envelope.js";

const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

test("object schemas reject unknown fields and missing required ones", () => {
  const s = v.object({ a: v.string(), b: v.optional(v.number()) });
  assert.deepEqual(validate(s, { a: "x" }), []);
  assert.deepEqual(paths(validate(s, { a: "x", extra: 1 })), ["extra"]);
  assert.deepEqual(paths(validate(s, {})), ["a"]);
  assert.deepEqual(paths(validate(s, { a: "x", b: "nope" })), ["b"]);
});

test("timestamps must be canonical ISO UTC with milliseconds", () => {
  assert.deepEqual(validate(v.timestamp(), "2026-10-17T23:41:05.120Z"), []);
  assert.equal(validate(v.timestamp(), "2026-10-17T23:41:05Z").length, 1);
  assert.equal(validate(v.timestamp(), 1760744465120).length, 1);
});

test("payload types are inferred from the catalog", () => {
  const ok: PayloadOf<"checkin.responded"> = {
    checkin_id: "chk_0001",
    response: "duress",
    method: "pin",
    latency_ms: 4200,
  };
  // @ts-expect-error unknown response value is a compile error
  const bad: PayloadOf<"checkin.responded"> = { ...ok, response: "fine" };
  assert.ok(ok && bad);
});

test("every catalog type has a dotted name and a category", () => {
  for (const type of EVENT_TYPES) {
    assert.match(type, /^[a-z]+\.[a-z_]+$/);
    assert.ok(categoryOf(type).length > 0);
    assert.ok(EVENT_CATALOG[type].description.length > 0);
  }
});

function fields(overrides: Partial<ScopedFields>): ScopedFields {
  return {
    type: "checkin.missed",
    incident_id: null,
    participant_id: "par_0001",
    actor: { kind: "scheduler", id: null },
    provenance: { component: "escalation_scheduler", data_origin: "system_generated", simulated: false },
    data: { checkin_id: "chk_0001", response_deadline_at: "2026-10-17T23:45:00.000Z" },
    ...overrides,
  };
}

test("checkTypedFields accepts a valid event", () => {
  assert.deepEqual(checkTypedFields(fields({})), []);
});

test("checkTypedFields rejects unknown types", () => {
  assert.deepEqual(paths(checkTypedFields(fields({ type: "checkin.vibes" }))), ["type"]);
});

test("incident-scoped events require an incident_id", () => {
  const issues = checkTypedFields(
    fields({
      type: "escalation.step_cancelled",
      data: { escalation_id: "esc_0001", step: 1, reason: "acknowledged" },
    }),
  );
  assert.deepEqual(paths(issues), ["incident_id"]);
});

test("emergency and voice events must be flagged simulated", () => {
  const issues = checkTypedFields(
    fields({
      type: "voice.call_started",
      incident_id: "inc_0001",
      actor: { kind: "voice_agent", id: null },
      provenance: { component: "voice_agent", data_origin: "system_generated", simulated: false },
      data: { call_id: "call_0001", mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID },
    }),
  );
  assert.deepEqual(paths(issues), ["provenance.simulated"]);
});

test("the mock operator endpoint is the only allowed call target", () => {
  const issues = checkTypedFields(
    fields({
      type: "voice.call_started",
      incident_id: "inc_0001",
      provenance: { component: "voice_agent", data_origin: "system_generated", simulated: true },
      data: { call_id: "call_0001", mock_endpoint_id: "some-real-endpoint" },
    }),
  );
  assert.deepEqual(paths(issues), ["data.mock_endpoint_id"]);
});

test("the host cannot grant consent on behalf of another participant", () => {
  const consent = {
    type: "consent.granted",
    data: { scopes: ["monitoring"], consent_text_version: "v1" },
  };
  assert.deepEqual(
    checkTypedFields(fields({ ...consent, actor: { kind: "participant", id: "par_0001" } })),
    [],
  );
  assert.deepEqual(
    paths(checkTypedFields(fields({ ...consent, actor: { kind: "host", id: "par_0002" } }))),
    ["actor"],
  );
});

test("agent utterances must cite grounding events", () => {
  const utterance = (speaker: string, grounding: string[]) =>
    checkTypedFields(
      fields({
        type: "voice.utterance",
        incident_id: "inc_0001",
        provenance: { component: "voice_agent", data_origin: "system_generated", simulated: true },
        data: {
          call_id: "call_0001",
          turn_index: 0,
          speaker,
          text: "Hello",
          grounding_event_ids: grounding,
          interrupted: false,
        },
      }),
    );
  assert.deepEqual(paths(utterance("voice_agent", [])), ["data.grounding_event_ids"]);
  assert.deepEqual(utterance("voice_agent", ["evt_0001"]), []);
  assert.deepEqual(utterance("mock_operator", []), []);
});

test("motion thresholds must be labelled unvalidated", () => {
  const issues = checkTypedFields(
    fields({
      type: "sensor.motion_anomaly_observed",
      actor: { kind: "detector", id: null },
      data: {
        feature: "accel_magnitude_rms",
        unit: "m/s^2",
        observed_value: 0.05,
        baseline_mean: 1.2,
        baseline_std_dev: 0.3,
        z_score: -3.83,
        window_start: "2026-10-17T23:39:00.000Z",
        window_end: "2026-10-17T23:41:00.000Z",
        rule: { id: "stillness-z", comparator: "<=", threshold: -3, threshold_validated: true },
      },
    }),
  );
  assert.deepEqual(paths(issues), ["data.rule.threshold_validated"]);
});

test("repeat flag must agree with attempt number", () => {
  const sent = (attempt: number, is_repeat: boolean) =>
    checkTypedFields(
      fields({
        type: "notification.sent",
        incident_id: "inc_0001",
        data: {
          notification_id: "ntf_0001",
          recipient_id: "par_0002",
          recipient_role: "host",
          channel: "in_app_sim",
          escalation_step: 1,
          attempt,
          is_repeat,
          delivered_fact_event_ids: [],
        },
      }),
    );
  assert.deepEqual(sent(1, false), []);
  assert.deepEqual(sent(2, true), []);
  assert.deepEqual(paths(sent(2, false)), ["data.is_repeat"]);
});
