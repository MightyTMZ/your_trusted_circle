/**
 * Accelerometer features for one window. Each answers a question a
 * responder, or later analysis, will ask:
 *
 * - dynamic_mean/std/peak: how much, how variably, and how sharply was the person moving?
 * - stillness_ratio, longest_still_ms: how much of the window, and how long at a stretch, was motionless?
 * - cadence_hz, rhythm_regularity: walking, dancing, or irregular movement? how steady?
 * - impacts (with clipped flag): was there a jolt, exactly when, and did it saturate the sensor?
 * - gravity_vector, tilt_change_deg: which way was the phone facing, and did it flip?
 * - coverage_ratio, max_gap_ms, clipped_sample_count: can the numbers be trusted?
 * - activity_level: one word for the above.
 *
 * "Dynamic" magnitude is |a| minus standard gravity (or |a| for gravity-
 * removed sensors): cheap and orientation-independent. All thresholds are
 * prototype heuristics, not validated.
 */
import type { ClosedWindow, Sample } from "./stream.js";

export const STANDARD_GRAVITY_M_S2 = 9.80665;

/** 4 decimals: below sensor noise, and keeps summaries and recomputation stable. */
export function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}


export const ACTIVITY_LEVELS = ["still", "light", "moderate", "vigorous"] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/** All thresholds are prototype settings: configurable, recorded once per stream, unvalidated. */
export interface FeatureConfig {
  windowMs: number;
  /**
   * true: raw accelerometer (gravity included, e.g. phyphox "With g").
   * false: linear acceleration (gravity removed by the OS, e.g. "Without g");
   * movement is then |a| itself and orientation is unavailable.
   */
  gravityIncluded: boolean;
  /** Nominal device rate; null if unknown (the observed rate is used instead). */
  nominalRateHz: number | null;
  /** Dynamic magnitude below this counts as still. */
  stillM_s2: number;
  /** Dynamic magnitude above this counts as an impact (~2.5 g). */
  impactM_s2: number;
  /** Sensor full scale; readings within 2% of it are treated as clipped. */
  sensorRangeM_s2: number;
  /** dynamic_mean thresholds between light/moderate and moderate/vigorous. */
  moderateM_s2: number;
  vigorousM_s2: number;
  /** stillness_ratio at or above this makes a window "still". */
  stillWindowRatio: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  windowMs: 60_000,
  gravityIncluded: true,
  nominalRateHz: null,
  stillM_s2: 0.15,
  impactM_s2: 24.5,
  sensorRangeM_s2: 156.9,
  moderateM_s2: 0.5,
  vigorousM_s2: 1.5,
  stillWindowRatio: 0.9,
};

export interface Impact {
  at: string;
  peak_m_s2: number;
  /** The sensor saturated, so the true peak was at least this high. */
  clipped: boolean;
}

export interface WindowFeatures {
  sample_count: number;
  effective_rate_hz: number | null;
  coverage_ratio: number;
  max_gap_ms: number;
  clipped_sample_count: number;
  dynamic_mean_m_s2: number;
  dynamic_std_m_s2: number;
  dynamic_peak_m_s2: number;
  stillness_ratio: number;
  longest_still_ms: number;
  cadence_hz: number | null;
  rhythm_regularity: number | null;
  impact_count: number;
  impacts: Impact[];
  /** Null for gravity-removed streams, where orientation cannot be known. */
  gravity_vector_m_s2: [number, number, number] | null;
  tilt_change_deg: number | null;
  activity_level: ActivityLevel;
}

const MAX_LISTED_IMPACTS = 5;
/** Spikes closer together than this are one impact. */
const IMPACT_MERGE_MS = 250;
/** Rhythm analysis grid: 20 Hz resolves cadence up to the 3.5 Hz band edge. */
const GRID_HZ = 20;
const CADENCE_BAND_HZ: [number, number] = [0.5, 3.5];
/** Grid points further than this from a real sample are treated as missing. */
const MAX_INTERP_GAP_MS = 500;

/**
 * Features for one closed window. Pure and deterministic: the same samples
 * always give the same numbers, so any window can be recomputed from raw.
 * `previousGravity` is the prior window's gravity vector, for tilt change.
 */
