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

  it('turns two rooms sharing a wall into one wall with its real thickness and door', () => {
    // Room A: x 0..3 m, room B: x 3.13..6 m (a 13 cm = ~5" wall between), both 0..3 m deep.
    const floor = (x0: number, x1: number): ScanPlane => ({ label: 'floor', points: [{ x: x0, y: 0, z: 0 }, { x: x1, y: 0, z: 0 }, { x: x1, y: 0, z: 3 }, { x: x0, y: 0, z: 3 }] });
    const two: ScanPlane[] = [
      wall(0, 0, 3, 0), wall(3, 0, 3, 3), wall(3, 3, 0, 3), wall(0, 3, 0, 0), floor(0, 3),
      wall(3.13, 0, 6, 0), wall(6, 0, 6, 3), wall(6, 3, 3.13, 3), wall(3.13, 3, 3.13, 0), floor(3.13, 6),
      // An 82 cm wide, 2.03 m tall door frame in the shared wall, seen from room A.
      { label: 'door frame', points: [{ x: 3, y: 0, z: 1.0 }, { x: 3, y: 0, z: 1.82 }, { x: 3, y: 2.03, z: 1.82 }, { x: 3, y: 2.03, z: 1.0 }] },
    ];
    const res = wallsFromScan(two, toPlan, 8);
    const inch = 1 / 0.0254;
    const shared = res.walls.filter((w) => Math.abs(w.a.x - w.b.x) < 1 && w.a.x > 2.9 * inch && w.a.x < 3.2 * inch);
    expect(shared).toHaveLength(1);
    expect(shared[0].thickness).toBeCloseTo(0.13 * inch, 0);
    expect(shared[0].a.x).toBeCloseTo(3.065 * inch, 0);
    expect(shared[0].openings).toHaveLength(1);
    const door = shared[0].openings![0];
    expect(door.type).toBe('door');
    expect(door.width).toBeCloseTo(0.82 * inch, 0);
    expect(door.height).toBeCloseTo(2.03 * inch, 0);
    // The outside walls are still single faces pushed out by half the foundation.
    expect(res.walls).toHaveLength(7);
  });
});
