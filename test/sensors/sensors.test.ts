import { test } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import { RawRecorder, findBatch, parseRawBatches, rawRef } from "../../src/sensors/raw-recording.js";
import { STANDARD_GRAVITY_M_S2, windowFeatures } from "../../src/sensors/features.js";
import { SensorPipeline } from "../../src/sensors/pipeline.js";
import { readPhyphoxExport } from "../../src/sensors/phyphox.js";
import { ORIENTATION, seeded, synthesize } from "../../src/sensors/synthetic.js";
import { Timeline, type Provenance, type TimelineEvent } from "../../src/timeline/index.js";

const T0 = Date.UTC(2026, 9, 17, 23, 0, 0, 0);
const P = "par_0002";

function recorder(lines: string[] = []) {
  return new RawRecorder({
    recordingId: "rec_0001",
    sessionId: "ses_0001",
    participantId: P,
    stream: "accelerometer",
    sampleRateHz: 10,
    deviceKind: "synthetic",
    dataOrigin: "synthetic_scenario",
    write: (l) => lines.push(l),
  });
}

/** n samples at 10 Hz of a device lying still with gravity on +z. */
const still = (n: number) => Array.from({ length: n }, (_, i) => [i * 100, 0, 0, STANDARD_GRAVITY_M_S2]);

test("raw batches are numbered, serialized one per line and addressable by raw_ref", () => {
  const lines: string[] = [];
  const rec = recorder(lines);
  const first = rec.append(T0, still(3));
  const second = rec.append(T0 + 1000, still(3));
  assert.equal(rawRef(first), "rec_0001#1");
  assert.equal(rawRef(second), "rec_0001#2");
  const parsed = parseRawBatches(lines.join("\n"));
  assert.deepEqual(parsed, [first, second]);
  assert.deepEqual(findBatch(parsed, "rec_0001#2"), second);
  assert.equal(findBatch(parsed, "rec_0001#9"), undefined);
});

test("raw batches reject malformed rows instead of storing them", () => {
  const rec = recorder();
  assert.throws(() => rec.append(T0, [[0, 1, 2]]), /offset_ms, x, y, z/);
  assert.throws(() => rec.append(T0, [[100, 0, 0, 9.8], [50, 0, 0, 9.8]]), /non-decreasing/);
  assert.throws(() => rec.append(T0, [[0, 0, Number.NaN, 9.8]]), /non-finite/);
  assert.throws(() => rec.append(T0, []), /non-empty/);
  assert.equal(rec.append(T0, still(1)).batch_seq, 1, "a rejected batch does not consume a sequence number");
});

// ── Pipeline ───────────────────────────────────────────────────────────────

const UI: Provenance = { component: "ui", data_origin: "synthetic_scenario", simulated: false };

function setup(opts: { consent?: boolean; windowMs?: number } = {}) {
  const clock = new ManualClock(T0);
  const timeline = new Timeline({ sessionId: "ses_0001", clock, ids: new SequentialIds() });
  if (opts.consent !== false) {
    timeline.append({ type: "consent.granted", participant_id: P, actor: { kind: "participant", id: P }, provenance: UI, data: { scopes: ["monitoring"], consent_text_version: "v1" } });
  }
  const raw: string[] = [];
  const pipeline = new SensorPipeline({
    timeline,
    clock,
    participantId: P,
    recordingId: "rec_0001",
    source: { sensor: "accelerometer", deviceKind: "synthetic", dataOrigin: "synthetic_scenario" },
    rawWrite: (l) => raw.push(l),
    features: { nominalRateHz: 25, windowMs: opts.windowMs ?? 60_000 },
    baseline: { calibrationWindows: 3 },
  });
  return { clock, timeline, raw, pipeline };
}

function feedMinutes(s: ReturnType<typeof setup>, from: number, minutes: number, motion: Parameters<typeof synthesize>[0]["motion"], gravity = ORIENTATION.inPocket) {
  const out: TimelineEvent[] = [];
  const rand = seeded(from + 1);
  for (let m = from; m < from + minutes; m++) {
    const samples = synthesize({ start: T0 + m * 60_000 + 5, durationMs: 59_990, rateHz: 25, gravity, motion, rand });
    s.clock.set(T0 + (m + 1) * 60_000 + 2_000);
    out.push(...s.pipeline.ingest(samples), ...s.pipeline.tick());
  }
  return out;
}

test("pipeline: windows, baseline and a stillness anomaly come out of raw samples", () => {
  const s = setup();
  s.pipeline.start();
  const events = [
    ...feedMinutes(s, 0, 3, { kind: "rhythmic", hz: 1.8, amplitude: 2 }),
    ...feedMinutes(s, 3, 2, { kind: "still" }, ORIENTATION.flat),
  ];
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "sensor.motion_window").length, 5);
  assert.equal(types.filter((t) => t === "sensor.baseline_calibrated").length, 1);
  assert.equal(types.filter((t) => t === "sensor.motion_anomaly_observed").length, 1, "onset only, not every still minute");
  const patterns = events.flatMap((e) => (e.type === "sensor.motion_pattern_observed" ? [e.data.pattern] : []));
  assert.deepEqual(patterns.sort(), ["abrupt_stop", "orientation_change_with_stillness"]);
  assert.equal(s.raw.length, 5);
});

