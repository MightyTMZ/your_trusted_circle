/**
 * Deterministic synthetic accelerometer signals for tests and demo
 * scenarios. Scenarios supply these as *inputs*; detectors decide what
 * they mean. Nothing here is real data.
 */
import { STANDARD_GRAVITY_M_S2 } from "./features.js";
import type { Sample } from "./stream.js";

export type Vec3 = [number, number, number];

/** Gravity directions in the device frame. */
export const ORIENTATION = {
  inPocket: scaleTo([0, 9.5, 2.43]),
  flat: scaleTo([0.25, 0.3, 9.8]),
} as const;

export type Motion =
  /** Lying motionless: sensor noise only. */
  | { kind: "still"; noise?: number }
  /** Small irregular movement: sitting, talking. */
  | { kind: "fidget"; amplitude: number }
  /** Periodic bounce along gravity: walking (~1.8 Hz), dancing (~2.2 Hz). */
  | { kind: "rhythmic"; hz: number; amplitude: number; jitter?: number };

export interface SynthOptions {
  start: number;
  durationMs: number;
  rateHz: number;
  gravity: Vec3;
  motion: Motion;
  rand: () => number;
  /** Timestamp jitter, ± ms. */
  timingJitterMs?: number;
}

/** Seeded PRNG (mulberry32) so generated data is reproducible byte for byte. */
export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthesize(o: SynthOptions): Sample[] {
  const out: Sample[] = [];
  const period = 1000 / o.rateHz;
  const up = unit(o.gravity);
  const count = Math.floor(o.durationMs / period);
  let phase = o.rand() * Math.PI * 2;
  let wander = 0;
  for (let i = 0; i < count; i++) {
    const tSec = (i * period) / 1000;
    const noise = (scale: number) => (o.rand() - 0.5) * 2 * scale;
    let along = 0;
    let side: Vec3 = [0, 0, 0];
    switch (o.motion.kind) {
      case "still": {
        const n = o.motion.noise ?? 0.01;
        side = [noise(n), noise(n), noise(n)];
        break;
      }
      case "fidget": {
        wander = 0.97 * wander + noise(o.motion.amplitude * 0.3);
        along = wander + noise(o.motion.amplitude * 0.2);
        side = [noise(o.motion.amplitude * 0.3), noise(o.motion.amplitude * 0.3), noise(o.motion.amplitude * 0.3)];
        break;
      }
      case "rhythmic": {
        phase += noise(o.motion.jitter ?? 0.02);
        along = o.motion.amplitude * Math.sin(2 * Math.PI * o.motion.hz * tSec + phase) + noise(o.motion.amplitude * 0.15);
        side = [noise(0.2), noise(0.2), noise(0.2)];
        break;
      }
    }
    out.push({
      t: o.start + i * period + (o.timingJitterMs ? noise(o.timingJitterMs) : 0),
      x: round3(o.gravity[0] + up[0] * along + side[0]),
      y: round3(o.gravity[1] + up[1] * along + side[1]),
      z: round3(o.gravity[2] + up[2] * along + side[2]),
    });
  }
  return out;
}

/** Adds a sharp jolt (~120 ms) of the given dynamic peak at time t. */
export function addImpact(samples: Sample[], t: number, peakM_s2: number, gravity: Vec3): void {
  const up = unit(gravity);
  for (const s of samples) {
    const dt = Math.abs(s.t - t);
    if (dt > 60) continue;
    const k = peakM_s2 * (1 - dt / 60);
    s.x = round3(s.x + up[0] * k);
    s.y = round3(s.y + up[1] * k);
    s.z = round3(s.z + up[2] * k);
  }
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function scaleTo(v: Vec3): Vec3 {
  const u = unit(v);
  return [u[0] * STANDARD_GRAVITY_M_S2, u[1] * STANDARD_GRAVITY_M_S2, u[2] * STANDARD_GRAVITY_M_S2];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
