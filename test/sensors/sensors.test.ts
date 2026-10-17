import { test } from "node:test";
import assert from "node:assert/strict";
import { RawRecorder, findBatch, parseRawBatches, rawRef } from "../../src/sensors/raw-recording.js";
import { STANDARD_GRAVITY_M_S2, accelerometerFeatures, baselineFrom } from "../../src/sensors/features.js";

const T0 = Date.UTC(2026, 9, 17, 23, 0, 0, 0);

function recorder(lines: string[] = []) {
  return new RawRecorder({
    recordingId: "rec_0001",
    sessionId: "ses_0001",
    participantId: "par_0002",
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
  // A rejected batch does not consume a sequence number.
  assert.equal(rec.append(T0, still(1)).batch_seq, 1);
});

test("a motionless device has zero dynamic movement and full stillness", () => {
  const f = accelerometerFeatures(recorder().append(T0, still(600)));
  assert.equal(f.dynamic_mean_m_s2, 0);
  assert.equal(f.dynamic_peak_m_s2, 0);
  assert.equal(f.stillness_ratio, 1);
  assert.equal(f.coverage_ratio, 1);
  assert.deepEqual(f.gravity_vector_m_s2, [0, 0, STANDARD_GRAVITY_M_S2].map((n) => Math.round(n * 1e4) / 1e4));
});

test("coverage exposes missing samples so stillness is not mistaken for data loss", () => {
  const f = accelerometerFeatures(recorder().append(T0, still(300)));
  assert.equal(f.expected_sample_count, 600);
  assert.equal(f.coverage_ratio, 0.5);
});

test("a single jolt shows up as the peak without moving the mean much", () => {
  const rows = still(600);
  rows[300] = [30_000, 0, 0, STANDARD_GRAVITY_M_S2 + 12];
  const f = accelerometerFeatures(recorder().append(T0, rows));
  assert.equal(f.dynamic_peak_m_s2, 12);
  assert.equal(f.dynamic_mean_m_s2, 0.02);
  assert.ok(f.stillness_ratio > 0.99);
});

test("baselineFrom summarizes features across windows", () => {
  const base = { ...accelerometerFeatures(recorder().append(T0, still(600))) };
  const windows = [1, 2, 3].map((m) => ({ ...base, dynamic_mean_m_s2: m }));
  const [mean] = baselineFrom(windows, ["dynamic_mean_m_s2"]);
  assert.deepEqual(mean, { name: "dynamic_mean_m_s2", unit: "m/s^2", mean: 2, std_dev: 1, window_count: 3 });
  assert.throws(() => baselineFrom([base], ["stillness_ratio"]), /at least two/);
});
