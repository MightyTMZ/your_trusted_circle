import { test } from "node:test";
import assert from "node:assert/strict";
import { BaselineDetector, type WindowObservation } from "../../src/detector/baseline.js";
import { PatternDetector } from "../../src/detector/patterns.js";
import type { PayloadOf } from "../../src/timeline/index.js";

const T0 = Date.UTC(2026, 9, 17, 20, 0, 0, 0);
type Window = PayloadOf<"sensor.motion_window">;
let n = 0;

/** A motion window at minute m with sensible defaults; override what the test is about. */
function win(m: number, over: Partial<Window> = {}): WindowObservation {
  n += 1;
  return {
    event_id: `evt_${String(n).padStart(4, "0")}`,
    data: {
      window_start: new Date(T0 + m * 60_000).toISOString(),
      window_end: new Date(T0 + (m + 1) * 60_000).toISOString(),
      sample_count: 1500,
      rejected_sample_count: 0,
      effective_rate_hz: 25,
      coverage_ratio: 1,
      max_gap_ms: 40,
      clipped_sample_count: 0,
      dynamic_mean_m_s2: 1.2,
      dynamic_std_m_s2: 0.8,
      dynamic_peak_m_s2: 2.5,
      stillness_ratio: 0.05,
      longest_still_ms: 200,
      cadence_hz: 1.8,
      rhythm_regularity: 0.8,
      impact_count: 0,
      impacts: [],
      gravity_vector_m_s2: [0, 9.5, 2.4],
      tilt_change_deg: 2,
      activity_level: "moderate",
      ...over,
    },
  };
}
const stillWin = (m: number, over: Partial<Window> = {}) =>
  win(m, { activity_level: "still", dynamic_mean_m_s2: 0.005, dynamic_std_m_s2: 0.003, stillness_ratio: 1, longest_still_ms: 60_000, cadence_hz: null, rhythm_regularity: null, ...over });

test("baseline calibrates from good-coverage windows only, with a spread floor", () => {
  const d = new BaselineDetector({ calibrationWindows: 3 });
  assert.deepEqual(d.observe(win(0, { coverage_ratio: 0.3 })), {}, "poor coverage is not calibration data");
  d.observe(win(1));
  d.observe(win(2));
  const { baseline } = d.observe(win(3));
  assert.ok(baseline);
  const mean = baseline.features.find((f) => f.name === "dynamic_mean_m_s2")!;
  assert.equal(mean.mean, 1.2);
  assert.equal(mean.std_dev, 0.05, "identical windows: spread floored, so z cannot explode");
  assert.equal(baseline.window_event_ids.length, 3);
});

test("anomaly fires on stillness onset, once, and respects the refractory period", () => {
  const d = new BaselineDetector({ calibrationWindows: 2, refractoryMs: 30 * 60_000 });
  d.observe(win(0));
  d.observe(win(1));
  const first = d.observe(stillWin(2)).anomaly;
  assert.ok(first && first.data.z_score <= -3);
  assert.equal(d.observe(stillWin(3)).anomaly, undefined, "still continuing is not a new onset");
  d.observe(win(4));
  assert.equal(d.observe(stillWin(5)).anomaly, undefined, "within refractory period");
  d.observe(win(40));
  assert.ok(d.observe(stillWin(41)).anomaly, "after the refractory period");
});

test("missing data never reads as stillness", () => {
  const d = new BaselineDetector({ calibrationWindows: 2 });
  d.observe(win(0));
  d.observe(win(1));
  assert.equal(d.observe(stillWin(2, { coverage_ratio: 0.4 })).anomaly, undefined);
  const p = new PatternDetector();
  p.observe(win(0, { impact_count: 1, impacts: [{ at: new Date(T0 + 50_000).toISOString(), peak_m_s2: 40, clipped: false }] }));
  assert.deepEqual(p.observe(stillWin(1, { coverage_ratio: 0.4 })), []);
});

test("impact then stillness, abrupt stop and orientation change are recognised together", () => {
  const p = new PatternDetector();
  const impactAt = new Date(T0 + 58_000).toISOString();
  p.observe(win(0, { impact_count: 1, impacts: [{ at: impactAt, peak_m_s2: 150, clipped: true }] }));
  const found = p.observe(stillWin(1, { tilt_change_deg: 72 }));
  const byName = Object.fromEntries(found.map((r) => [r.data.pattern, r.data]));
  assert.deepEqual(Object.keys(byName).sort(), ["abrupt_stop", "impact_then_stillness", "orientation_change_with_stillness"]);
  assert.equal(byName.impact_then_stillness!.impact_at, impactAt);
  assert.equal(byName.impact_then_stillness!.impact_peak_clipped, true);
  assert.equal(byName.abrupt_stop!.preceding_activity, "moderate");
});

test("an old impact does not pair with much later stillness", () => {
  const p = new PatternDetector({ impactStillWithinMs: 2 * 60_000 });
  p.observe(win(0, { impact_count: 1, impacts: [{ at: new Date(T0 + 30_000).toISOString(), peak_m_s2: 40, clipped: false }] }));
  for (let m = 1; m < 10; m++) p.observe(win(m, { activity_level: "light" }));
  const found = p.observe(stillWin(10));
  assert.ok(!found.some((r) => r.data.pattern === "impact_then_stillness"));
});

test("prolonged stillness is reported once per run, and a gap ends the run", () => {
  const p = new PatternDetector({ prolongedStillMs: 5 * 60_000 });
  p.observe(win(0, { activity_level: "light" }));
  const reports: number[] = [];
  for (let m = 1; m <= 12; m++) if (p.observe(stillWin(m)).some((r) => r.data.pattern === "prolonged_stillness")) reports.push(m);
  assert.deepEqual(reports, [5]);
  // Gap (minute 13 missing): the run restarts, so it needs another 5 minutes.
  const after: number[] = [];
  for (let m = 14; m <= 20; m++) if (p.observe(stillWin(m)).some((r) => r.data.pattern === "prolonged_stillness")) after.push(m);
  assert.deepEqual(after, [18]);
});

test("four hours of windows run in bounded state", () => {
  const p = new PatternDetector();
  const d = new BaselineDetector();
  for (let m = 0; m < 240; m++) {
    const w = m % 7 === 0 ? stillWin(m) : win(m, { impact_count: m % 11 === 0 ? 1 : 0, impacts: m % 11 === 0 ? [{ at: new Date(T0 + m * 60_000 + 1000).toISOString(), peak_m_s2: 30, clipped: false }] : [] });
    assert.doesNotThrow(() => {
      d.observe(w);
      p.observe(w);
    });
  }
});
