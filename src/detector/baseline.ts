/**
 * Personal baseline and stillness-onset anomaly detector.
 *
 * Calibration: the first N windows with good coverage define what normal
 * movement looks like for this person (mean and spread per feature).
 *
 * Anomaly rule "stillness-onset-z": a window is flagged when
 *   - its data coverage is good (missing data never reads as stillness),
 *   - it is still (stillness_ratio >= minStillnessRatio),
 *   - its movement is far below the personal baseline (z <= anomalyZ),
 *   - the previous window was not still (onset, not every still minute),
 *   - and no anomaly was raised within refractoryMs.
 * A phone left on a table will trip this; the check-in is private, so
 * that false alarm costs the participant one tap.
 *
 * All thresholds are prototype settings, recorded in sensor.stream_started.
 */
import type { PayloadOf } from "../timeline/schema/catalog.js";

type Window = PayloadOf<"sensor.motion_window">;
export interface WindowObservation {
  event_id: string;
  data: Window;
}

export interface BaselineConfig {
  calibrationWindows: number;
  minCoverage: number;
  anomalyZ: number;
  minStillnessRatio: number;
  refractoryMs: number;
  /** Lower bound on each feature's spread, so a very steady calibration cannot make z explode. */
  stdFloor: Record<BaselineFeatureName, number>;
}

export const BASELINE_FEATURES = ["dynamic_mean_m_s2", "dynamic_peak_m_s2", "stillness_ratio", "cadence_hz"] as const;
export type BaselineFeatureName = (typeof BASELINE_FEATURES)[number];
const UNITS: Record<BaselineFeatureName, string> = {
  dynamic_mean_m_s2: "m/s^2",
  dynamic_peak_m_s2: "m/s^2",
  stillness_ratio: "ratio",
  cadence_hz: "Hz",
};

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  calibrationWindows: 10,
  minCoverage: 0.8,
  anomalyZ: -3,
  minStillnessRatio: 0.95,
  refractoryMs: 15 * 60_000,
  stdFloor: { dynamic_mean_m_s2: 0.05, dynamic_peak_m_s2: 0.2, stillness_ratio: 0.02, cadence_hz: 0.05 },
};

export type BaselineFeature = PayloadOf<"sensor.baseline_calibrated">["features"][number];

export interface BaselineResult {
  features: BaselineFeature[];
  window_start: string;
  window_end: string;
  window_event_ids: string[];
}

export interface AnomalyResult {
  data: Omit<PayloadOf<"sensor.motion_anomaly_observed">, never>;
  window_event_id: string;
}

export class BaselineDetector {
  readonly config: BaselineConfig;
  private readonly calibration: WindowObservation[] = [];
  private baseline: BaselineResult | null = null;
  private previousStill = false;
  private lastAnomalyAt = -Infinity;

  constructor(config: Partial<BaselineConfig> = {}) {
    this.config = { ...DEFAULT_BASELINE_CONFIG, ...config };
  }

  get calibrated(): BaselineResult | null {
    return this.baseline;
  }

  observe(w: WindowObservation): { baseline?: BaselineResult; anomaly?: AnomalyResult } {
    const usable = w.data.coverage_ratio >= this.config.minCoverage;
    if (!this.baseline) {
      if (usable) this.calibration.push(w);
      if (this.calibration.length < this.config.calibrationWindows) return {};
      this.baseline = this.calibrate();
      this.calibration.length = 0;
      return { baseline: this.baseline };
    }

    const still = usable && w.data.stillness_ratio >= this.config.minStillnessRatio;
    const onset = still && !this.previousStill;
    this.previousStill = still;
    if (!onset) return {};

    const ref = this.baseline.features.find((f) => f.name === "dynamic_mean_m_s2");
    if (!ref) return {};
    const z = round((w.data.dynamic_mean_m_s2 - ref.mean) / ref.std_dev);
    const at = Date.parse(w.data.window_end);
    if (z > this.config.anomalyZ || at - this.lastAnomalyAt < this.config.refractoryMs) return {};
    this.lastAnomalyAt = at;
    return {
      anomaly: {
        window_event_id: w.event_id,
        data: {
          feature: "dynamic_mean_m_s2",
          unit: "m/s^2",
          observed_value: w.data.dynamic_mean_m_s2,
          baseline_mean: ref.mean,
          baseline_std_dev: ref.std_dev,
          z_score: z,
          window_start: w.data.window_start,
          window_end: w.data.window_end,
          rule: { id: "stillness-onset-z", comparator: "<=", threshold: this.config.anomalyZ, threshold_validated: false },
        },
      },
    };
  }

  private calibrate(): BaselineResult {
    const windows = this.calibration;
    const features: BaselineFeature[] = [];
    for (const name of BASELINE_FEATURES) {
      const values = windows.map((w) => w.data[name]).filter((v): v is number => typeof v === "number");
      if (values.length < 2) continue; // e.g. no rhythmic windows: cadence has no baseline
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
      features.push({
        name,
        unit: UNITS[name],
        mean: round(mean),
        std_dev: round(Math.max(Math.sqrt(variance), this.config.stdFloor[name])),
        window_count: values.length,
      });
    }
    return {
      features,
      window_start: windows[0]!.data.window_start,
      window_end: windows[windows.length - 1]!.data.window_end,
      window_event_ids: windows.map((w) => w.event_id),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
