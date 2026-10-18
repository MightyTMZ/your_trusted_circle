import { describe, expect, it } from 'vitest';
import { fitPadding, fitPlot, groupBounds, spreadOverlaps, toPlotPx, worldPx, zoomForSpan } from '../src/ui/mapFit';

describe('groupBounds', () => {
  it('centres on the midpoint of the bounding box, not the average', () => {
    // Three people together and one straggler: the centre sits halfway, not near the cluster.
    const b = groupBounds([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 40, y: 0 }]);
    expect(b).toEqual({ cx: 20, cy: 0.5, w: 40, h: 1 });
  });
  it('is null for nobody', () => expect(groupBounds([])).toBeNull());
});

describe('fitPlot', () => {
  const W = 400;
  const H = 280;
  it('zooms in on a tight group so they spread across the plot', () => {
    // Five people within 4 m: at the old fixed ±60 m they'd sit within ~6 px of each other.
    const pts = [{ x: 30, y: 30 }, { x: 31, y: 32 }, { x: 33, y: 30 }, { x: 34, y: 33 }, { x: 32, y: 34 }];
    const view = fitPlot(pts, W, H);
    const px = pts.map((p) => toPlotPx(p, view));
    const xs = px.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
    // Centred: the group's midpoint lands in the middle of the plot.
    expect(toPlotPx({ x: view.cx, y: view.cy }, view)).toEqual({ x: W / 2, y: H / 2 });
  });
  it('keeps a spread-out group inside the padding on both axes', () => {
    const pts = [{ x: -200, y: -10 }, { x: 150, y: 90 }];
    const view = fitPlot(pts, W, H, { pad: 36 });
    for (const p of pts.map((q) => toPlotPx(q, view))) {
      expect(p.x).toBeGreaterThanOrEqual(36 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(W - 36 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(36 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(H - 36 + 1e-9);
    }
  });
  it('keeps the top clear for the map label', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const view = fitPlot(pts, W, H, { pad: 36, padTop: 64 });
    const top = toPlotPx({ x: 0, y: 100 }, view);
    const bottom = toPlotPx({ x: 0, y: 0 }, view);
    expect(top.y).toBeCloseTo(64);
    expect(bottom.y).toBeCloseTo(H - 36);
  });
  it('uses the same scale on both axes', () => {
    const view = fitPlot([{ x: 0, y: 0 }, { x: 10, y: 10 }], W, H);
    const a = toPlotPx({ x: 0, y: 0 }, view);
    const b = toPlotPx({ x: 10, y: 10 }, view);
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(b.y - a.y));
  });
  it('never zooms past the minimum span for one person', () => {
    const view = fitPlot([{ x: 5, y: 5 }], W, H, { pad: 36, minSpanM: 10 });
    expect(view.scale).toBeCloseTo((H - 72) / 10);
  });
});

describe('fitPadding', () => {
  it('scales the margin with the map, within limits', () => {
    expect(fitPadding(320, 200)).toBe(24);
    expect(fitPadding(600, 420)).toBe(50);
    expect(fitPadding(2400, 1400)).toBe(72);
  });
});

describe('zoomForSpan', () => {
  it('zooms out further on a smaller map for the same group', () => {
    const big = zoomForSpan(80, 50, 1600, 1000, 43.65, 21);
    const small = zoomForSpan(80, 50, 320, 220, 43.65, 21);
    expect(small).toBeLessThan(big);
  });
  it('zooms closer for a smaller group, up to the imagery limit', () => {
    const wide = zoomForSpan(300, 200, 390, 280, 43.65, 21);
    const tight = zoomForSpan(6, 4, 390, 280, 43.65, 21);
    expect(tight).toBeGreaterThan(wide);
    expect(tight).toBe(21);
    expect(zoomForSpan(6, 4, 390, 280, 43.65, 19)).toBe(19);
  });
  it('fits the span: the chosen zoom shows at least the group', () => {
    const z = zoomForSpan(120, 40, 390, 280, 43.65, 22, 48);
    const mPerPx = (156_543.03392 * Math.cos((43.65 * Math.PI) / 180)) / 2 ** z;
    expect(120 / mPerPx).toBeLessThanOrEqual(390 - 96);
  });
});

describe('spreadOverlaps', () => {
  it('leaves pins that already have room alone', () => {
    expect(spreadOverlaps([{ x: 0, y: 0 }, { x: 100, y: 0 }], 40)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });
  it('fans out people at the exact same spot so every avatar shows', () => {
    const src = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }];
    const off = spreadOverlaps(src, 40);
    const placed = src.map((p, i) => ({ x: p.x + off[i].x, y: p.y + off[i].y }));
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y)).toBeGreaterThanOrEqual(39.9);
  });
  it('is deterministic', () => {
    const src = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 2, y: 8 }, { x: 0, y: 0 }];
    expect(spreadOverlaps(src, 40)).toEqual(spreadOverlaps(src, 40));
  });
});

describe('worldPx', () => {
  it('doubles distances with each zoom level', () => {
    const a = worldPx(43.65, -79.38, 18);
    const b = worldPx(43.6501, -79.3799, 18);
    const a2 = worldPx(43.65, -79.38, 19);
    const b2 = worldPx(43.6501, -79.3799, 19);
    expect(b2.x - a2.x).toBeCloseTo(2 * (b.x - a.x));
  });
});
