import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

/** One picture lying on the mat. Position and width are fractions of the mat, so the layout scales with it. */
export interface MatItem {
  id: string;
  src: string;
  alt: string;
  /** Centre, 0–1 across and down the mat. */
  x: number;
  y: number;
  /** Width as a fraction of the mat's width, never narrower than `minWidth` px. */
  width: number;
  minWidth?: number;
  /** Degrees, positive is clockwise. */
  rotate?: number;
}

interface Placed {
  x: number;
  y: number;
  z: number;
}

const ANGLES = [
  { deg: 30, at: 0.82 },
  { deg: 45, at: 0.78 },
  { deg: 60, at: 0.78 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The ruled grid, rulers and angle guides of a self-healing cutting mat, drawn at the mat's real pixel size so lines stay crisp. */
function MatRules({ w, h }: { w: number; h: number }) {
  // One ruler unit; the mat shows about eight of them along its longer side.
  const u = clamp(Math.max(w, h) / 10, 40, 160);
  const o = u * 0.37; // ruler edge
  const g = u * 0.81; // grid edge
  const gw = w - 2 * g;
  const gh = h - 2 * g;
  const font = clamp(u * 0.13, 10, 20);
  const lines: ReactNode[] = [];

  // Grid: half units faint, whole units brighter.
  for (let i = 0, x = g; x <= w - g + 0.5; i++, x = g + (i * u) / 2) {
    lines.push(<line key={`gx${i}`} x1={x} y1={g} x2={x} y2={h - g} className={i % 2 ? 'mat-soft' : 'mat-line'} />);
  }
  for (let i = 0, y = h - g; y >= g - 0.5; i++, y = h - g - (i * u) / 2) {
    lines.push(<line key={`gy${i}`} x1={g} y1={y} x2={w - g} y2={y} className={i % 2 ? 'mat-soft' : 'mat-line'} />);
  }

  // Rulers: eighths, halves and whole units, on all four sides.
  const tick = (i: number) => (i % 8 === 0 ? u * 0.24 : i % 4 === 0 ? u * 0.14 : u * 0.07);
  for (let i = -Math.floor((g - o) / (u / 8)); g + (i * u) / 8 <= w - o; i++) {
    const x = g + (i * u) / 8;
    if (x < o) continue;
    const t = tick(i);
    lines.push(<line key={`tt${i}`} x1={x} y1={o} x2={x} y2={o + t} className="mat-line" />);
    lines.push(<line key={`tb${i}`} x1={x} y1={h - o} x2={x} y2={h - o - t} className="mat-line" />);
  }
  for (let i = -Math.floor((g - o) / (u / 8)); h - g - (i * u) / 8 >= o; i++) {
    const y = h - g - (i * u) / 8;
    if (y > h - o) continue;
    const t = tick(i);
    lines.push(<line key={`tl${i}`} x1={o} y1={y} x2={o + t} y2={y} className="mat-line" />);
    lines.push(<line key={`tr${i}`} x1={w - o} y1={y} x2={w - o - t} y2={y} className="mat-line" />);
  }

  // Numbers along each ruler, counting from the bottom-left corner of the grid.
  const labels: ReactNode[] = [];
  for (let i = 0; i * u <= gw + 0.5; i++) {
    const x = g + i * u;
    labels.push(
      <text key={`nt${i}`} x={x} y={o + u * 0.4} textAnchor="middle">{i}</text>,
      <text key={`nb${i}`} x={x} y={h - o - u * 0.28} textAnchor="middle">{i}</text>,
    );
  }
  for (let i = 0; i * u <= gh + 0.5; i++) {
    const y = h - g - i * u + font * 0.35;
    labels.push(
      <text key={`nl${i}`} x={g - u * 0.05} y={y} textAnchor="end">{i}</text>,
      <text key={`nr${i}`} x={w - g + u * 0.05} y={y} textAnchor="start">{i}</text>,
    );
  }

  // Angle guides from the grid's bottom-left corner, each broken by its label.
  const guides = ANGLES.map(({ deg, at }) => {
    const r = (deg * Math.PI) / 180;
    const dx = Math.cos(r);
    const dy = Math.sin(r);
    const len = Math.min(gw / dx, gh / dy);
    const lx = g + dx * len * at;
    const ly = h - g - dy * len * at;
    const pad = font * 1.6;
    return (
      <g key={deg}>
        <line x1={g} y1={h - g} x2={lx - dx * pad} y2={ly + dy * pad} className="mat-line" />
        <line x1={lx + dx * pad} y1={ly - dy * pad} x2={g + dx * len} y2={h - g - dy * len} className="mat-line" />
        <text x={lx} y={ly + font * 0.35} textAnchor="middle" className="mat-angle">{`${deg}°`}</text>
      </g>
    );
  });

  return (
    <svg className="mat-rules" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ fontSize: font }}>
      <rect x={o} y={o} width={w - 2 * o} height={h - 2 * o} className="mat-line" fill="none" />
      <rect x={g} y={g} width={gw} height={gh} className="mat-line" fill="none" />
      {lines}
      {guides}
      {labels}
    </svg>
  );
}

