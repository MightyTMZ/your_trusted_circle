/**
 * The single injectable clock for every component (timeline, scheduler,
 * detector, transport). Nothing in the codebase should call Date.now()
 * directly; take a Clock instead so tests and scenarios control time.
 */
export interface Clock {
  /** Current time as epoch milliseconds (UTC). */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests and scripted simulations. */
export class ManualClock implements Clock {
  private current: number;

  constructor(startMs: number) {
    assertEpochMs(startMs);
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ManualClock.advance expects a non-negative duration, got ${ms}`);
    }
    this.current += ms;
    return this.current;
  }

  /** Jump to an absolute time. Time never moves backwards. */
  set(ms: number): void {
    assertEpochMs(ms);
    if (ms < this.current) {
      throw new RangeError(`ManualClock cannot move backwards (${ms} < ${this.current})`);
    }
    this.current = ms;
  }
}

/** ISO 8601 UTC with millisecond precision, e.g. 2026-10-17T23:41:05.120Z. */
export function toIso(ms: number): string {
  assertEpochMs(ms);
  return new Date(ms).toISOString();
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Parses the exact format produced by toIso; returns null for anything else. */
export function parseIso(value: string): number | null {
  if (!ISO_UTC_MS.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function assertEpochMs(ms: number): void {
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`Expected integer epoch milliseconds, got ${ms}`);
  }
}