test("pipeline: every window recomputes exactly from its raw batch", () => {
  const s = setup();
  feedMinutes(s, 0, 4, { kind: "rhythmic", hz: 2, amplitude: 1.5 });
  const batches = parseRawBatches(s.raw.join("\n"));
  let previous: number[] | null = null;
  for (const w of s.timeline.events) {
    if (w.type !== "sensor.motion_window") continue;
    const batch = findBatch(batches, w.provenance.raw_ref!)!;
    const start = Date.parse(batch.started_at);
    const samples = batch.samples.map(([o, x, y, z]) => ({ t: start + o!, x: x!, y: y!, z: z! }));
    const f = windowFeatures({ start, end: start + 60_000, samples }, s.pipeline.features, previous);
    previous = f.gravity_vector_m_s2;
    const { rejected_sample_count: _r, window_start: _s, window_end: _e, ...logged } = w.data;
    assert.deepEqual(logged, f, w.event_id);
  }
});

test("pipeline: without monitoring consent nothing is recorded, raw or derived", () => {
  const s = setup({ consent: false });
  assert.equal(s.pipeline.start(), null);
  feedMinutes(s, 0, 2, { kind: "fidget", amplitude: 0.5 });
  assert.equal(s.raw.length, 0);
  assert.equal(s.timeline.events.length, 0);
  assert.equal(s.pipeline.stats.discardedWindows, 2);
});

test("pipeline: silence is reported once, and the resume reports the gap", () => {
  const s = setup();
  feedMinutes(s, 0, 1, { kind: "fidget", amplitude: 0.5 });
  const quiet: TimelineEvent[] = [];
  for (let m = 2; m <= 6; m++) {
    s.clock.set(T0 + m * 60_000 + 2_000);
    quiet.push(...s.pipeline.tick());
  }
  assert.deepEqual(quiet.map((e) => e.type), ["sensor.stream_interrupted"]);
  const back = feedMinutes(s, 6, 1, { kind: "fidget", amplitude: 0.5 });
  const resumed = back.find((e) => e.type === "sensor.stream_resumed");
  assert.ok(resumed && resumed.type === "sensor.stream_resumed" && resumed.data.gap_ms > 5 * 60_000);
});

test("pipeline: garbage mixed into real samples is counted on the window, never thrown", () => {
  const s = setup();
  const samples: unknown[] = synthesize({ start: T0 + 5, durationMs: 59_990, rateHz: 25, gravity: ORIENTATION.inPocket, motion: { kind: "fidget", amplitude: 0.5 }, rand: seeded(3) });
  samples.splice(100, 0, null, "junk", { t: T0 + 50, x: NaN, y: 0, z: 0 }, { t: Date.UTC(2099, 0, 1), x: 0, y: 0, z: 9.8 });
  s.clock.set(T0 + 62_000);
  const [window] = [...s.pipeline.ingest(samples), ...s.pipeline.tick()];
  assert.equal(window?.type, "sensor.motion_window");
  assert.equal(window!.type === "sensor.motion_window" && window.data.rejected_sample_count, 4);
});

test("pipeline: the real phyphox recording runs end to end", () => {
  const rec = readPhyphoxExport("examples/accelerometer/With g");
  const clock = new ManualClock(rec.startedAt);
  const timeline = new Timeline({ sessionId: "ses_0001", clock, ids: new SequentialIds() });
  timeline.append({ type: "consent.granted", participant_id: P, actor: { kind: "participant", id: P }, provenance: UI, data: { scopes: ["monitoring"], consent_text_version: "v1" } });
  const pipeline = new SensorPipeline({
    timeline,
    clock,
    participantId: P,
    recordingId: "rec_0001",
    source: { sensor: rec.sensor, deviceKind: "phone", deviceModel: rec.device.model, sensorName: rec.device.sensorName, dataOrigin: "recorded_dataset" },
    rawWrite: () => {},
    features: { windowMs: 10_000, sensorRangeM_s2: rec.device.rangeM_s2! },
  });
  pipeline.start();
  clock.set(Math.ceil(rec.samples.at(-1)!.t) + 60_000); // phyphox times are sub-millisecond
  const events = [...pipeline.ingest(rec.samples), ...pipeline.tick()];
  const windows = events.filter((e) => e.type === "sensor.motion_window");
  assert.equal(windows.length, 6);
  assert.equal(pipeline.stats.refused, 0);
  assert.ok(windows.some((w) => w.summary.includes("sensor saturated")));
  assert.match(timeline.events[1]!.summary, /ICM45631 Accelerometer, Pixel 9/);
});
