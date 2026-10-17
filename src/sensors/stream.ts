/**
 * Turns an unbounded, untrusted stream of accelerometer samples into
 * fixed, epoch-aligned windows.
 *
 * Designed for long sessions and bad input:
 * - Memory is bounded: at most two windows are open, each capped.
 * - It never throws on sensor input. Every rejected sample is counted by
 *   reason and reported with the next window, so data loss is visible.
 * - Windows are aligned to multiples of windowMs since the epoch, so a
 *   restart or reconnect lands on the same boundaries.
 * - A sample may arrive up to lateToleranceMs after its window ends.
 * - A single bogus far-future timestamp cannot fast-forward the stream:
 *   samples ahead of the caller's clock are rejected.
 */

/** One accelerometer reading in m/s^2, device frame, gravity included; t in epoch ms. */
export interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
}

export const REJECT_REASONS = [
  "malformed",
  "non_finite",
  "implausible",
  "future",
  "late",
  "duplicate",
  "over_capacity",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type RejectCounts = Record<RejectReason, number>;

export interface ClosedWindow {
  start: number;
  end: number;
  /** Sorted by t, duplicates removed. Never empty. */
  samples: Sample[];
  rejected: RejectCounts;
}

export interface StreamOptions {
  windowMs: number;
  /** How long after a window ends samples for it are still accepted. */
  lateToleranceMs: number;
  /** Samples further ahead of `now` than this are rejected as clock errors. */
  maxFutureMs: number;
  /** Any axis beyond this is physically implausible for a phone (default ~40 g). */
  implausibleM_s2: number;
  /** Per-window cap; protects memory if a device floods samples. */
  maxSamplesPerWindow: number;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  windowMs: 60_000,
  lateToleranceMs: 2_000,
  maxFutureMs: 2_000,
  implausibleM_s2: 400,
  maxSamplesPerWindow: 60 * 500,
};

const zeroCounts = (): RejectCounts =>
  Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as RejectCounts;

interface OpenWindow {
  start: number;
  samples: Sample[];
  rejected: RejectCounts;
}

export class MotionStream {
  readonly options: StreamOptions;
  /** Open windows by start time; at most two (current and the one still within lateness). */
  private readonly open = new Map<number, OpenWindow>();
  /** Everything before this has been closed; samples for it are late. */
  private closedUntil = -Infinity;
  /** Rejections that cannot be attributed to a window yet. */
  private pending = zeroCounts();
  private latestT = -Infinity;
  private readonly totals = zeroCounts();
  private accepted = 0;

  constructor(options: Partial<StreamOptions> = {}) {
    this.options = { ...DEFAULT_STREAM_OPTIONS, ...options };
    if (!(this.options.windowMs > 0)) throw new RangeError("windowMs must be positive");
  }

  /**
   * Adds one untrusted sample. `now` is the caller's clock; omit it only
   * in offline replays. Returns any windows this sample's arrival closed.
   */
  push(raw: unknown, now?: number): ClosedWindow[] {
    const sample = this.sanitize(raw, now);
    if (!sample) return [];
    const start = this.windowStart(sample.t);
    let window = this.open.get(start);
    if (!window) {
      window = { start, samples: [], rejected: zeroCounts() };
      this.open.set(start, window);
    }
    if (window.samples.length >= this.options.maxSamplesPerWindow) {
      this.reject("over_capacity", window);
      return [];
    }
    window.samples.push(sample);
    this.accepted += 1;
    if (sample.t > this.latestT) this.latestT = sample.t;
    return this.closeBefore(this.latestT - this.options.lateToleranceMs);
  }

  pushMany(samples: Iterable<unknown>, now?: number): ClosedWindow[] {
    const closed: ClosedWindow[] = [];
    for (const s of samples) closed.push(...this.push(s, now));
    return closed;
  }

  /** Time-driven close, so windows finish even if the device goes silent. */
  flush(now: number): ClosedWindow[] {
    return this.closeBefore(now - this.options.lateToleranceMs);
  }

  /** Newest accepted sample time, or null before any data. */
  get lastSampleAt(): number | null {
    return Number.isFinite(this.latestT) ? this.latestT : null;
  }

  get stats() {
    return { accepted: this.accepted, rejected: { ...this.totals }, openWindows: this.open.size };
  }

  /** Samples currently held in memory; bounded by 2 x maxSamplesPerWindow plus lateness. */
  get bufferedSamples(): number {
    let n = 0;
    for (const w of this.open.values()) n += w.samples.length;
    return n;
  }

  private windowStart(t: number): number {
    return Math.floor(t / this.options.windowMs) * this.options.windowMs;
  }

  private sanitize(raw: unknown, now: number | undefined): Sample | null {
    if (typeof raw !== "object" || raw === null) return this.reject("malformed");
    const { t, x, y, z } = raw as Record<string, unknown>;
    if (typeof t !== "number" || typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
      return this.reject("malformed");
    }
    if (![t, x, y, z].every(Number.isFinite) || t < 0) return this.reject("non_finite");
    const limit = this.options.implausibleM_s2;
    if (Math.abs(x) > limit || Math.abs(y) > limit || Math.abs(z) > limit) return this.reject("implausible");
    if (now !== undefined && t > now + this.options.maxFutureMs) return this.reject("future");
    const ms = Math.round(t);
    if (ms < this.closedUntil) return this.reject("late");
    return { t: ms, x, y, z };
  }

  private reject(reason: RejectReason, window?: OpenWindow): null {
    this.totals[reason] += 1;
    (window?.rejected ?? this.pending)[reason] += 1;
    return null;
  }

  private closeBefore(cutoff: number): ClosedWindow[] {
    const closed: ClosedWindow[] = [];
    const starts = [...this.open.keys()].sort((a, b) => a - b);
    for (const start of starts) {
      const end = start + this.options.windowMs;
      if (end > cutoff) break;
      const window = this.open.get(start)!;
      this.open.delete(start);
      this.closedUntil = Math.max(this.closedUntil, end);
      const result = this.finish(window, end);
      if (result) closed.push(result);
    }
    return closed;
  }

  private finish(window: OpenWindow, end: number): ClosedWindow | null {
    window.samples.sort((a, b) => a.t - b.t);
    const unique: Sample[] = [];
    for (const s of window.samples) {
      if (unique.length > 0 && unique[unique.length - 1]!.t === s.t) {
        window.rejected.duplicate += 1;
        this.totals.duplicate += 1;
        this.accepted -= 1;
      } else {
        unique.push(s);
      }
    }
    const rejected = zeroCounts();
    for (const r of REJECT_REASONS) rejected[r] = window.rejected[r] + this.pending[r];
    this.pending = zeroCounts();
    return { start: window.start, end, samples: unique, rejected };
  }
}
