import { useRef, useState, useCallback, useEffect, useId } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent } from 'react';

/* ── Public types ─────────────────────────────────────────────── */

export interface BoardItem {
  id: string;
  label: string;
  src: string;
  x: number;          // initial px from board left
  y: number;          // initial px from board top
  width: number;      // display width in px
  rotation?: number;  // degrees
}

interface ItemBoardProps {
  items?: BoardItem[];
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

/* ── Grid constants ───────────────────────────────────────────── */

const COLS = 9;       // 0 → 8
const ROWS = 8;       // 0 → 7  (bottom = 0)
const SUBS = 5;       // subdivisions per unit
const RULER = 28;     // ruler margin in px

/* ── Component ────────────────────────────────────────────────── */

export function ItemBoard({ items = [], height = 500, className = '', style }: ItemBoardProps) {
  const uid = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<{ id: string; ox: number; oy: number } | null>(null);
  const [hover, setHover] = useState<{ label: string; gx: number; gy: number } | null>(null);

  /* observe container size */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const { width, height: h } = e.contentRect;
      setSize({ w: width, h });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  /* seed item positions */
  useEffect(() => {
    const next: Record<string, { x: number; y: number }> = {};
    let changed = false;
    for (const it of items) {
      if (!(it.id in pos)) { next[it.id] = { x: it.x, y: it.y }; changed = true; }
    }
    if (changed) setPos(p => ({ ...p, ...next }));
  }, [items]);

  /* px → grid coords */
  const toGrid = useCallback((px: number, py: number) => {
    const iw = size.w - RULER * 2;
    const ih = size.h - RULER * 2;
    if (iw <= 0 || ih <= 0) return { gx: 0, gy: 0 };
    return {
      gx: Math.round(((px - RULER) / iw) * COLS * 100) / 100,
      gy: Math.round((ROWS - ((py - RULER) / ih) * ROWS) * 100) / 100,
    };
  }, [size]);

  /* ── drag handlers ──────────────────────────────────────────── */

  const onDown = useCallback((e: RPointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    setDrag({ id, ox: e.clientX - r.left, oy: e.clientY - r.top });
  }, []);

  const onMove = useCallback((e: RPointerEvent) => {
    if (!drag || !ref.current) return;
    const br = ref.current.getBoundingClientRect();
    const x = e.clientX - br.left - drag.ox;
    const y = e.clientY - br.top - drag.oy;
    setPos(p => ({ ...p, [drag.id]: { x, y } }));
    const it = items.find(i => i.id === drag.id);
    if (it) {
      const g = toGrid(x + it.width / 2, y + it.width / 2);
      setHover({ label: it.label, gx: g.gx, gy: g.gy });
    }
  }, [drag, items, toGrid]);

  const onUp = useCallback(() => { setDrag(null); }, []);

  const reset = useCallback(() => {
    const init: Record<string, { x: number; y: number }> = {};
    for (const it of items) init[it.id] = { x: it.x, y: it.y };
    setPos(init);
    setHover(null);
  }, [items]);

  /* ── derived metrics ────────────────────────────────────────── */

  const { w, h } = size;
  const iw = w - RULER * 2;
  const ih = h - RULER * 2;
  const clipId = `board-clip-${uid}`;

  /* ── helpers to build grid elements ─────────────────────────── */

  function vLines() {
    const out: JSX.Element[] = [];
    for (let i = 0; i <= COLS * SUBS; i++) {
      const x = RULER + (i / (COLS * SUBS)) * iw;
      const major = i % SUBS === 0;
      out.push(
        <line key={`v${i}`} x1={x} y1={RULER} x2={x} y2={RULER + ih}
          stroke={major ? 'var(--board-line-major)' : 'var(--board-line)'}
          strokeWidth={major ? 0.8 : 0.4} />,
      );
    }
    return out;
  }

  function hLines() {
    const out: JSX.Element[] = [];
    for (let i = 0; i <= ROWS * SUBS; i++) {
      const y = RULER + (i / (ROWS * SUBS)) * ih;
      const major = i % SUBS === 0;
      out.push(
        <line key={`h${i}`} x1={RULER} y1={y} x2={RULER + iw} y2={y}
          stroke={major ? 'var(--board-line-major)' : 'var(--board-line)'}
          strokeWidth={major ? 0.8 : 0.4} />,
      );
    }
    return out;
  }

  function rulerNumbers() {
    const out: JSX.Element[] = [];
    const font = { fontSize: 10, fontFamily: 'system-ui, sans-serif', fill: 'var(--board-text)' };
    // bottom
    for (let i = 0; i <= COLS; i++) {
      const x = RULER + (i / COLS) * iw;
      out.push(<text key={`bn${i}`} x={x} y={h - 8} textAnchor="middle" {...font}>{i}</text>);
    }
    // top
    for (let i = 0; i <= COLS; i++) {
      const x = RULER + (i / COLS) * iw;
      out.push(<text key={`tn${i}`} x={x} y={16} textAnchor="middle" {...font}>{i}</text>);
    }
    // left
    for (let i = 0; i <= ROWS; i++) {
      const y = RULER + ih - (i / ROWS) * ih;
      out.push(<text key={`ln${i}`} x={10} y={y + 3.5} textAnchor="middle" {...font}>{i}</text>);
    }
    // right
    for (let i = 0; i <= ROWS; i++) {
      const y = RULER + ih - (i / ROWS) * ih;
      out.push(<text key={`rn${i}`} x={w - 10} y={y + 3.5} textAnchor="middle" {...font}>{i}</text>);
    }
    return out;
  }

  function ticks(edge: 'top' | 'bottom' | 'left' | 'right') {
    const out: JSX.Element[] = [];
    const horiz = edge === 'top' || edge === 'bottom';
    const count = horiz ? COLS * SUBS : ROWS * SUBS;
    for (let i = 0; i <= count; i++) {
      const major = i % SUBS === 0;
      const len = major ? 6 : 3;
      if (horiz) {
        const x = RULER + (i / count) * iw;
        const y1 = edge === 'top' ? RULER : RULER + ih;
        const y2 = edge === 'top' ? RULER - len : RULER + ih + len;
        out.push(<line key={`${edge}${i}`} x1={x} y1={y1} x2={x} y2={y2}
          stroke="var(--board-mark)" strokeWidth={major ? 0.8 : 0.4} />);
      } else {
        const y = RULER + (i / count) * ih;
        const x1 = edge === 'left' ? RULER : RULER + iw;
        const x2 = edge === 'left' ? RULER - len : RULER + iw + len;
        out.push(<line key={`${edge}${i}`} x1={x1} y1={y} x2={x2} y2={y}
          stroke="var(--board-mark)" strokeWidth={major ? 0.8 : 0.4} />);
      }
    }
    return out;
  }

  function diagonals() {
    const angles = [30, 36, 45, 60];
    const ox = RULER;
    const oy = RULER + ih;
    const reach = Math.hypot(iw, ih);
    return angles.map(deg => {
      const rad = (deg * Math.PI) / 180;
      const ex = ox + Math.cos(rad) * reach;
      const ey = oy - Math.sin(rad) * reach;
      const labelDist = Math.min(iw, ih) * 0.55;
      const lx = ox + Math.cos(rad) * labelDist;
      const ly = oy - Math.sin(rad) * labelDist;
      return (
        <g key={`d${deg}`}>
          <line x1={ox} y1={oy} x2={ex} y2={ey}
            stroke="var(--board-line-diag)" strokeWidth={0.5}
            clipPath={`url(#${clipId})`} />
          <text x={lx} y={ly} fill="var(--board-text-dim)" fontSize={9}
            fontFamily="system-ui, sans-serif"
            transform={`rotate(${-deg}, ${lx}, ${ly})`}>
            {deg}°
          </text>
        </g>
      );
    });
  }

  /* ── render ─────────────────────────────────────────────────── */

  return (
    <div
      ref={ref}
      className={className}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{
        '--board-bg': '#0f1a2e',
        '--board-line': 'rgba(60, 110, 180, 0.1)',
        '--board-line-major': 'rgba(60, 110, 180, 0.22)',
        '--board-line-diag': 'rgba(60, 110, 180, 0.18)',
        '--board-mark': 'rgba(120, 160, 210, 0.35)',
        '--board-text': 'rgba(120, 160, 210, 0.5)',
        '--board-text-dim': 'rgba(120, 160, 210, 0.35)',
        '--board-border': 'rgba(60, 110, 180, 0.35)',
        '--board-bar-bg': 'rgba(0, 0, 0, 0.3)',
        '--board-bar-text': 'rgba(120, 160, 210, 0.6)',
        position: 'relative',
        width: '100%',
        height,
        borderRadius: 'var(--r-card)',
        overflow: 'hidden',
        background: 'var(--board-bg)',
        cursor: drag ? 'grabbing' : 'default',
        touchAction: 'none',
        userSelect: 'none',
        ...style,
      } as CSSProperties}
    >
      {/* SVG grid layer */}
      {w > 0 && h > 0 && (
        <svg width={w} height={h}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <defs>
            <clipPath id={clipId}>
              <rect x={RULER} y={RULER} width={iw} height={ih} />
            </clipPath>
          </defs>

          {/* outer border */}
          <rect x={1} y={1} width={w - 2} height={h - 2} rx={22}
            fill="none" stroke="var(--board-border)" strokeWidth={1} />

          {/* grid area border */}
          <rect x={RULER} y={RULER} width={iw} height={ih}
            fill="none" stroke="var(--board-line-major)" strokeWidth={0.5} />

          {vLines()}
          {hLines()}
          {ticks('top')}
          {ticks('bottom')}
          {ticks('left')}
          {ticks('right')}
          {rulerNumbers()}
          {diagonals()}
        </svg>
      )}

      {/* Draggable items */}
      {items.map(it => {
        const p = pos[it.id] ?? { x: it.x, y: it.y };
        return (
          <img
            key={it.id}
            src={it.src}
            alt={it.label}
            draggable={false}
            onPointerDown={e => onDown(e, it.id)}
            onPointerEnter={() => {
              if (!drag) {
                const g = toGrid(p.x + it.width / 2, p.y + it.width / 2);
                setHover({ label: it.label, gx: g.gx, gy: g.gy });
              }
            }}
            onPointerLeave={() => { if (!drag) setHover(null); }}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              width: it.width,
              height: 'auto',
              cursor: drag?.id === it.id ? 'grabbing' : 'grab',
              transform: it.rotation ? `rotate(${it.rotation}deg)` : undefined,
              filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))',
              zIndex: drag?.id === it.id ? 10 : 1,
            }}
          />
        );
      })}

      {/* Status bar */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--board-bar-bg)',
        color: 'var(--board-bar-text)',
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        letterSpacing: '0.02em',
      }}>
        {hover ? `${hover.label}  X ${hover.gx.toFixed(2)}  Y ${hover.gy.toFixed(2)}` : '\u00A0'}
      </div>

      {/* Reset button (only when there are items) */}
      {items.length > 0 && (
        <button
          type="button"
          onClick={reset}
          aria-label="Reset item positions"
          style={{
            position: 'absolute',
            bottom: 30,
            right: 8,
            width: 40,
            height: 40,
            borderRadius: 8,
            border: '1px solid var(--board-border)',
            background: 'var(--board-bg)',
            color: 'var(--board-bar-text)',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            fontSize: 16,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          ↺
          <span style={{ fontSize: 8 }}>Reset</span>
        </button>
      )}
    </div>
  );
}
