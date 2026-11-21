import { describe, expect, it } from 'vitest';
import { ScanMap, unprojectDepth } from '../src/core/scanMap';
import { findStructure } from '../src/core/structure';
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
  for (let y = 0; y <= 120; y += 3) for (let z = 0; z <= H; z += 4) pts.push({ x: 200 + n(), y, z }, { x: 204.5 + n(), y, z });
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

describe('structure detection', () => {
  const res = findStructure(basement(), createEmptyPlan(), {
    eye: { x: 120, y: 100 },
    axisAngle: 0,
    partitionThickness: 4.5,
    foundationThickness: 8,
  });

  it('finds the floor and ceiling heights', () => {
    expect(res.floorOffset).toBe(0);
    expect(res.ceiling).toBe(96);
  });

  it('finds the four foundation walls and the partition', () => {
    const long = res.walls.filter((w) => Math.hypot(w.face.b.x - w.face.a.x, w.face.b.y - w.face.a.y) > 100);
    expect(long.length).toBeGreaterThanOrEqual(5);
    expect(long.filter((w) => w.foundation).length).toBeGreaterThanOrEqual(4);
    expect(res.walls).toHaveLength(5); // no duplicates
    const partition = res.walls.find((w) => Math.abs((w.face.a.x + w.face.b.x) / 2 - 200) < 8 && !w.foundation);
    expect(partition).toBeTruthy();
  });

  it('finds the duct as a soffit at 88"', () => {
    expect(res.soffits.length).toBeGreaterThanOrEqual(1);
    const s = res.soffits[0];
    expect(s.bottom).toBe(88);
    const xs = s.poly.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(48);
    expect(Math.max(...xs)).toBeGreaterThan(272);
  });

  it('keeps one wall behind clutter, and no posts from clutter', () => {
    const south = res.walls.filter((w) => Math.abs(w.face.a.y) < 6 && Math.abs(w.face.b.y) < 6);
    expect(south).toHaveLength(1);
    expect(Math.abs(south[0].face.b.x - south[0].face.a.x)).toBeGreaterThan(340);
    expect(res.posts).toHaveLength(1);
  });

  it('finds a rotated room without being told its direction', () => {
    const r2 = findStructure(rotateAll(basement(), 0.3), createEmptyPlan(), {
      eye: { x: 0, y: 0 },
      axisAngle: null,
      partitionThickness: 4.5,
      foundationThickness: 8,
    });
    const a = ((r2.axis % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    expect(Math.abs(a - 0.3)).toBeLessThan(0.01);
    expect(r2.walls.length).toBe(5);
  });

  it('finds the post', () => {
    expect(res.posts.some((p) => p.poly.every((q) => Math.abs(q.x - 302) < 10 && Math.abs(q.y - 122) < 10))).toBe(true);
  });
});
