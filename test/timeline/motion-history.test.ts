import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeMotionHistory, type TimelineEvent } from "../../src/timeline/index.js";
import { buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";

const T0 = Date.UTC(2026, 9, 17, 20, 0, 0, 0);
type W = TimelineEvent<"sensor.motion_window">;
type Level = W["data"]["activity_level"];

/** Minimal window events: only the fields motion history reads. */
function windows(levels: (Level | null)[], over: (i: number) => Partial<W["data"]> = () => ({})): W[] {
  return levels.flatMap((level, i) =>
    level === null
      ? []
      : [
          {
            event_id: `evt_${i}`,
            data: {
              window_start: new Date(T0 + i * 60_000).toISOString(),
              window_end: new Date(T0 + (i + 1) * 60_000).toISOString(),
              activity_level: level,
              coverage_ratio: 1,
              dynamic_mean_m_s2: level === "still" ? 0 : 1,
              cadence_hz: level === "moderate" ? 1.8 : null,
              rhythm_regularity: level === "moderate" ? 0.8 : null,
              impact_count: 0,
              impacts: [],
              ...over(i),
            },
          } as unknown as W,
        ],
  );
}

const range = (minutes: number) => ({ from: T0, to: T0 + minutes * 60_000 });

test("consecutive windows merge, gaps and the tail become no_data, totals cover the range", () => {
  const h = summarizeMotionHistory(windows(["moderate", "moderate", null, null, "still", "still"]), range(8));
  assert.deepEqual(h.segments.map((s) => [s.activity, s.duration_ms / 60_000]), [["moderate", 2], ["no_data", 2], ["still", 2], ["no_data", 2]]);
  assert.equal(Object.values(h.totals_ms).reduce((a, b) => a + b, 0), 8 * 60_000);
  assert.equal(h.longest_still_ms, 2 * 60_000);
  assert.equal(h.segments[0]!.median_cadence_hz, 1.8);
});

test("low-coverage windows are reported as no_data, never as stillness", () => {
  const h = summarizeMotionHistory(windows(["still", "still"], (i) => ({ coverage_ratio: i === 1 ? 0.2 : 1 })), range(2));
  assert.deepEqual(h.segments.map((s) => s.activity), ["still", "no_data"]);
});

test("one-minute blips merge away, but stillness and impacts never do", () => {
  const blip = summarizeMotionHistory(windows(["vigorous", "vigorous", "moderate", "vigorous"]), range(4));
  assert.deepEqual(blip.segments.map((s) => s.activity), ["vigorous"]);

  const still = summarizeMotionHistory(windows(["vigorous", "still", "vigorous"]), range(3));
  assert.deepEqual(still.segments.map((s) => s.activity), ["vigorous", "still", "vigorous"]);

  const impact = summarizeMotionHistory(
    windows(["vigorous", "moderate", "vigorous"], (i) => (i === 1 ? { impact_count: 1, impacts: [{ at: new Date(T0 + 90_000).toISOString(), peak_m_s2: 60, clipped: false }] } : {})),
    range(3),
  );
  assert.deepEqual(impact.segments.map((s) => s.activity), ["vigorous", "moderate", "vigorous"]);
  assert.equal(impact.segments[1]!.max_impact_m_s2, 60);
});

test("long histories list the most recent segments and say how many were left out", () => {
  const levels = Array.from({ length: 120 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? "light" : "still") as Level);
  const h = summarizeMotionHistory(windows(levels), { ...range(120), maxSegments: 10 });
  assert.equal(h.segments.length, 10);
  assert.equal(h.truncated_segments, 50);
  assert.equal(h.segments.at(-1)!.to, new Date(T0 + 120 * 60_000).toISOString());
});

test("the four-hour scenario compresses into a readable night", () => {
  const { timeline, clock } = buildNoResponseScenario();
  const all = timeline.events.filter((e): e is W => e.type === "sensor.motion_window");
  const h = summarizeMotionHistory(all, { from: T0, to: clock.now() });
  assert.deepEqual(h.segments.map((s) => s.activity), [
    "moderate", // walking in
    "light", // sitting
    "still", // phone on the table
    "no_data", // app backgrounded
    "vigorous", // dancing
    "light", // chatting
    "moderate", // walking to the patio, ending in the impact
    "still", // after the impact
    "no_data", // phone offline
  ]);
  const dancing = h.segments[4]!;
  assert.ok(Math.abs(dancing.median_cadence_hz! - 2.3) < 0.15);
  assert.equal(h.segments[1]!.median_cadence_hz, null, "sitting has no step rate");
  assert.equal(h.segments[6]!.impact_count, 1);
  assert.equal(h.last_active_at, "2026-10-17T23:51:00.000Z");
});
