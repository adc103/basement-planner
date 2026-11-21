import { describe, expect, it } from 'vitest';
import { ScanMap, unprojectDepth } from '../src/core/scanMap';
import { findStructure } from '../src/core/structure';
import { basementScene, scanScene } from './synthScan';
import { createEmptyPlan } from '../src/core/plan';
import type { PP } from '../src/core/wallDetect';

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 2;
}

/**
 * Synthetic scanned basement, 30' x 20', 96" ceiling:
 * 4 foundation walls, an interior partition along x = 200 (y 0..120),
 * a 12" x 8" duct hanging to 88" along y = 180 from x 40..280, and a 4" post at (300, 120).
 */
function basement(): PP[] {
  const r = rng(3);
  const pts: PP[] = [];
  const W = 360;
  const D = 240;
  const H = 96;
  const n = () => r() * 0.4;
  for (let x = 0; x <= W; x += 3) for (let z = 0; z <= H; z += 4) pts.push({ x, y: n(), z }, { x, y: D + n(), z });
  for (let y = 0; y <= D; y += 3) for (let z = 0; z <= H; z += 4) pts.push({ x: n(), y, z }, { x: W + n(), y, z });
  for (let x = 0; x <= W; x += 6) for (let y = 0; y <= D; y += 6) pts.push({ x, y, z: n() }, { x, y, z: H + n() });
  // Partition: both faces visible.
  // with a 32" doorway (y 40..72) under an 80" header.
  for (let y = 0; y <= 120; y += 3) for (let z = 0; z <= H; z += 4) {
    if (y > 40 && y < 72 && z < 80) continue;
    pts.push({ x: 200 + n(), y, z }, { x: 204.5 + n(), y, z });
  }
  // Duct underside at 88" plus its sides.
  for (let x = 40; x <= 280; x += 3) for (let y = 174; y <= 186; y += 3) pts.push({ x, y, z: 88 + n() });
  // A jacket hanging on the south wall, and an armful of clutter in the middle of the room.
  for (let x = 100; x <= 124; x += 2) for (let z = 30; z <= 62; z += 2) pts.push({ x, y: 4 + (x % 6) * 0.5, z });
  for (let i = 0; i < 400; i++) pts.push({ x: 150 + r() * 15, y: 60 + r() * 15, z: 40 + r() * 15 });
  // Post.
  for (let z = 0; z <= H; z += 2) for (const [dx, dy] of [[0, 0], [4, 0], [0, 4], [4, 4], [2, 0], [0, 2]]) pts.push({ x: 300 + dx, y: 120 + dy, z });
  return pts;
}

describe('scan map', () => {
  it('merges samples into voxels and drops one-off noise', () => {
    const m = new ScanMap(2);
    for (let i = 0; i < 10; i++) m.add(10.1, 10.2, 30);
    m.add(50, 50, 50);
    expect(m.size).toBe(2);
    expect(m.points(2)).toHaveLength(1);
    const m2 = new ScanMap(2);
    m2.load(m.serialize());
    expect(m2.points(2)[0].x).toBeCloseTo(10.1);
  });

  it('unprojects depth pixels', () => {
    // Symmetric 90 degree FOV: proj[0] = proj[5] = 1.
    const P = new Float32Array(16);
    P[0] = 1;
    P[5] = 1;
    expect(unprojectDepth(0.5, 0.5, 2, P)).toEqual({ x: 0, y: 0, z: -2 });
    const p = unprojectDepth(1, 0.5, 2, P);
    expect(p.x).toBeCloseTo(2);
  });
});

function rotateAll(pts: PP[], ang: number): PP[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return pts.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z }));
}

