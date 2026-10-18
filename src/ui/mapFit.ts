/**
 * Auto-fit for the group map: centre on the middle of everyone's positions and
 * zoom so the group fills the map, then nudge avatars that would still sit on
 * top of each other. Pure functions, shared by the Google map and the
 * synthetic venue plot.
 */

/** Metres per pixel at zoom 0 on the equator (Web Mercator, 256 px tiles). */
const M_PER_PX_Z0 = 156_543.033_92;

export interface Pt {
  x: number;
  y: number;
}

/** Midpoint of the bounding box and its size. Not the average: one straggler shouldn't pull the centre. */
export function groupBounds(points: Pt[]): { cx: number; cy: number; w: number; h: number } | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/**
 * Margin kept around the group, in CSS px: about 12% of the map's shorter
 * side, so a small phone map doesn't lose most of its area to padding and a
 * large monitor doesn't crowd the edges. Never less than an avatar's radius
 * plus a little, so pins at the edge aren't clipped.
 */
export function fitPadding(width: number, height: number): number {
  return clamp(Math.round(Math.min(width, height) * 0.12), 24, 72);
}

export interface PlotView {
  /** Centre in metres (same frame as the points). */
  cx: number;
  cy: number;
  /** Pixels per metre, the same on both axes. */
  scale: number;
  /** Pixel position the centre maps to (not the plot's middle when the top keeps room for a label). */
  px: number;
  py: number;
}

/**
 * The view for a synthetic plot of `width`×`height` px. The group fits inside
 * `pad` px on every side (default: `fitPadding`; `padTop` at the top, where the map label sits); a lone person or a tight group shows at least
 * `minSpanM` metres across: phone GPS is only good to a few metres, so
 * zooming closer would show precision the data does not have.
 */
export function fitPlot(
  points: Pt[],
  width: number,
  height: number,
  opts: { pad?: number; padTop?: number; minSpanM?: number; maxSpanM?: number; emptySpanM?: number } = {},
): PlotView {
  const { pad = fitPadding(width, height), minSpanM = 10, maxSpanM = 2_000, emptySpanM = 120 } = opts;
  const padTop = Math.max(pad, opts.padTop ?? pad);
  const b = groupBounds(points);
  const usableW = Math.max(1, width - 2 * pad);
  const usableH = Math.max(1, height - pad - padTop);
  const px = width / 2;
  const py = padTop + usableH / 2;
  if (!b) return { cx: 0, cy: 0, scale: Math.min(width, height) / emptySpanM, px: width / 2, py: height / 2 };
  const spanW = clamp(b.w, minSpanM, maxSpanM);
  const spanH = clamp(b.h, minSpanM, maxSpanM);
  return { cx: b.cx, cy: b.cy, scale: Math.min(usableW / spanW, usableH / spanH), px, py };
}

/** A point in metres to pixels from the plot's top-left (north is up). */
export function toPlotPx(p: Pt, view: PlotView): Pt {
  return { x: view.px + (p.x - view.cx) * view.scale, y: view.py - (p.y - view.cy) * view.scale };
}

/**
 * The Google zoom level that fits a group spanning `spanXM` × `spanYM` metres
 * into a `width`×`height` px map with `pad` px margins (default: `fitPadding`), capped at `maxZoom`
 * (the deepest level the imagery has at that spot).
 */
export function zoomForSpan(
  spanXM: number,
  spanYM: number,
  width: number,
  height: number,
  lat: number,
  maxZoom: number,
  pad = fitPadding(width, height),
): number {
  const usableW = Math.max(1, width - 2 * pad);
  const usableH = Math.max(1, height - 2 * pad);
  // Metres per pixel needed so the span fits, on the tighter axis.
  const need = Math.max(spanXM / usableW, spanYM / usableH);
  if (need <= 0) return maxZoom;
  const z = Math.log2((M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / need);
  return clamp(Math.floor(z), 0, maxZoom);
}

/** Lat/lng to Web Mercator world pixels at `zoom`, for measuring how far apart pins land on screen. */
export function worldPx(lat: number, lng: number, zoom: number): Pt {
  const size = 256 * 2 ** zoom;
  const s = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

/**
 * Pixel offsets that keep avatars of diameter `minGap` from overlapping, moving
 * each as little as needed. Pins at the same spot fan out in a small ring.
 * Deterministic: the same input always gives the same layout, so pins don't
 * jitter between renders.
 */
export function spreadOverlaps(px: Pt[], minGap: number, iterations = 24): Pt[] {
  const out = px.map((p) => ({ ...p }));
  const n = out.length;
  // Exact duplicates have no direction to push in; start them on a ring.
  for (let i = 0; i < n; i++) {
    const same = [] as number[];
    for (let j = 0; j < n; j++) if (Math.hypot(px[j].x - px[i].x, px[j].y - px[i].y) < 0.5) same.push(j);
    if (same.length > 1 && same[0] === i) {
      const r = minGap / (2 * Math.sin(Math.PI / same.length));
      same.forEach((j, k) => {
        const a = (2 * Math.PI * k) / same.length - Math.PI / 2;
        out[j] = { x: px[j].x + r * Math.cos(a), y: px[j].y + r * Math.sin(a) };
      });
    }
  }
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = out[j].x - out[i].x;
        const dy = out[j].y - out[i].y;
        const d = Math.hypot(dx, dy);
        if (d >= minGap || d === 0) continue;
        const push = (minGap - d) / 2;
        out[i].x -= (dx / d) * push;
        out[i].y -= (dy / d) * push;
        out[j].x += (dx / d) * push;
        out[j].y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out.map((p, i) => ({ x: p.x - px[i].x, y: p.y - px[i].y }));
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
