import { describe, expect, it } from 'vitest';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { addOpening, addWallBetween } from '../src/core/ops';
import { computeFootprints, footprintPoly, wallPrisms } from '../src/core/wallGeometry';
import { dist, polygonArea } from '../src/core/geom2d';

const props = { height: 96, thickness: 4 };

function build(fn: (s: PlanStore) => void): PlanStore {
  const s = new PlanStore(createEmptyPlan());
  fn(s);
  return s;
}

describe('footprints', () => {
  it('extends free ends by half the thickness', () => {
    const s = build((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props)));
    const fp = [...computeFootprints(s.plan).values()][0];
    expect(fp.leftA).toEqual({ x: -2, y: 2 });
    expect(fp.rightA).toEqual({ x: -2, y: -2 });
    expect(fp.leftB).toEqual({ x: 102, y: 2 });
    expect(fp.rightB).toEqual({ x: 102, y: -2 });
  });

  it("doesn't move the outside corner when a perpendicular wall joins", () => {
    const one = build((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props)));
    const before = [...computeFootprints(one.plan).values()][0];
    const two = build((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props);
        addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 80 }, props);
      }),
    );
    const after = computeFootprints(two.plan).get(two.plan.walls[0].id)!;
    expect(dist(after.rightB, before.rightB)).toBeLessThan(1e-9);
  });

  it('miters an L corner with no gap or overlap', () => {
    const s = build((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props);
        addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 80 }, props);
      }),
    );
    const [w1, w2] = s.plan.walls;
    const fps = computeFootprints(s.plan);
    const f1 = fps.get(w1.id)!;
    const f2 = fps.get(w2.id)!;
    // Outside corner at (102,-2), inside at (98,2); both walls share them.
    expect(f1.rightB.x).toBeCloseTo(102);
    expect(f1.rightB.y).toBeCloseTo(-2);
    expect(f1.leftB.x).toBeCloseTo(98);
    expect(f1.leftB.y).toBeCloseTo(2);
    const shared = [f2.leftA, f2.rightA];
    expect(shared.some((p) => dist(p, f1.rightB) < 1e-9)).toBe(true);
    expect(shared.some((p) => dist(p, f1.leftB) < 1e-9)).toBe(true);
  });

  it('joins a T junction cleanly', () => {
    const s = build((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 200, y: 0 }, props);
        addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 80 }, props);
      }),
    );
    const fps = computeFootprints(s.plan);
    const stem = s.plan.walls.find((w) => {
      const a = s.plan.nodes.find((n) => n.id === w.a)!;
      const b = s.plan.nodes.find((n) => n.id === w.b)!;
      return a.x === b.x;
    })!;
    const f = fps.get(stem.id)!;
    // The stem's base corners sit on the through-wall's top face (y = 2).
    expect(f.leftA.y).toBeCloseTo(2);
    expect(f.rightA.y).toBeCloseTo(2);
    // Footprint areas sum to: through wall 204x4 (both ends extended) + stem 4x80 (top extended).
    let area = 0;
    for (const fp of fps.values()) area += Math.abs(polygonArea(footprintPoly(fp)));
    expect(area).toBeCloseTo(204 * 4 + 4 * 80, 6);
  });

  it('handles different thicknesses at a corner', () => {
    const s = build((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, { height: 96, thickness: 8 });
        addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 80 }, { height: 96, thickness: 4 });
      }),
    );
    const fps = computeFootprints(s.plan);
    const f1 = fps.get(s.plan.walls[0].id)!;
    expect(f1.rightB.x).toBeCloseTo(102);
    expect(f1.rightB.y).toBeCloseTo(-4);
  });

  it('squares a very sharp miter instead of spiking', () => {
    const s = build((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props);
        addWallBetween(d, { x: 100, y: 0 }, { x: 0, y: 3 }, props);
      }),
    );
    for (const fp of computeFootprints(s.plan).values()) {
      for (const p of [fp.leftA, fp.leftB, fp.rightA, fp.rightB]) {
        expect(dist(p, { x: 100, y: 0 }) < 20 || dist(p, { x: 0, y: 0 }) < 20 || dist(p, { x: 0, y: 3 }) < 20).toBe(true);
      }
    }
  });
});

describe('prisms around openings', () => {
  it('splits a wall around a door and a window', () => {
    const s = build((s) =>
      s.edit('w', (d) => {
        const id = addWallBetween(d, { x: 0, y: 0 }, { x: 200, y: 0 }, props)!;
        addOpening(d, { wallId: id, type: 'door', offset: 50, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
        addOpening(d, { wallId: id, type: 'window', offset: 150, width: 30, height: 20, sill: 50, hinge: 'a', swing: 'left' });
      }),
    );
    const w = s.plan.walls[0];
    const fp = computeFootprints(s.plan).get(w.id)!;
    const prisms = wallPrisms(fp, w, s.plan.openings);
    // full | door header | full | window header | window sill | full
    expect(prisms).toHaveLength(6);
    // Volume check: wall minus the two holes.
    const vol = prisms.reduce((acc, p) => acc + Math.abs(polygonArea(p.poly)) * (p.z1 - p.z0), 0);
    expect(vol).toBeCloseTo(204 * 4 * 96 - 32 * 4 * 80 - 30 * 4 * 20, 6);
  });

  it('gives a plain wall a single prism', () => {
    const s = build((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 50, y: 0 }, props)));
    const w = s.plan.walls[0];
    const fp = computeFootprints(s.plan).get(w.id)!;
    expect(wallPrisms(fp, w, [])).toHaveLength(1);
  });
});