describe('structure detection (ray-cast basement)', () => {
  const scene = basementScene();
  const { map, free } = scanScene(scene);
  const pts = map.points(2);
  const opts = { eye: { x: 100, y: 100 }, axisAngle: null, partitionThickness: 4.5, foundationThickness: 8 };
  const res = findStructure(pts, createEmptyPlan(), opts, free);

  it('finds the floor and the ceiling (joists) height', () => {
    expect(res.floorOffset).toBe(0);
    expect(res.ceiling).toBe(92);
  });

  it('finds the room direction itself', () => {
    const a = ((res.axis % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    expect(Math.min(a, Math.PI / 2 - a)).toBeLessThan(0.01);
  });

  it('finds 5 walls joined at exact corners and tees', () => {
    expect(res.walls).toHaveLength(5);
    for (const x of res.walls) {
      for (const p of [x.a, x.b]) {
        const onOther = res.walls.some((w) => {
          if (w === x) return false;
          const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
          const off = Math.abs(-(p.x - w.a.x) * (w.b.y - w.a.y) + (p.y - w.a.y) * (w.b.x - w.a.x)) / L;
          const t = ((p.x - w.a.x) * (w.b.x - w.a.x) + (p.y - w.a.y) * (w.b.y - w.a.y)) / L;
          return off < 0.01 && t > -0.01 && t < L + 0.01;
        });
        expect(onOther).toBe(true);
      }
    }
  });

  it('finds the duct as a low area and the post', () => {
    expect(res.soffits.some((s) => Math.abs(s.bottom - 80) <= 1)).toBe(true);
    expect(res.posts.some((p) => p.poly.every((q) => Math.abs(q.x - 122) < 10 && Math.abs(q.y - 122) < 10))).toBe(true);
  });

  it('gives a floor footprint covering the basement', () => {
    const f = res.footprint!;
    const cells = f.rows.reduce((n, [, i0, i1]) => n + i1 - i0 + 1, 0);
    const area = (cells * f.cell * f.cell) / 144;
    expect(area).toBeGreaterThan(560);
    expect(area).toBeLessThan(640);
  });

  it('works on a rotated basement', () => {
    const rot = rotateAll(pts, 0.3);
    const rfree = { count: (x: number, y: number, z: number) => {
      const c = Math.cos(-0.3);
      const s = Math.sin(-0.3);
      return free.count(x * c - y * s, x * s + y * c, z);
    } };
    const r2 = findStructure(rot, createEmptyPlan(), opts, rfree);
    const a = ((r2.axis % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    expect(Math.abs(a - 0.3)).toBeLessThan(0.01);
    expect(r2.walls).toHaveLength(5);
  });
});

describe('scanned walls in the plan', () => {
  it('connect into rooms you can name, with their doors and window', async () => {
    const { PlanStore } = await import('../src/core/store');
    const { applyScan } = await import('../src/core/scanApply');
    const { findRoomFaces } = await import('../src/core/rooms');
    const { map, free } = scanScene(basementScene());
    const store = new PlanStore(createEmptyPlan());
    const res = findStructure(map.points(2), store.plan, { eye: { x: 0, y: 0 }, axisAngle: null, partitionThickness: 4.5, foundationThickness: 8 }, free);
    store.edit('scan', (d) => applyScan(d, res));
    const faces = findRoomFaces(store.plan);
    expect(faces).toHaveLength(2);
    const areas = faces.map((f) => f.areaSqFt).sort((a, b) => a - b);
    expect(areas[0]).toBeGreaterThan(200); // 155" x 240" room minus walls
    expect(areas[1]).toBeGreaterThan(330);
    expect(store.plan.openings.filter((o) => o.type === 'door')).toHaveLength(1);
    expect(store.plan.openings.filter((o) => o.type === 'window')).toHaveLength(1);
    expect(store.plan.settings.wallHeight).toBe(92);
    expect(store.plan.footprint).toBeTruthy();
  });
});

describe('ceiling and post details', () => {
  it('finds exactly one post and one duct', () => {
    const { map, free } = scanScene(basementScene());
    const res = findStructure(map.points(2), createEmptyPlan(), { eye: { x: 0, y: 0 }, axisAngle: null, partitionThickness: 4.5, foundationThickness: 8 }, free);
    expect(res.posts).toHaveLength(1);
    expect(res.soffits).toHaveLength(1);
    const xs = res.soffits[0].poly.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(30);
    expect(Math.max(...xs)).toBeGreaterThan(170);
  });
});
