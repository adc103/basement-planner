import { describe, expect, it } from 'vitest';
import { CommandBus } from '../src/core/commands';
import { createEmptyPlan } from '../src/core/plan';
import { edgeNormal, faceAt, pushSide, rayLineParam, rectSize } from '../src/core/pushPull';
import { PlanStore } from '../src/core/store';

const rect = [
  { x: 0, y: 0 },
  { x: 48, y: 0 },
  { x: 48, y: 18 },
  { x: 0, y: 18 },
];

describe('push/pull', () => {
  it('finds outward normals for either winding', () => {
    expect(edgeNormal(rect, 0)).toEqual({ x: 0, y: -1 });
    const cw = [...rect].reverse();
    // cw edge 0 runs (0,18)->(48,18): its outside is +y
    expect(edgeNormal(cw, 0).y).toBeCloseTo(1);
  });

  it('pushes one side out and keeps the far side', () => {
    const r = pushSide(rect, 1, 6)!; // the x = 48 side
    expect(rectSize(r)).toEqual({ w: 54, d: 18 });
    expect(r[0]).toEqual(rect[0]);
    expect(pushSide(rect, 1, -48)).toBeNull(); // would turn inside out
  });

  it('tells faces apart by where you point', () => {
    expect(faceAt(rect, 0, 18, { x: 24, y: 9, z: 18 })).toBe('top');
    expect(faceAt(rect, 0, 18, { x: 48, y: 9, z: 9 })).toEqual({ side: 1 });
    expect(faceAt(rect, 0, 18, { x: 20, y: 0, z: 9 })).toEqual({ side: 0 });
  });

  it('reads a drag from a ray, wherever it points', () => {
    // Line along +x through (48, 9, 9); a ray from above aimed at x = 60.
    const s = rayLineParam({ x: 60, y: -30, z: 60 }, norm({ x: 0, y: 30, z: -51 }), { x: 48, y: 9, z: 9 }, { x: 1, y: 0, z: 0 });
    expect(s).toBeCloseTo(12, 6);
  });

  it('runs as commands, locks included', () => {
    const b = new CommandBus(new PlanStore(createEmptyPlan()));
    const id = b.run('box.add', { poly: rect, z1: 18, label: 'Bench' })!;
    expect(b.exec('box.update', { id, poly: pushSide(rect, 2, 4)!, z1: 20 }).ok).toBe(true);
    expect(b.store.plan.boxes[0]).toMatchObject({ z1: 20, label: 'Bench' });
    expect(rectSize(b.store.plan.boxes[0].poly).d).toBeCloseTo(22);
    b.run('element.setLocked', { id, locked: true });
    expect(b.exec('box.update', { id, z1: 30 }).ok).toBe(false);
    expect(b.exec('element.delete', { id }).ok).toBe(false);
    expect(b.exec('box.add', { poly: rect, z0: 10, z1: 5 }).ok).toBe(false);
  });
});

function norm(v: { x: number; y: number; z: number }) {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