export function windowFeatures(
  window: Pick<ClosedWindow, "start" | "end" | "samples">,
  cfg: FeatureConfig = DEFAULT_FEATURE_CONFIG,
  previousGravity: readonly number[] | null = null,
): WindowFeatures {
  const { samples, start, end } = window;
  const n = samples.length;
  if (n === 0) throw new Error("windowFeatures needs at least one sample");
  const span = end - start;

  // Intensity, stillness, impacts, orientation in one pass (Welford for variance).
  let mean = 0;
  let m2 = 0;
  let peak = 0;
  let stillCount = 0;
  let clipped = 0;
  let longestStill = 0;
  let runStart: number | null = null;
  const gravity = [0, 0, 0];
  const impacts: Impact[] = [];
  let impactCount = 0;
  let lastImpactT = -Infinity;
  const clipAt = cfg.sensorRangeM_s2 * 0.98;
  const dynamic = new Float64Array(n);
  const interval = medianInterval(samples) ?? (cfg.nominalRateHz ? 1000 / cfg.nominalRateHz : 0);
  // Gravity removed: |a| is already movement, and rhythm is read along the main axis of motion.
  const axis = cfg.gravityIncluded ? null : principalAxis(samples);

  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    const magnitude = Math.hypot(s.x, s.y, s.z);
    // Signed signal for rhythm (one bounce = one cycle); absolute for intensity.
    const signed = axis ? s.x * axis[0] + s.y * axis[1] + s.z * axis[2] : magnitude - STANDARD_GRAVITY_M_S2;
    const d = axis ? magnitude : Math.abs(signed);
    dynamic[i] = signed;
    const delta = d - mean;
    mean += delta / (i + 1);
    m2 += delta * (d - mean);
    if (d > peak) peak = d;
    gravity[0]! += s.x;
    gravity[1]! += s.y;
    gravity[2]! += s.z;
    const isClipped = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) >= clipAt;
    if (isClipped) clipped += 1;

    if (d < cfg.stillM_s2) {
      stillCount += 1;
      runStart ??= s.t;
      longestStill = Math.max(longestStill, s.t - runStart + interval);
    } else {
      runStart = null;
    }

    if (d > cfg.impactM_s2) {
      if (s.t - lastImpactT > IMPACT_MERGE_MS) {
        impactCount += 1;
        if (impacts.length < MAX_LISTED_IMPACTS) impacts.push({ at: new Date(s.t).toISOString(), peak_m_s2: round(d), clipped: isClipped });
      } else if (impactCount <= MAX_LISTED_IMPACTS) {
        const last = impacts[impacts.length - 1]!;
        last.peak_m_s2 = Math.max(last.peak_m_s2, round(d));
        last.clipped ||= isClipped;
      }
      lastImpactT = s.t;
    }
  }

  // Coverage: share of the window within tolerance of a real sample.
  const tolerance = Math.max(50, 3 * (interval || 0));
  let missing = Math.max(0, samples[0]!.t - start - tolerance) + Math.max(0, end - samples[n - 1]!.t - tolerance);
  let maxGap = Math.max(samples[0]!.t - start, end - samples[n - 1]!.t);
  for (let i = 1; i < n; i++) {
    const gap = samples[i]!.t - samples[i - 1]!.t;
    if (gap > maxGap) maxGap = gap;
    if (gap > tolerance) missing += gap - tolerance;
  }
  const coverage = clamp01(1 - missing / span);

  const g: [number, number, number] | null = cfg.gravityIncluded
    ? [round(gravity[0]! / n), round(gravity[1]! / n), round(gravity[2]! / n)]
    : null;
  const std = Math.sqrt(n > 1 ? m2 / n : 0);
  const stillness = stillCount / n;
  const rhythm = std >= cfg.stillM_s2 ? cadence(samples, dynamic, start, end) : null;

  return {
    sample_count: n,
    effective_rate_hz: n > 1 && samples[n - 1]!.t > samples[0]!.t ? round(((n - 1) * 1000) / (samples[n - 1]!.t - samples[0]!.t)) : null,
    coverage_ratio: round(coverage),
    max_gap_ms: Math.round(maxGap),
    clipped_sample_count: clipped,
    dynamic_mean_m_s2: round(mean),
    dynamic_std_m_s2: round(std),
    dynamic_peak_m_s2: round(peak),
    stillness_ratio: round(stillness),
    longest_still_ms: Math.round(Math.min(longestStill, span)),
    cadence_hz: rhythm ? round(rhythm.hz) : null,
    rhythm_regularity: rhythm ? round(rhythm.regularity) : null,
    impact_count: impactCount,
    impacts,
    gravity_vector_m_s2: g,
    tilt_change_deg: previousGravity && g ? round(angleDeg(previousGravity, g)) : null,
    activity_level: activityLevel(mean, stillness, cfg),
  };
}

export function activityLevel(dynamicMean: number, stillness: number, cfg: FeatureConfig): ActivityLevel {
  if (stillness >= cfg.stillWindowRatio) return "still";
  if (dynamicMean >= cfg.vigorousM_s2) return "vigorous";
  if (dynamicMean >= cfg.moderateM_s2) return "moderate";
  return "light";
}

