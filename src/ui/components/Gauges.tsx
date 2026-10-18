import type { ReactNode } from 'react';

const C = 150;
const R = 120;
const START = 190;
const SPAN = 200;

function pt(deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + R * Math.cos(a), C - R * Math.sin(a)];
}

function arc(from: number, to: number): string {
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(to);
  const large = from - to > 180 ? 1 : 0;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** Words ("All alerted") get a smaller hero than numerals so they stay inside the arc. */
const heroSize = (v: ReactNode) => (typeof v === 'string' && !/\d/.test(v) ? 't-hero-word' : '');

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/**
 * ~200° countdown arc. `progress` is the elapsed share of the window.
 * Stopped: the fill turns grey and the knob disappears.
 */
export function ArcGauge({
  progress,
  label,
  value,
  sub,
  startLabel,
  endLabel,
  stopped = false,
  ariaLabel,
  role = 'img',
}: {
  progress: number;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  startLabel?: string;
  endLabel?: string;
  stopped?: boolean;
  ariaLabel: string;
  role?: 'img' | 'timer';
}) {
  const end = START - SPAN * clamp01(progress);
  const [kx, ky] = pt(end);
  return (
    <div className="gauge" role={role} aria-label={ariaLabel}>
      <svg viewBox="0 0 300 200" aria-hidden="true">
        <path className="gauge-track" d={arc(START, START - SPAN)} />
        {progress > 0 && (
          <path className="gauge-fill" d={arc(START, end)} style={{ stroke: stopped ? 'var(--text-tertiary)' : 'var(--accent)' }} />
        )}
        {!stopped && <circle className="gauge-knob" cx={kx.toFixed(1)} cy={ky.toFixed(1)} r={9} />}
      </svg>
      <div className="gauge-center">
        <span className="t-sub">{label}</span>
        <span className={`t-hero num ${heroSize(value)}`}>{value}</span>
        {sub && <span className="t-sub num">{sub}</span>}
      </div>
      {startLabel && (
        <span className="t-cap num gauge-end" style={{ left: '4%' }}>
          {startLabel}
        </span>
      )}
      {endLabel && (
        <span className="t-cap num gauge-end" style={{ right: '4%' }}>
          {endLabel}
        </span>
      )}
    </div>
  );
}

/**
 * Semicircle of radial ticks for elapsed time across a window. Lit ticks fade
 * in and grow toward the current point; the leading tick is tallest.
 */
export function TickDial({
  progress,
  label,
  value,
  startLabel,
  endLabel,
  stopped = false,
  ariaLabel,
}: {
  progress: number;
  label: string;
  value: ReactNode;
  startLabel?: string;
  endLabel?: string;
  stopped?: boolean;
  ariaLabel: string;
}) {
  const N = 48;
  const lit = Math.max(1, Math.round(N * clamp01(progress)));
  return (
    <div className="dial" role="img" aria-label={ariaLabel}>
      {Array.from({ length: N }, (_, i) => {
        const on = i < lit;
        const lead = i === lit - 1;
        const t = on ? (i + 1) / lit : (i - lit) / Math.max(1, N - lit - 1);
        const w = lead ? 4 : 3;
        const h = on ? (lead ? 34 : Math.round(14 + 14 * t)) : 14;
        return (
          <span
            key={i}
            className="dial-tick"
            style={{
              width: w,
              marginLeft: -w / 2,
              height: h,
              opacity: on ? 0.3 + 0.7 * t : 1 - 0.7 * t,
              background: on ? (stopped ? 'var(--text-secondary)' : 'var(--accent)') : 'var(--tick-inactive)',
              boxShadow: lead && !stopped ? 'var(--accent-glow)' : 'none',
              transform: `rotate(${(-90 + (180 * i) / (N - 1)).toFixed(2)}deg) translateY(-108px)`,
            }}
          />
        );
      })}
      <div className="dial-center">
        <span className="t-sub">{label}</span>
        <span className={`t-hero num ${heroSize(value)}`}>{value}</span>
      </div>
      {startLabel && (
        <span className="t-cap num dial-end" style={{ left: 16 }}>
          {startLabel}
        </span>
      )}
      {endLabel && (
        <span className="t-cap num dial-end" style={{ right: 16 }}>
          {endLabel}
        </span>
      )}
    </div>
  );
}

/** Thin progress line with a knob, elapsed on the left and remaining on the right. */
export function Scrubber({ progress, left, right, ariaLabel }: { progress: number; left: string; right: string; ariaLabel: string }) {
  const pct = `${(clamp01(progress) * 100).toFixed(1)}%`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="scrub" role="img" aria-label={ariaLabel}>
        <div className="scrub-track" />
        <div className="scrub-fill" style={{ width: pct }} />
        <div className="scrub-knob" style={{ left: pct }} />
      </div>
      <div className="spread t-cap num">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

/**
 * Session time as a live stream: the bar is always full up to now and marked
 * Live. Drag the knob (or use the arrow keys) to look back; `onSeek(null)`
 * returns to live. The caller shows what had happened by the chosen moment.
 */
export function LiveScrubber({
  start,
  now,
  at,
  onSeek,
  label,
}: {
  start: number;
  now: number;
  /** The moment being looked at, or null for live. */
  at: number | null;
  onSeek(t: number | null): void;
  label: (t: number) => string;
}) {
  const span = Math.max(1, now - start);
  const t = at === null ? now : Math.min(Math.max(at, start), now);
  const pct = `${(((t - start) / span) * 100).toFixed(2)}%`;
  const seekTo = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const f = clamp01((clientX - r.left) / Math.max(1, r.width));
    // The last moment of the bar is live.
    onSeek(f > 0.985 ? null : start + f * span);
  };
  const step = 60_000;
  return (
    <div
      className="scrub live-scrub"
      role="slider"
      tabIndex={0}
      aria-label="Session time"
      aria-valuemin={0}
      aria-valuemax={Math.round(span / 1000)}
      aria-valuenow={Math.round((t - start) / 1000)}
      aria-valuetext={at === null ? 'Live' : label(t)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e.clientX, e.currentTarget);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekTo(e.clientX, e.currentTarget)}
      onKeyDown={(e) => {
        const next =
          e.key === 'ArrowLeft' ? t - step : e.key === 'ArrowRight' ? t + step : e.key === 'Home' ? start : e.key === 'End' ? now : undefined;
        if (next === undefined) return;
        e.preventDefault();
        onSeek(next >= now ? null : Math.max(start, next));
      }}
    >
      <div className="scrub-track" />
      <div className="scrub-fill" style={{ width: pct }} />
      <div className="scrub-knob" style={{ left: pct }} />
    </div>
  );
}
