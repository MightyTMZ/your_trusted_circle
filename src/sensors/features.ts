/**
 * Derived accelerometer features for one window. Each feature exists to
 * answer a question responders or later analysis will ask:
 *
 * - dynamic_mean / dynamic_std: how much, and how variably, was the person moving?
 * - dynamic_peak: was there a sharp jolt (phone dropped, sudden impact)?
 * - stillness_ratio: how much of the window was essentially motionless?
 * - gravity_vector: which way was the device facing (pocket, flat on a table)?
 * - coverage_ratio: is "no movement" real, or did samples stop arriving?
 *
 * "Dynamic" magnitude is |a| minus standard gravity: a cheap, orientation-
 * independent movement measure. It is a prototype heuristic, not validated.
 */
import type { RawBatch } from "./raw-recording.js";

export const STANDARD_GRAVITY_M_S2 = 9.80665;

export interface AccelWindowFeatures {
  window_ms: number;
  sample_count: number;
  expected_sample_count: number;
  coverage_ratio: number;
  dynamic_mean_m_s2: number;
  dynamic_std_m_s2: number;
  dynamic_peak_m_s2: number;
  stillness_ratio: number;
  still_threshold_m_s2: number;
  gravity_vector_m_s2: [number, number, number];
}

export interface FeatureOptions {
  windowMs: number;
  /** Dynamic magnitude below this counts as still. Configurable and unvalidated. */
  stillThresholdM_s2: number;
}

export const DEFAULT_FEATURE_OPTIONS: FeatureOptions = { windowMs: 60_000, stillThresholdM_s2: 0.15 };

export function accelerometerFeatures(batch: RawBatch, opts: FeatureOptions = DEFAULT_FEATURE_OPTIONS): AccelWindowFeatures {
  if (batch.stream !== "accelerometer") throw new Error(`Expected accelerometer batch, got ${batch.stream}`);
  const n = batch.samples.length;
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  let still = 0;
  const gravity = [0, 0, 0];
  for (const [, x, y, z] of batch.samples as [number, number, number, number][]) {
    const dynamic = Math.abs(Math.hypot(x, y, z) - STANDARD_GRAVITY_M_S2);
    sum += dynamic;
    sumSq += dynamic * dynamic;
    if (dynamic > peak) peak = dynamic;
    if (dynamic < opts.stillThresholdM_s2) still += 1;
    gravity[0]! += x;
    gravity[1]! += y;
    gravity[2]! += z;
  }
  const mean = sum / n;
  const expected = batch.sample_rate_hz ? Math.round((opts.windowMs / 1000) * batch.sample_rate_hz) : n;
  return {
    window_ms: opts.windowMs,
    sample_count: n,
    expected_sample_count: expected,
    coverage_ratio: round(Math.min(1, n / expected)),
    dynamic_mean_m_s2: round(mean),
    dynamic_std_m_s2: round(Math.sqrt(Math.max(0, sumSq / n - mean * mean))),
    dynamic_peak_m_s2: round(peak),
    stillness_ratio: round(still / n),
    still_threshold_m_s2: opts.stillThresholdM_s2,
    gravity_vector_m_s2: [round(gravity[0]! / n), round(gravity[1]! / n), round(gravity[2]! / n)],
  };
}

export type BaselineFeatureName = "dynamic_mean_m_s2" | "dynamic_peak_m_s2" | "stillness_ratio";

const UNITS: Record<BaselineFeatureName, string> = {
  dynamic_mean_m_s2: "m/s^2",
  dynamic_peak_m_s2: "m/s^2",
  stillness_ratio: "ratio",
};

/** Personal baseline: mean and spread of each feature across calibration windows. */
export function baselineFrom(
  windows: readonly Pick<AccelWindowFeatures, BaselineFeatureName>[],
  names: readonly BaselineFeatureName[],
) {
  if (windows.length < 2) throw new Error("A baseline needs at least two windows");
  return names.map((name) => {
    const values = windows.map((w) => w[name]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    return { name, unit: UNITS[name], mean: round(mean), std_dev: round(Math.sqrt(variance)), window_count: values.length };
  });
}

/** 4 decimals: below sensor noise, and keeps summaries and recomputation stable. */
export function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
