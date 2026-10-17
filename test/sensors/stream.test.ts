import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionStream, REJECT_REASONS } from "../../src/sensors/stream.js";
import { windowFeatures, DEFAULT_FEATURE_CONFIG } from "../../src/sensors/features.js";
import { ORIENTATION, seeded, synthesize } from "../../src/sensors/synthetic.js";

const T0 = Date.UTC(2026, 9, 17, 20, 0, 0, 0);
const s = (t: number) => ({ t, x: 0, y: 0, z: 9.80665 });

test("windows are epoch-aligned and close once lateness has passed", () => {
  const stream = new MotionStream({ windowMs: 10_000, lateToleranceMs: 1_000 });
  assert.deepEqual(stream.push(s(T0 + 3_000)), []);
  assert.deepEqual(stream.push(s(T0 + 10_500)), [], "still within lateness of the first window");
  const closed = stream.push(s(T0 + 11_000));
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.start, T0);
  assert.equal(closed[0]!.end, T0 + 10_000);
});

test("flush closes windows when the device goes silent", () => {
  const stream = new MotionStream({ windowMs: 10_000, lateToleranceMs: 1_000 });
  stream.push(s(T0 + 1_000));
  assert.deepEqual(stream.flush(T0 + 10_500), []);
  assert.equal(stream.flush(T0 + 11_000).length, 1);
});

test("out-of-order samples within lateness are kept, sorted, and duplicates counted", () => {
  const stream = new MotionStream({ windowMs: 10_000, lateToleranceMs: 2_000 });
  stream.pushMany([s(T0 + 5_000), s(T0 + 1_000), s(T0 + 10_100), s(T0 + 9_000), s(T0 + 1_000)]);
  const [w] = stream.flush(T0 + 12_000);
  assert.deepEqual(w!.samples.map((x) => x.t - T0), [1_000, 5_000, 9_000]);
  assert.equal(w!.rejected.duplicate, 1);
});

test("late samples after a window closed are rejected, not reopened", () => {
  const stream = new MotionStream({ windowMs: 10_000, lateToleranceMs: 0 });
  stream.push(s(T0 + 1_000));
  const [first] = stream.push(s(T0 + 10_000));
  assert.equal(first!.start, T0);
  stream.push(s(T0 + 2_000));
  const [second] = stream.flush(T0 + 20_000);
  assert.equal(second!.start, T0 + 10_000);
  assert.equal(second!.rejected.late, 1, "reported with the next window to close");
});

test("a bogus far-future timestamp cannot fast-forward the stream", () => {
  const stream = new MotionStream({ windowMs: 10_000 });
  const now = T0 + 5_000;
  stream.push(s(T0 + 1_000), now);
  assert.deepEqual(stream.push(s(Date.UTC(2099, 0, 1)), now), []);
  assert.equal(stream.stats.rejected.future, 1);
  assert.deepEqual(stream.push(s(T0 + 2_000), now), [], "earlier window still open");
});

test("garbage input never throws and every rejection is counted", () => {
  const stream = new MotionStream({ windowMs: 10_000, maxSamplesPerWindow: 50 });
  const rand = seeded(7);
  const windows: ReturnType<MotionStream["flush"]> = [];
  const garbage: unknown[] = [
    null, undefined, 42, "x", [], {}, { t: "1", x: 0, y: 0, z: 0 }, { t: T0, x: NaN, y: 0, z: 0 },
    { t: T0, x: Infinity, y: 0, z: 0 }, { t: -5, x: 0, y: 0, z: 0 }, { t: T0, x: 1e9, y: 0, z: 0 },
  ];
  for (let i = 0; i < 20_000; i++) {
    const pick = rand();
    const sample =
      pick < 0.3 ? garbage[Math.floor(rand() * garbage.length)]
      : pick < 0.6 ? { t: T0 + rand() * 100_000, x: (rand() - 0.5) * 50, y: rand() * 20, z: (rand() - 0.5) * 50 }
      : { t: T0 + Math.floor(rand() * 100) * 1000, x: 0, y: 0, z: 9.8 };
    assert.doesNotThrow(() => windows.push(...stream.push(sample, T0 + 200_000)));
  }
  windows.push(...stream.flush(T0 + 1_000_000));
  for (const w of windows) {
    assert.ok(w.samples.length > 0 && w.samples.length <= 50);
    assert.doesNotThrow(() => windowFeatures(w, { ...DEFAULT_FEATURE_CONFIG, windowMs: 10_000 }));
  }
  const { accepted, rejected } = stream.stats;
  const kept = windows.reduce((n, w) => n + w.samples.length, 0);
  assert.equal(kept, accepted, "accepted count matches what windows contain");
  for (const reason of ["malformed", "non_finite", "implausible", "over_capacity"] as const) {
    assert.ok(rejected[reason] > 0, `${reason} should have been seen`);
  }
  assert.equal(
    REJECT_REASONS.reduce((n, r) => n + rejected[r], 0) + accepted,
    20_000,
    "every input is either accepted or counted",
  );
});

test("four hours at 50 Hz stream through with bounded memory", () => {
  const stream = new MotionStream({ windowMs: 60_000 });
  const rand = seeded(11);
  const minutes = 240;
  let windows = 0;
  let peakBuffer = 0;
  const started = performance.now();
  for (let m = 0; m < minutes; m++) {
    const chunk = synthesize({
      // +10 ms keeps ±2 ms timing jitter inside this minute's window.
      start: T0 + m * 60_000 + 10,
      durationMs: 60_000 - 20,
      rateHz: 50,
      gravity: ORIENTATION.inPocket,
      motion: m % 3 === 0 ? { kind: "rhythmic", hz: 1.8, amplitude: 2 } : { kind: "fidget", amplitude: 0.4 },
      rand,
      timingJitterMs: 2,
    });
    for (const w of stream.pushMany(chunk, T0 + (m + 1) * 60_000 + 1_000)) {
      windowFeatures(w, { ...DEFAULT_FEATURE_CONFIG, nominalRateHz: 50 });
      windows += 1;
    }
    peakBuffer = Math.max(peakBuffer, stream.bufferedSamples);
  }
  windows += stream.flush(T0 + minutes * 60_000 + 10_000).length;
  const elapsed = performance.now() - started;
  assert.equal(windows, minutes);
  assert.equal(stream.stats.accepted, minutes * 2999);
  assert.ok(peakBuffer <= 2 * 3000 + 200, `buffer peaked at ${peakBuffer}`);
  assert.ok(elapsed < 20_000, `took ${Math.round(elapsed)} ms`);
});
