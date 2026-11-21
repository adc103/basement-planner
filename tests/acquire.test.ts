import { describe, expect, it } from 'vitest';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { addWallBetween } from '../src/core/ops';
import { defaultSnapOptions, snap } from '../src/core/snapping';
import { Acquired } from '../src/xr/acquired';

describe('inference', () => {
  const s = new PlanStore(createEmptyPlan());
  s.edit('w', (d) => {
    addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, { height: 96, thickness: 4.5 });
  });

  it('corners are sticky: within 1.5x the line radius', () => {
    const r = snap(s.plan, { x: 124, y: 2 }, { ...defaultSnapOptions, tolerance: 4 });
    expect(r.kind).toBe('endpoint');
  });

  it('a hovered point gives guides that line up with it', () => {
    const far = { x: 400, y: 300 };
    const opts = { ...defaultSnapOptions, tolerance: 3, maxGuideNodes: 0, acquired: [far] };
    const r = snap(s.plan, { x: 401.5, y: 150 }, opts);
    expect(r.kind).toBe('extension');
    expect(r.point.x).toBeCloseTo(400);
  });

  it('acquires a point after resting on it', () => {
    const a = new Acquired();
    a.hover({ x: 5, y: 5 }, 0);
    a.hover({ x: 5, y: 5 }, 0.1);
    expect(a.points()).toHaveLength(0);
    a.hover({ x: 5, y: 5 }, 0.35);
    expect(a.points()).toHaveLength(1);
  });
});
