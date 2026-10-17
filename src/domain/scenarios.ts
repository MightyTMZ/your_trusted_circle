import type { Millis, MotionSample } from './types';

/**
 * Scenario scripts generate synthetic sensor INPUT only. They never set
 * detector outputs; whether movement "changed" is decided by the detector.
 * Synthetic, not recorded data.
 */

function gaussian(mean: number, sd: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function series(values: number[], endAt: Millis, provenance: string): MotionSample[] {
  return values.map((m, i) => ({
    at: endAt - (values.length - 1 - i) * 1000,
    magnitude: Math.max(0, Number(m.toFixed(3))),
    unit: 'm/s²',
    provenance,
  }));
}

/** Typical movement for this synthetic person: walking, dancing, standing around. */
export function typicalMovement(count: number, endAt: Millis): MotionSample[] {
  return series(Array.from({ length: count }, () => gaussian(1.2, 0.25)), endAt, 'synthetic:typical');
}

/** A brief burst followed by prolonged stillness. Synthetic; no human was involved. */
export function suddenChange(endAt: Millis): MotionSample[] {
  const burst = Array.from({ length: 3 }, () => gaussian(5, 0.5));
  const still = Array.from({ length: 12 }, () => Math.abs(gaussian(0.05, 0.02)));
  return series([...burst, ...still], endAt, 'synthetic:sudden_change');
}
