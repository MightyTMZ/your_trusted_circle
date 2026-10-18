/**
 * Compresses hours of motion windows into a short activity history, so the
 * voice agent can say "danced for 78 minutes, walked to the patio, then
 * still since 23:51 after an impact" without reading 240 windows.
 *
 * Rules, each with a reason:
 * - Consecutive windows with the same activity level merge into one segment.
 * - Gaps between windows, and windows with coverage < minCoverage, become
 *   "no_data" segments: missing data is reported, never guessed.
 * - The time after the last window up to `to` is "no_data" too (e.g. the
 *   phone went offline), unless it is no longer than one window plus the
 *   stream's late tolerance: that is the window still being filled.
 * - A single-window blip between two segments of the same level is merged
 *   into them, unless it is still or contains an impact: those are exactly
 *   what responders need to see.
 * - At most maxSegments are listed (the most recent); totals still cover the
 *   whole range and truncated_segments says how many were left out.
 */
import { toIso } from "../shared/clock.js";
import type { TimelineEvent } from "./schema/catalog.js";

type ActivityLevel = TimelineEvent<"sensor.motion_window">["data"]["activity_level"];
export type SegmentLevel = ActivityLevel | "no_data";

export interface ActivitySegment {
  from: string;
  to: string;
  duration_ms: number;
  activity: SegmentLevel;
  window_count: number;
  mean_dynamic_m_s2: number | null;
  median_cadence_hz: number | null;
  impact_count: number;
  max_impact_m_s2: number | null;
  /** Timeline events spanning the segment, for audit (may be outside the evidence lookback). */
  first_event_id: string | null;
  last_event_id: string | null;
}

export interface MotionHistory {
  from: string;
  to: string;
  segments: ActivitySegment[];
  truncated_segments: number;
  totals_ms: Record<SegmentLevel, number>;
  impact_count: number;
  longest_still_ms: number;
  /** End of the most recent moderate or vigorous window. */
  last_active_at: string | null;
}

export interface HistoryOptions {
  from: number;
  to: number;
  maxSegments?: number;
  minCoverage?: number;
}

interface Building {
  from: number;
  to: number;
  activity: SegmentLevel;
  windows: TimelineEvent<"sensor.motion_window">[];
}

const LEVELS: SegmentLevel[] = ["still", "light", "moderate", "vigorous", "no_data"];
const MIN_RHYTHM_REGULARITY = 0.5;
/** Matches the motion stream's default lateToleranceMs (src/sensors/stream.ts). */
const LATE_TOLERANCE_MS = 2_000;

export function summarizeMotionHistory(
  windows: readonly TimelineEvent<"sensor.motion_window">[],
  opts: HistoryOptions,
): MotionHistory {
  const minCoverage = opts.minCoverage ?? 0.5;
  const maxSegments = opts.maxSegments ?? 24;
  const sorted = windows
    .filter((w) => Date.parse(w.data.window_end) > opts.from && Date.parse(w.data.window_start) < opts.to)
    .sort((a, b) => Date.parse(a.data.window_start) - Date.parse(b.data.window_start));

  const built: Building[] = [];
  const push = (from: number, to: number, activity: SegmentLevel, w?: TimelineEvent<"sensor.motion_window">) => {
    if (to <= from) return;
    const last = built.at(-1);
    if (last && last.activity === activity && last.to === from) {
      last.to = to;
      if (w) last.windows.push(w);
    } else {
      built.push({ from, to, activity, windows: w ? [w] : [] });
    }
  };

  let cursor = opts.from;
  for (const w of sorted) {
    const start = Math.max(opts.from, Date.parse(w.data.window_start));
    const end = Math.min(opts.to, Date.parse(w.data.window_end));
    if (start > cursor) push(cursor, start, "no_data");
    push(Math.max(start, cursor), end, w.data.coverage_ratio < minCoverage ? "no_data" : w.data.activity_level, w);
    cursor = Math.max(cursor, end);
  }
  // A tail no longer than one window (plus late samples) is the window still open, not missing data.
  const last = sorted.at(-1);
  const openWindowMs = last ? Date.parse(last.data.window_end) - Date.parse(last.data.window_start) + LATE_TOLERANCE_MS : 0;
  if (opts.to - cursor > openWindowMs) push(cursor, opts.to, "no_data");

  const merged = mergeBlips(built);
  const segments = merged.map(toSegment);
  const totals = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<SegmentLevel, number>;
  for (const s of segments) totals[s.activity] += s.duration_ms;
  const active = sorted.findLast((w) => w.data.activity_level === "moderate" || w.data.activity_level === "vigorous");

  return {
    from: toIso(opts.from),
    to: toIso(opts.to),
    segments: segments.slice(-maxSegments),
    truncated_segments: Math.max(0, segments.length - maxSegments),
    totals_ms: totals,
    impact_count: sorted.reduce((n, w) => n + w.data.impact_count, 0),
    longest_still_ms: Math.max(0, ...segments.filter((s) => s.activity === "still").map((s) => s.duration_ms)),
    last_active_at: active ? active.data.window_end : null,
  };
}

function mergeBlips(segments: Building[]): Building[] {
  const out: Building[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const prev = out.at(-1);
    const next = segments[i + 1];
    const blip =
      prev &&
      next &&
      s.windows.length === 1 &&
      prev.activity === next.activity &&
      prev.activity !== "no_data" &&
      s.activity !== "still" &&
      s.activity !== "no_data" &&
      s.windows[0]!.data.impact_count === 0;
    if (blip) {
      prev.to = next.to;
      prev.windows.push(...s.windows, ...next.windows);
      i++; // next is absorbed too
      continue;
    }
    out.push({ ...s, windows: [...s.windows] });
  }
  return out;
}

function toSegment(s: Building): ActivitySegment {
  const w = s.windows;
  // Only clear rhythms count: a weak autocorrelation peak in fidgeting is not a step rate.
  const cadences = w
    .filter((x) => x.data.cadence_hz !== null && (x.data.rhythm_regularity ?? 0) >= MIN_RHYTHM_REGULARITY)
    .map((x) => x.data.cadence_hz!)
    .sort((a, b) => a - b);
  const impacts = w.flatMap((x) => x.data.impacts.map((i) => i.peak_m_s2));
  return {
    from: toIso(s.from),
    to: toIso(s.to),
    duration_ms: s.to - s.from,
    activity: s.activity,
    window_count: w.length,
    mean_dynamic_m_s2: w.length ? round(w.reduce((n, x) => n + x.data.dynamic_mean_m_s2, 0) / w.length) : null,
    // A segment has a step rate only if it is rhythmic most of the time.
    median_cadence_hz: cadences.length >= w.length / 2 && cadences.length > 0 ? cadences[Math.floor(cadences.length / 2)]! : null,
    impact_count: w.reduce((n, x) => n + x.data.impact_count, 0),
    max_impact_m_s2: impacts.length ? Math.max(...impacts) : null,
    first_event_id: w[0]?.event_id ?? null,
    last_event_id: w.at(-1)?.event_id ?? null,
  };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