/**
 * A cutting mat with pictures you can pick up and move, after the YC @ U of T visit page.
 * Drag with a mouse, finger or pen; or focus a picture and use the arrow keys (Shift for bigger steps).
 * `children` sit centred on the mat, above the grid and below the pictures, and never block a drag.
 */
export function CuttingMat({ items, label, children }: { items: MatItem[]; label: string; children?: ReactNode }) {
  const matRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [placed, setPlaced] = useState<Record<string, Placed>>(() =>
    Object.fromEntries(items.map((it, i) => [it.id, { x: it.x, y: it.y, z: i + 1 }])),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const top = useRef(items.length);
  // The one pointer moving a picture; a second finger or a stray pen can't hijack the drag.
  const grab = useRef({ pointer: -1, dx: 0, dy: 0 });

  useLayoutEffect(() => {
    const el = matRef.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pictures added later start where their item says. Returning the same object when nothing is new keeps an
  // inline `items` array from re-rendering forever.
  useEffect(() => {
    setPlaced((p) => {
      const added = items.filter((it) => !p[it.id]);
      if (!added.length) return p;
      const next = { ...p };
      for (const it of added) next[it.id] = { x: it.x, y: it.y, z: ++top.current };
      return next;
    });
  }, [items]);

  const raise = useCallback((id: string) => {
    setPlaced((p) => (p[id] ? { ...p, [id]: { ...p[id], z: ++top.current } } : p));
  }, []);

  const moveTo = useCallback((id: string, x: number, y: number) => {
    setPlaced((p) => (p[id] ? { ...p, [id]: { ...p[id], x: clamp(x, 0, 1), y: clamp(y, 0, 1) } } : p));
  }, []);

  const moveBy = useCallback((id: string, dx: number, dy: number) => {
    setPlaced((p) => (p[id] ? { ...p, [id]: { ...p[id], x: clamp(p[id].x + dx, 0, 1), y: clamp(p[id].y + dy, 0, 1), z: ++top.current } } : p));
  }, []);

  const onPointerDown = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    const at = placed[id];
    if (e.button !== 0 || !matRef.current || !at || dragging) return;
    const box = matRef.current.getBoundingClientRect();
    if (!box.width || !box.height) return;
    grab.current = { pointer: e.pointerId, dx: (e.clientX - box.left) / box.width - at.x, dy: (e.clientY - box.top) / box.height - at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
    raise(id);
  };

  const onPointerMove = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    if (dragging !== id || e.pointerId !== grab.current.pointer || !matRef.current) return;
    const box = matRef.current.getBoundingClientRect();
    if (!box.width || !box.height) return;
    moveTo(id, (e.clientX - box.left) / box.width - grab.current.dx, (e.clientY - box.top) / box.height - grab.current.dy);
  };

  // Also runs on cancel and on lost capture (e.g. the tab loses focus mid-drag), so a picture is never left stuck.
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== grab.current.pointer) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    grab.current.pointer = -1;
    setDragging(null);
  };

  const onKeyDown = (id: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    moveBy(id, d[0], d[1]);
  };

  return (
    <section className="mat-frame" aria-label={label}>
      <div className="mat" ref={matRef}>
        {size.w > 0 && size.h > 0 && <MatRules w={size.w} h={size.h} />}
        {children && <div className="mat-center">{children}</div>}
        {items.map((it) => {
          const at = placed[it.id];
          if (!at) return null;
          return (
            <button
              key={it.id}
              type="button"
              className={`mat-item${dragging === it.id ? ' is-dragging' : ''}`}
              aria-label={`${it.alt}. Drag, or use the arrow keys, to move it.`}
              style={{
                left: `${at.x * 100}%`,
                top: `${at.y * 100}%`,
                width: `max(${it.minWidth ?? 64}px, ${it.width * 100}%)`,
                zIndex: at.z,
                ['--mat-rotate' as string]: `${it.rotate ?? 0}deg`,
              }}
              onPointerDown={onPointerDown(it.id)}
              onPointerMove={onPointerMove(it.id)}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={onPointerUp}
              onKeyDown={onKeyDown(it.id)}
            >
              <img src={it.src} alt="" draggable={false} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