/**
 * Dominant periodicity of movement via normalized autocorrelation of the
 * signed dynamic magnitude, resampled onto a uniform grid so jitter and gaps do
 * not distort it. Returns cadence in Hz and regularity (0 = no rhythm,
 * 1 = perfectly periodic). Null when there is too little valid signal.
 */
function cadence(samples: readonly Sample[], dynamic: Float64Array, start: number, end: number) {
  const step = 1000 / GRID_HZ;
  const points = Math.floor((end - start) / step);
  const grid = new Float64Array(points);
  let j = 0;
  let valid = 0;
  for (let k = 0; k < points; k++) {
    const t = start + k * step;
    while (j < samples.length - 2 && samples[j + 1]!.t <= t) j++;
    const a = samples[j]!;
    const b = samples[Math.min(j + 1, samples.length - 1)]!;
    if (t < a.t - MAX_INTERP_GAP_MS || t > b.t + MAX_INTERP_GAP_MS || b.t - a.t > MAX_INTERP_GAP_MS) {
      grid[k] = Number.NaN;
      continue;
    }
    const f = b.t === a.t ? 0 : clamp01((t - a.t) / (b.t - a.t));
    grid[k] = dynamic[j]! + f * (dynamic[Math.min(j + 1, samples.length - 1)]! - dynamic[j]!);
    valid += 1;
  }
  if (valid < points * 0.5) return null;

  let mu = 0;
  for (const value of grid) if (!Number.isNaN(value)) mu += value;
  mu /= valid;
  let energy = 0;
  for (let k = 0; k < points; k++) if (!Number.isNaN(grid[k]!)) energy += (grid[k]! - mu) ** 2;
  if (energy === 0) return null;

  const minLag = Math.ceil(GRID_HZ / CADENCE_BAND_HZ[1]);
  const maxLag = Math.floor(GRID_HZ / CADENCE_BAND_HZ[0]);
  // One lag either side of the band so peaks at its edges can be recognised.
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    let pairs = 0;
    for (let k = 0; k + lag < points; k++) {
      const a = grid[k]!;
      const b = grid[k + lag]!;
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      sum += (a - mu) * (b - mu);
      pairs += 1;
    }
    // Scale to the full-length estimate so lags with fewer valid pairs are comparable.
    r[lag] = pairs > 0 ? (sum / pairs) * (valid / energy) : 0;
  }
  // Periodic movement shows as a local peak; smooth random movement only decays. No peak, no rhythm.
  const peaks: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag]! > 0 && r[lag]! > r[lag - 1]! && r[lag]! >= r[lag + 1]!) peaks.push(lag);
  }
  if (peaks.length === 0) return null;
  const strongest = Math.max(...peaks.map((lag) => r[lag]!));
  // Multiples of the true period also peak; the first strong peak is the fundamental.
  const best = peaks.find((lag) => r[lag]! >= 0.85 * strongest)!;
  return { hz: GRID_HZ / best, regularity: clamp01(r[best]!) };
}

/** Unit vector of greatest variance (power iteration on the 3x3 covariance). */
function principalAxis(samples: readonly Sample[]): [number, number, number] {
  const n = samples.length;
  let mx = 0, my = 0, mz = 0;
  for (const s of samples) { mx += s.x; my += s.y; mz += s.z; }
  mx /= n; my /= n; mz /= n;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const s of samples) {
    const dx = s.x - mx, dy = s.y - my, dz = s.z - mz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz; xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  let v: [number, number, number] = [1, 1, 1];
  for (let i = 0; i < 32; i++) {
    const next: [number, number, number] = [
      xx * v[0] + xy * v[1] + xz * v[2],
      xy * v[0] + yy * v[1] + yz * v[2],
      xz * v[0] + yz * v[1] + zz * v[2],
    ];
    const norm = Math.hypot(...next);
    if (norm === 0) return [0, 0, 1];
    v = [next[0] / norm, next[1] / norm, next[2] / norm];
  }
  return v;
}

function medianInterval(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null;
  const gaps: number[] = [];
  const stride = Math.max(1, Math.floor(samples.length / 512));
  for (let i = stride; i < samples.length; i += stride) gaps.push((samples[i]!.t - samples[i - stride]!.t) / stride);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const na = Math.hypot(a[0]!, a[1]!, a[2]!);
  const nb = Math.hypot(b[0]!, b[1]!, b[2]!);
  if (na < 1 || nb < 1) return 0;
  const cos = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (na * nb);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
