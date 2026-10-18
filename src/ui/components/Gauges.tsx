import { useEffect, useRef, useState, type ReactNode } from 'react';

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

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

const FULL_ARC = arc(START, START - SPAN);
const [BASE_X, BASE_Y] = pt(START);

/**
 * The fill and knob of a countdown that sweeps continuously to its deadline.
 *
 * The screen only re-renders every half second, which made the arc step. Here one linear
 * animation per piece runs from where the arc is now to the end, so motion is smooth between
 * renders. The knob rotates about the arc's centre (a transform, so it needs no layout or
 * repaint of the page); the fill reveals the full arc with stroke-dashoffset (cheap, SVG-only).
 * The deadline stays the source of truth: if the app clock jumps (the demo's fast-forward, or a
 * device waking from sleep) or the deadline changes, the animation restarts from the real value.
 * With reduced motion it reverts to the old half-second steps.
 */
function SmoothArc({ progress, dueAt, now, color }: { progress: number; dueAt: number; now: number; color: string }) {
  const fillRef = useRef<SVGPathElement>(null);
  const knobRef = useRef<SVGCircleElement>(null);
  const reduced = useReducedMotion();
  const p = clamp01(progress);
  const latest = useRef({ p, remaining: 0 });
  latest.current = { p, remaining: Math.max(0, dueAt - now) };

  const anchor = useRef({ real: performance.now(), now, dueAt });
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const expected = anchor.current.now + (performance.now() - anchor.current.real);
    if (dueAt !== anchor.current.dueAt || Math.abs(now - expected) > 1200) {
      anchor.current = { real: performance.now(), now, dueAt };
      setEpoch((e) => e + 1);
    }
  }, [now, dueAt]);

  useEffect(() => {
    const fill = fillRef.current;
    const knob = knobRef.current;
    if (reduced || !fill || !knob || typeof fill.animate !== 'function') return;
    const { p: p0, remaining } = latest.current;
    const timing: KeyframeAnimationOptions = { duration: remaining, easing: 'linear', fill: 'forwards' };
    const runs = [
      fill.animate([{ strokeDashoffset: 100 * (1 - p0) }, { strokeDashoffset: 0 }], timing),
      knob.animate([{ transform: `rotate(${SPAN * p0}deg)` }, { transform: `rotate(${SPAN}deg)` }], timing),
    ];
    return () => runs.forEach((r) => r.cancel());
  }, [epoch, dueAt, reduced]);

  return (
    <>
      <path
        ref={fillRef}
        className="gauge-fill"
        d={FULL_ARC}
        pathLength={100}
        style={{ stroke: color, strokeDasharray: 100, strokeDashoffset: 100 * (1 - p) }}
      />
      <circle
        ref={knobRef}
        className="gauge-knob"
        cx={BASE_X.toFixed(1)}
        cy={BASE_Y.toFixed(1)}
        r={9}
        style={{ transformBox: 'view-box', transformOrigin: `${C}px ${C}px`, transform: `rotate(${SPAN * p}deg)` }}
      />
    </>
  );
}

/**
 * ~200° countdown arc. `progress` is the elapsed share of the window.
 * Stopped: the fill turns grey and the knob disappears.
 * `sweep` (optional): animate continuously towards `dueAt` between renders, given the current
 * app-clock `now`. Without it the arc redraws only when `progress` changes.
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
  sweep,
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
  sweep?: { dueAt: number; now: number };
}) {
  const end = START - SPAN * clamp01(progress);
  const [kx, ky] = pt(end);
  const smooth = sweep !== undefined && !stopped && sweep.dueAt > sweep.now;
  return (
    <div className="gauge" role={role} aria-label={ariaLabel}>
      <svg viewBox="0 0 300 200" aria-hidden="true">
        <path className="gauge-track" d={arc(START, START - SPAN)} />
        {smooth ? (
          <SmoothArc progress={progress} dueAt={sweep.dueAt} now={sweep.now} color="var(--danger)" />
        ) : (
          <>
            {progress > 0 && (
              <path className="gauge-fill" d={arc(START, end)} style={{ stroke: stopped ? 'var(--text-tertiary)' : 'var(--danger)' }} />
            )}
            {!stopped && <circle className="gauge-knob" cx={kx.toFixed(1)} cy={ky.toFixed(1)} r={9} />}
          </>
        )}
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
