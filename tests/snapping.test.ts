import { describe, expect, it } from 'vitest';
import { createEmptyPlan, type Plan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { addWallBetween, replaceExistingWalls } from '../src/core/ops';
import { defaultSnapOptions, primaryAxis, snap, type SnapOptions } from '../src/core/snapping';

const props = { height: 96, thickness: 4.5 };

function planWith(fn: (s: PlanStore) => void): Plan {
  const s = new PlanStore(createEmptyPlan());
  fn(s);
  return s.plan;
}

const opts = (o: Partial<SnapOptions> = {}): SnapOptions => ({ ...defaultSnapOptions, tolerance: 3, ...o });

const L = planWith((s) =>
  s.edit('w', (d) => {
    addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, props);
    addWallBetween(d, { x: 120, y: 0 }, { x: 120, y: 96 }, props);
  }),
);

describe('point snaps', () => {
  it('snaps to an endpoint', () => {
    const r = snap(L, { x: 121.5, y: 1 }, opts());
    expect(r.kind).toBe('endpoint');
    expect(r.point).toEqual({ x: 120, y: 0 });
  });

  it('snaps to a midpoint', () => {
    const r = snap(L, { x: 60.8, y: 0.5 }, opts());
    expect(r.kind).toBe('midpoint');
    expect(r.point).toEqual({ x: 60, y: 0 });
  });

  it('prefers the endpoint over a nearby midpoint', () => {
    const tiny = planWith((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 4, y: 0 }, props)));
    expect(snap(tiny, { x: 0.5, y: 0 }, opts()).kind).toBe('endpoint');
  });
});

describe('edge snaps', () => {
  it('lands on a wall centerline', () => {
    const r = snap(L, { x: 37.3, y: 1.2 }, opts({ maxGuideNodes: 0 }));
    expect(r.kind).toBe('edge');
    expect(r.point.y).toBeCloseTo(0);
    expect(r.point.x).toBeCloseTo(37.3);
  });
});

describe('guides while drawing', () => {
  it('locks to 90° from the chain start and rounds length to the inch', () => {
    const r = snap(L, { x: 120.8, y: 150.4 }, opts({ from: { x: 120, y: 96 } }));
    expect(r.kind).toBe('angle');
    expect(r.point.x).toBeCloseTo(120);
    expect(r.point.y).toBeCloseTo(150);
  });

  it('locks to 45°', () => {
    const r = snap(L, { x: 30.6, y: 29.1 }, opts({ from: { x: 0, y: 0 }, maxGuideNodes: 0 }));
    expect(r.kind).toBe('angle');
    expect(r.point.x).toBeCloseTo(r.point.y, 6);
  });

  it('finds the intersection of an angle guide and an extension from another corner', () => {
    // Drawing up from (0,0); the corner (120,96) projects a horizontal guide at y=96.
    const r = snap(L, { x: 1.2, y: 97.5 }, opts({ from: { x: 0, y: 0 } }));
    expect(r.kind).toBe('intersection');
    expect(r.point.x).toBeCloseTo(0);
    expect(r.point.y).toBeCloseTo(96);
    expect(r.guides).toHaveLength(2);
  });

  it('respects a rotated room axis', () => {
    const ang = (20 * Math.PI) / 180;
    const p = { x: 100 * Math.cos(ang) - 0.8 * Math.sin(ang), y: 100 * Math.sin(ang) + 0.8 * Math.cos(ang) };
    const r = snap(createEmptyPlan(), p, opts({ from: { x: 0, y: 0 }, axisAngle: ang }));
    expect(r.kind).toBe('angle');
    expect(Math.hypot(r.point.x, r.point.y)).toBeCloseTo(100, 6);
    expect(Math.atan2(r.point.y, r.point.x)).toBeCloseTo(ang, 6);
  });

  it('falls back to the grid when nothing is close', () => {
    const r = snap(createEmptyPlan(), { x: 10.4, y: 22.6 }, opts());
    expect(r.kind).toBe('grid');
    expect(r.point).toEqual({ x: 10, y: 23 });
  });

  it('returns a 1/4" point when snapping is disabled', () => {
    const r = snap(L, { x: 120.3, y: 0.1 }, opts({ disabled: true }));
    expect(r.kind).toBe('free');
    expect(r.point).toEqual({ x: 120.25, y: 0 });
  });
});

describe('foundation follow', () => {
  it('offsets new walls off an existing foundation wall by thickness + gap', () => {
    const p = planWith((s) => s.edit('i', (d) => replaceExistingWalls(d, [{ a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }], 96)));
    // existing half (4) + gap (1) + new half (2.25) = 7.25
    const r = snap(p, { x: 200, y: 8.3 }, opts({ maxGuideNodes: 0 }));
    expect(r.kind).toBe('follow');
    expect(r.point.y).toBeCloseTo(7.25);
  });
});

describe('primaryAxis', () => {
  it('prefers the longest existing wall', () => {
    const ang = (10 * Math.PI) / 180;
    const p = planWith((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 0, y: 500 }, props);
        replaceExistingWalls(d, [{ a: { x: 0, y: 0 }, b: { x: 200 * Math.cos(ang), y: 200 * Math.sin(ang) } }], 96);
      }),
    );
    expect(primaryAxis(p)).toBeCloseTo(ang, 6);
  });

  it('folds into a quarter turn', () => {
    const p = planWith((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 0, y: 100 }, props)));
    expect(primaryAxis(p)).toBeCloseTo(0, 6);
  });
});
