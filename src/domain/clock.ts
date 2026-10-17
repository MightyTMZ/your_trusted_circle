import type { Millis } from './types';

/** The one clock every deadline is computed from. */
export interface Clock {
  now(): Millis;
}

/** Wall clock shifted by a demo offset, so "fast-forward" moves every deadline consistently. */
export function offsetClock(getOffsetMs: () => number): Clock {
  return { now: () => Date.now() + getOffsetMs() };
}

/** Deterministic clock for tests. */
export function fakeClock(start: Millis = Date.UTC(2026, 9, 17, 23, 0, 0)): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}
