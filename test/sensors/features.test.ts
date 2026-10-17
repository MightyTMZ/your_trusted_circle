import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEATURE_CONFIG, STANDARD_GRAVITY_M_S2, windowFeatures, type FeatureConfig } from "../../src/sensors/features.js";
import { ORIENTATION, addImpact, seeded, synthesize, type Motion } from "../../src/sensors/synthetic.js";

const T0 = Date.UTC(2026, 9, 17, 20, 0, 0, 0);
const CFG: FeatureConfig = { ...DEFAULT_FEATURE_CONFIG, nominalRateHz: 50 };

function window(motion: Motion, opts: { gravity?: [number, number, number]; seed?: number; rateHz?: number } = {}) {
  const samples = synthesize({
    start: T0,
    durationMs: 60_000,
    rateHz: opts.rateHz ?? 50,
    gravity: opts.gravity ?? ORIENTATION.inPocket,
    motion,
    rand: seeded(opts.seed ?? 1),
    timingJitterMs: 2,
  });
  return { start: T0, end: T0 + 60_000, samples };
}

test("walking: cadence near the true step rate, regular rhythm, moderate activity", () => {
  const f = windowFeatures(window({ kind: "rhythmic", hz: 1.8, amplitude: 2 }), CFG);
  assert.ok(Math.abs(f.cadence_hz! - 1.8) < 0.15, `cadence ${f.cadence_hz}`);
  assert.ok(f.rhythm_regularity! > 0.6, `regularity ${f.rhythm_regularity}`);
  assert.equal(f.activity_level, "moderate");
  assert.equal(f.coverage_ratio, 1);
});

test("dancing is faster and more vigorous than walking", () => {
  const f = windowFeatures(window({ kind: "rhythmic", hz: 2.3, amplitude: 4, jitter: 0.05 }), CFG);
  assert.ok(Math.abs(f.cadence_hz! - 2.3) < 0.2, `cadence ${f.cadence_hz}`);
  assert.equal(f.activity_level, "vigorous");
});

test("fidgeting has movement but little rhythm", () => {
  const f = windowFeatures(window({ kind: "fidget", amplitude: 0.5 }), CFG);
  assert.equal(f.activity_level, "light");
  assert.ok(f.rhythm_regularity === null || f.rhythm_regularity < 0.5, `regularity ${f.rhythm_regularity}`);
});

test("lying still: no rhythm, full stillness, continuous still run", () => {
  const f = windowFeatures(window({ kind: "still" }, { gravity: ORIENTATION.flat }), CFG);
  assert.equal(f.activity_level, "still");
  assert.equal(f.cadence_hz, null);
  assert.equal(f.stillness_ratio, 1);
  assert.ok(f.longest_still_ms >= 59_900, `longest still ${f.longest_still_ms}`);
});

test("an impact is located in time; a saturated one is flagged clipped", () => {
  const w = window({ kind: "still" });
  addImpact(w.samples, T0 + 30_000, 35, ORIENTATION.inPocket);
  const f = windowFeatures(w, CFG);
  assert.equal(f.impact_count, 1);
  assert.ok(Math.abs(Date.parse(f.impacts[0]!.at) - (T0 + 30_000)) <= 60);
  assert.equal(f.impacts[0]!.clipped, false);

  const clipped = windowFeatures(w, { ...CFG, sensorRangeM_s2: 40 });
  assert.equal(clipped.impacts[0]!.clipped, true);
  assert.ok(clipped.clipped_sample_count > 0);
});

test("tilt change measures how far the phone rotated since the previous window", () => {
  const before = windowFeatures(window({ kind: "still" }), CFG);
  const after = windowFeatures(window({ kind: "still" }, { gravity: ORIENTATION.flat }), CFG, before.gravity_vector_m_s2);
  assert.ok(after.tilt_change_deg! > 70 && after.tilt_change_deg! < 90, `tilt ${after.tilt_change_deg}`);
});

test("a 20 s dropout lowers coverage and is reported as the max gap", () => {
  const w = window({ kind: "rhythmic", hz: 1.8, amplitude: 2 });
  w.samples = w.samples.filter((s) => s.t < T0 + 20_000 || s.t >= T0 + 40_000);
  const f = windowFeatures(w, CFG);
  assert.ok(Math.abs(f.coverage_ratio - 2 / 3) < 0.01, `coverage ${f.coverage_ratio}`);
  assert.ok(f.max_gap_ms >= 19_900 && f.max_gap_ms <= 20_100);
  assert.ok(Math.abs(f.cadence_hz! - 1.8) < 0.15, "rhythm survives the gap");
});

test("gravity-removed streams measure |a| directly and report no orientation", () => {
  const w = window({ kind: "rhythmic", hz: 1.8, amplitude: 2 });
  const linear = { ...w, samples: w.samples.map((s) => ({ ...s, x: s.x - ORIENTATION.inPocket[0], y: s.y - ORIENTATION.inPocket[1], z: s.z - ORIENTATION.inPocket[2] })) };
  const f = windowFeatures(linear, { ...CFG, gravityIncluded: false });
  assert.equal(f.gravity_vector_m_s2, null);
  assert.equal(f.tilt_change_deg, null);
  assert.ok(Math.abs(f.cadence_hz! - 1.8) < 0.15, `cadence ${f.cadence_hz}`);
  assert.equal(f.activity_level, "moderate");
});

test("works without a known rate and with a single sample", () => {
  assert.doesNotThrow(() => windowFeatures(window({ kind: "fidget", amplitude: 0.5 }), { ...CFG, nominalRateHz: null }));
  const one = windowFeatures({ start: T0, end: T0 + 60_000, samples: [{ t: T0 + 10, x: 0, y: 0, z: STANDARD_GRAVITY_M_S2 }] }, CFG);
  assert.equal(one.sample_count, 1);
  assert.ok(one.coverage_ratio < 0.01);
  assert.equal(one.effective_rate_hz, null);
});

test("features are deterministic", () => {
  const w = window({ kind: "rhythmic", hz: 2, amplitude: 1.5 }, { seed: 99 });
  assert.deepEqual(windowFeatures(w, CFG), windowFeatures(structuredClone(w), CFG));
});
