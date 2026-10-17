/**
 * Cross-window movement patterns. Each rule looks at a short, bounded
 * history (a few windows plus the current still run), so the detector runs
 * for any session length in constant memory.
 *
 * "Still" below means: activity_level "still" AND coverage >= minCoverage.
 * Windows with poor coverage, or a gap between windows, end a still run:
 * missing data is never counted as stillness.
 *
 * Rules (thresholds are prototype settings, recorded in sensor.stream_started):
 * - impact_then_stillness: an impact, then a still window within impactStillWithinMs.
 * - abrupt_stop: a moderate/vigorous window immediately followed by a still one.
 * - orientation_change_with_stillness: a still window rotated >= tiltChangeDeg from the one before.
 * - prolonged_stillness: a still run reaching prolongedStillMs (once per run).
 */
import type { PayloadOf } from "../timeline/schema/catalog.js";
import type { WindowObservation } from "./baseline.js";

export type PatternData = PayloadOf<"sensor.motion_pattern_observed">;
export interface PatternResult {
  data: PatternData;
  window_event_ids: string[];
}

export interface PatternConfig {
  minCoverage: number;
  impactStillWithinMs: number;
  prolongedStillMs: number;
  tiltChangeDeg: number;
}

export const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  minCoverage: 0.8,
  impactStillWithinMs: 2 * 60_000,
  prolongedStillMs: 20 * 60_000,
  tiltChangeDeg: 60,
};

interface PendingImpact {
  at: string;
  peak: number;
  clipped: boolean;
  event_id: string;
}

export class PatternDetector {
  readonly config: PatternConfig;
  private previous: WindowObservation | null = null;
  private pendingImpacts: PendingImpact[] = [];
  private stillRun: { from: string; event_ids: string[]; reported: boolean } | null = null;

  constructor(config: Partial<PatternConfig> = {}) {
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };
  }

  observe(w: WindowObservation): PatternResult[] {
    const d = w.data;
    const contiguous = this.previous !== null && this.previous.data.window_end === d.window_start;
    const still = d.activity_level === "still" && d.coverage_ratio >= this.config.minCoverage;
    const end = Date.parse(d.window_end);
    const results: PatternResult[] = [];
    const rule = (id: string) => ({ id, threshold_validated: false as const });

    // Keep only impacts recent enough to still matter.
    this.pendingImpacts = this.pendingImpacts.filter((i) => end - Date.parse(i.at) <= this.config.impactStillWithinMs + windowMs(d));

    if (still) {
      if (!contiguous || !this.stillRun) this.stillRun = { from: d.window_start, event_ids: [], reported: false };
      this.stillRun.event_ids.push(w.event_id);
      if (this.stillRun.event_ids.length > 3) this.stillRun.event_ids.splice(1, 1); // first + last two: bounded
      const stillFor = end - Date.parse(this.stillRun.from);

      const impact = this.pendingImpacts.at(-1);
      if (impact) {
        results.push({
          window_event_ids: [impact.event_id, w.event_id],
          data: {
            pattern: "impact_then_stillness",
            observed_from: impact.at,
            observed_to: d.window_end,
            rule: rule("impact-then-stillness"),
            impact_at: impact.at,
            impact_peak_m_s2: impact.peak,
            impact_peak_clipped: impact.clipped,
            still_duration_ms: Math.max(d.longest_still_ms, stillFor),
          },
        });
        this.pendingImpacts = [];
      }

      const prev = this.previous?.data;
      if (contiguous && prev && (prev.activity_level === "moderate" || prev.activity_level === "vigorous")) {
        results.push({
          window_event_ids: [this.previous!.event_id, w.event_id],
          data: {
            pattern: "abrupt_stop",
            observed_from: d.window_start,
            observed_to: d.window_end,
            rule: rule("abrupt-stop"),
            preceding_activity: prev.activity_level,
            preceding_cadence_hz: prev.cadence_hz,
          },
        });
      }

      if (contiguous && d.tilt_change_deg !== null && d.tilt_change_deg >= this.config.tiltChangeDeg) {
        results.push({
          window_event_ids: [this.previous!.event_id, w.event_id],
          data: {
            pattern: "orientation_change_with_stillness",
            observed_from: d.window_start,
            observed_to: d.window_end,
            rule: rule("orientation-change-with-stillness"),
            tilt_change_deg: d.tilt_change_deg,
          },
        });
      }

      if (!this.stillRun.reported && stillFor >= this.config.prolongedStillMs) {
        this.stillRun.reported = true;
        results.push({
          window_event_ids: [...this.stillRun.event_ids],
          data: {
            pattern: "prolonged_stillness",
            observed_from: this.stillRun.from,
            observed_to: d.window_end,
            rule: rule("prolonged-stillness"),
            still_duration_ms: stillFor,
          },
        });
      }
    } else {
      this.stillRun = null;
    }

    // Impacts are remembered after the stillness check so a window's own impact needs a later still window.
    for (const i of d.impacts) this.pendingImpacts.push({ at: i.at, peak: i.peak_m_s2, clipped: i.clipped, event_id: w.event_id });
    if (this.pendingImpacts.length > 5) this.pendingImpacts.splice(0, this.pendingImpacts.length - 5);
    this.previous = w;
    return results;
  }
}

function windowMs(d: PayloadOf<"sensor.motion_window">): number {
  return Date.parse(d.window_end) - Date.parse(d.window_start);
}
