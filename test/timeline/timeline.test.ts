import { test } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import { MemorySink, Timeline, TimelineError, hashEvent, type Provenance } from "../../src/timeline/index.js";

const T0 = Date.UTC(2026, 9, 17, 23, 0, 0, 0);
const SYSTEM: Provenance = { component: "session_manager", data_origin: "system_generated", simulated: false };

function setup() {
  const clock = new ManualClock(T0);
  const sink = new MemorySink();
  const timeline = new Timeline({ sessionId: "ses_0001", clock, ids: new SequentialIds(), sinks: [sink] });
  return { clock, sink, timeline };
}

function join(timeline: Timeline, participant: string) {
  return timeline.append({
    type: "session.participant_joined",
    participant_id: participant,
    actor: { kind: "participant", id: participant },
    provenance: SYSTEM,
    data: { role: "member", joined_via: "invite_link" },
  });
}

function missedCheckin(timeline: Timeline, causedBy: string[] = []) {
  return timeline.append({
    type: "checkin.missed",
    participant_id: "par_0001",
    actor: { kind: "scheduler", id: null },
    provenance: { component: "escalation_scheduler", data_origin: "system_generated", simulated: false },
    caused_by: causedBy,
    data: { checkin_id: "chk_0001", response_deadline_at: "2026-10-17T23:00:00.000Z" },
  });
}

test("append fills envelope fields from the injected clock and ids", () => {
  const { clock, timeline } = setup();
  clock.advance(1_500);
  const e = join(timeline, "par_0001");
  assert.equal(e.event_id, "evt_0001");
  assert.equal(e.seq, 1);
  assert.equal(e.category, "session");
  assert.equal(e.session_id, "ses_0001");
  assert.equal(e.recorded_at, "2026-10-17T23:00:01.500Z");
  assert.equal(e.occurred_at, e.recorded_at);
  assert.equal(e.prev_hash, null);
  assert.equal(e.summary, "Participant par_0001 joined as member via invite_link.");
  assert.equal(e.hash, hashEvent(e));
});

test("events are hash-chained, sequenced and frozen", () => {
  const { timeline } = setup();
  const a = join(timeline, "par_0001");
  const b = join(timeline, "par_0002");
  assert.equal(b.seq, 2);
  assert.equal(b.prev_hash, a.hash);
  assert.equal(timeline.headHash, b.hash);
  assert.throws(() => {
    (b as { seq: number }).seq = 99;
  }, TypeError);
});

test("every appended event is written to sinks as one JSONL line", () => {
  const { sink, timeline } = setup();
  join(timeline, "par_0001");
  join(timeline, "par_0002");
  assert.equal(sink.lines.length, 2);
  assert.equal(JSON.parse(sink.lines[1]!).event_id, "evt_0002");
  assert.ok(sink.toJsonl().endsWith("\n"));
});

test("invalid payloads are rejected and nothing is written", () => {
  const { sink, timeline } = setup();
  assert.throws(
    () =>
      timeline.append({
        type: "session.participant_joined",
        participant_id: "par_0001",
        actor: { kind: "participant", id: "par_0001" },
        provenance: SYSTEM,
        data: { role: "admin" } as never,
      }),
    TimelineError,
  );
  assert.equal(timeline.length, 0);
  assert.equal(sink.lines.length, 0);
});

test("a failing sink prevents the commit", () => {
  const clock = new ManualClock(T0);
  const timeline = new Timeline({
    sessionId: "ses_0001",
    clock,
    sinks: [{ write: () => { throw new Error("disk full"); } }],
  });
  assert.throws(() => join(timeline, "par_0001"), /disk full/);
  assert.equal(timeline.length, 0);
});

test("caused_by must reference earlier events", () => {
  const { timeline } = setup();
  assert.throws(() => missedCheckin(timeline, ["evt_9999"]), /not an earlier event/);
  const joined = join(timeline, "par_0001");
  assert.deepEqual(missedCheckin(timeline, [joined.event_id]).caused_by, [joined.event_id]);
});

test("occurred_at may not be in the future beyond the skew tolerance", () => {
  const { timeline } = setup();
  assert.throws(
    () =>
      timeline.append({
        type: "checkin.missed",
        participant_id: "par_0001",
        occurred_at: T0 + 60_000,
        actor: { kind: "scheduler", id: null },
        provenance: SYSTEM,
        data: { checkin_id: "chk_0001", response_deadline_at: "2026-10-17T23:00:00.000Z" },
      }),
    /in the future/,
  );
});

test("incident events require the incident to have been opened first", () => {
  const { timeline } = setup();
  const missed = missedCheckin(timeline);
  const cancel = () =>
    timeline.append({
      type: "escalation.step_cancelled",
      incident_id: "inc_0001",
      actor: { kind: "scheduler", id: null },
      provenance: SYSTEM,
      data: { escalation_id: "esc_0001", step: 1, reason: "acknowledged" },
    });
  assert.throws(cancel, /has not been opened/);

  const open = () =>
    timeline.append({
      type: "incident.opened",
      incident_id: "inc_0001",
      participant_id: "par_0001",
      actor: { kind: "system", id: null },
      provenance: { component: "incident_manager", data_origin: "system_generated", simulated: false },
      caused_by: [missed.event_id],
      data: { trigger: "checkin_missed", trigger_event_id: missed.event_id },
    });
  open();
  assert.deepEqual(timeline.incidentIds, ["inc_0001"]);
  assert.doesNotThrow(cancel);
  assert.throws(open, /already open/);
});

test("restore re-verifies a stored timeline", () => {
  const { timeline } = setup();
  join(timeline, "par_0001");
  missedCheckin(timeline);
  const stored = timeline.events.map((e) => structuredClone(e));
  const opts = { sessionId: "ses_0001", clock: new ManualClock(T0) };

  assert.equal(Timeline.restore(stored, opts).headHash, timeline.headHash);

  const tampered = structuredClone(stored);
  (tampered[0] as { data: { role: string } }).data.role = "host";
  assert.throws(() => Timeline.restore(tampered, opts), TimelineError);

  const reordered = [stored[1], stored[0]];
  assert.throws(() => Timeline.restore(reordered, opts), /seq|prev_hash/);
});
