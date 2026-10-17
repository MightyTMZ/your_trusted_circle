import type { DetectorConfig, MotionBaseline, MotionSample, MotionState } from './types';

/**
 * Personal statistical baseline + explicit rule. Produces observations
 * ("movement changed"), never conclusions about the person's condition.
 */

export function emptyBaseline(): MotionBaseline {
  return { status: 'uncalibrated', calibrationSamples: [], n: 0 };
}

export function startCalibration(): MotionBaseline {
  return { status: 'calibrating', calibrationSamples: [], n: 0 };
}

export interface DetectorResult {
  baseline: MotionBaseline;
  motion: MotionState;
  /** Set when the rule fires on this sample. */
  movementChanged?: { zScore: number; consecutive: number; mean: number; std: number };
}

function stats(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export function ingestSample(
  baseline: MotionBaseline,
  motion: MotionState,
  sample: MotionSample,
  cfg: DetectorConfig,
): DetectorResult {
  if (baseline.status === 'uncalibrated') return { baseline, motion };

  if (baseline.status === 'calibrating') {
    const calibrationSamples = [...baseline.calibrationSamples, sample.magnitude];
    if (calibrationSamples.length < cfg.calibrationSamples) {
      return {
        baseline: { ...baseline, calibrationSamples, n: calibrationSamples.length },
        motion: { ...motion, lastSampleAt: sample.at },
      };
    }
    const { mean, std } = stats(calibrationSamples);
    return {
      baseline: {
        status: 'calibrated',
        calibrationSamples: [],
        n: calibrationSamples.length,
        mean,
        std: Math.max(std, cfg.minStd),
        calibratedAt: sample.at,
      },
      motion: { consecutiveOutliers: 0, lastSampleAt: sample.at },
    };
  }

  const mean = baseline.mean!;
  const std = baseline.std!;
  const z = (sample.magnitude - mean) / std;
  const outlier = Math.abs(z) >= cfg.zThreshold;
  const consecutive = outlier ? motion.consecutiveOutliers + 1 : 0;
  const next: MotionState = { consecutiveOutliers: consecutive, lastSampleAt: sample.at, lastZ: z };

  if (consecutive === cfg.consecutiveSamples) {
    return { baseline, motion: next, movementChanged: { zScore: z, consecutive, mean, std } };
  }
  return { baseline, motion: next };
}
