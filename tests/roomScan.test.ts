import { describe, expect, it } from 'vitest';
import { wallsFromScan, type P3, type ScanPlane } from '../src/core/roomScan';
import { dist } from '../src/core/geom2d';

// World meters -> plan inches, identity orientation.
const toPlan = (w: P3) => ({ p: { x: w.x / 0.0254, y: w.z / 0.0254 }, y: w.y });

/** A vertical wall plane from (x0,z0) to (x1,z1), 2.4 m tall, slightly short of the corners like real scans. */
function wall(x0: number, z0: number, x1: number, z1: number): ScanPlane {
  return {
    label: 'wall',
    points: [
      { x: x0, y: 0, z: z0 },
      { x: x1, y: 0, z: z1 },
      { x: x1, y: 2.4, z: z1 },
      { x: x0, y: 2.4, z: z0 },
    ],
  };
}

describe('wallsFromScan', () => {
  // A 4 m x 3 m room, each wall face trimmed 5 cm at both ends.
  const planes: ScanPlane[] = [
    wall(0.05, 0, 3.95, 0),
    wall(4, 0.05, 4, 2.95),
    wall(3.95, 3, 0.05, 3),
    wall(0, 2.95, 0, 0.05),
    { label: 'floor', points: [{ x: 0, y: 0.01, z: 0 }, { x: 4, y: 0.01, z: 0 }, { x: 4, y: 0.01, z: 3 }] },
    { label: 'ceiling', points: [{ x: 0, y: 2.4, z: 0 }, { x: 4, y: 2.4, z: 0 }, { x: 4, y: 2.4, z: 3 }] },
    { label: 'table', points: [{ x: 1, y: 0.7, z: 1 }] },
  ];
  const r = wallsFromScan(planes, toPlan, 8);

  it('finds four walls and the floor/ceiling heights', () => {
    expect(r.walls).toHaveLength(4);
    expect(r.floorY).toBeCloseTo(0.01);
    expect(r.ceilingY).toBeCloseTo(2.4);
  });

  it('moves centerlines outward by half the foundation thickness and closes the corners', () => {
    const inch = 1 / 0.0254;
    const corner = { x: -4, y: -4 }; // outward of (0,0) by 4" each way
    const ends = r.walls.flatMap((w) => [w.a, w.b]);
    expect(ends.filter((e) => dist(e, corner) < 1e-6)).toHaveLength(2);
    const far = { x: 4 * inch + 4, y: 3 * inch + 4 };
    expect(ends.filter((e) => dist(e, far) < 1e-6)).toHaveLength(2);
  });

  it('returns nothing when there are no walls', () => {
    expect(wallsFromScan([], toPlan, 8).walls).toHaveLength(0);
  });
});
