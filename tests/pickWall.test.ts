import { beforeAll, describe, expect, it } from 'vitest';
import { fitWall, SurfaceIndex, surfaceFromMeshes } from '../src/core/fit';
import { pickSetupWall, pickWall, roomAxis, type PickedWall, type Ray3 } from '../src/core/pickWall';
import { TsdfVolume } from '../src/core/tsdf';
import { basementScene, depthFramesFor } from './synthScan';

const aim = (o: [number, number, number], t: [number, number, number]): Ray3 => {
  const d = { x: t[0] - o[0], y: t[1] - o[1], z: t[2] - o[2] };
  const L = Math.hypot(d.x, d.y, d.z);
  return { o: { x: o[0], y: o[1], z: o[2] }, d: { x: d.x / L, y: d.y / L, z: d.z / L } };
};

describe('point at a real wall', () => {
  let idx: SurfaceIndex;
  beforeAll(() => {
    const vol = new TsdfVolume();
    for (const f of depthFramesFor(basementScene())) vol.integrate(f);
    idx = new SurfaceIndex(surfaceFromMeshes(vol.meshAll()));
  }, 120_000);

  const wall = (r: ReturnType<typeof pickWall>): PickedWall => {
    expect('wall' in r, JSON.stringify(r)).toBe(true);
    return (r as { wall: PickedWall }).wall;
  };

  it('finds the room square from the mesh', () => {
    const ax = roomAxis(idx)!;
    expect(Math.abs(Math.sin(2 * ax))).toBeLessThan(0.02);
  });

  it('fits the face you point at and follows it corner to corner, across a door and an opening', () => {
    // The partition's west face is x = 200; it runs y 0..240 with a door and a wide opening.
    const w = wall(pickWall(idx, aim([100, 120, 60], [200, 100, 50])));
    expect(Math.abs(w.a.x - 200)).toBeLessThan(0.75);
    expect(Math.abs(w.b.x - 200)).toBeLessThan(0.75);
    expect(w.n.x).toBeLessThan(-0.99); // facing you (west)
    const ys = [w.a.y, w.b.y].sort((p, q) => p - q);
    expect(ys[0]).toBeLessThan(6);
    expect(ys[1]).toBeGreaterThan(234);
    expect(w.ends).toEqual(['corner', 'corner']);
  });

  it('stops at the inside corners of a foundation wall', () => {
    // South wall face y = 0, from the west wall (x = 0) to the partition (x = 200).
    const w = wall(pickWall(idx, aim([60, 60, 60], [80, -10, 40])));
    expect(Math.abs(w.a.y)).toBeLessThan(0.75);
    const xs = [w.a.x, w.b.x].sort((p, q) => p - q);
    expect(xs[0]).toBeLessThan(6);
    expect(Math.abs(xs[1] - 200)).toBeLessThan(6);
  });

  it('measures the wall behind the face: both faces give the thickness', () => {
    const w = wall(pickWall(idx, aim([100, 120, 60], [200, 100, 50])));
    const h = 2.25;
    const f = fitWall(idx, { a: { x: w.a.x - w.n.x * h, y: w.a.y }, b: { x: w.b.x - w.n.x * h, y: w.b.y }, thickness: 4.5, z0: 0, z1: 92, openings: [] });
    expect(Math.abs(f.thickness - 4.5)).toBeLessThan(0.75);
    expect(Math.abs((f.a.x + f.b.x) / 2 - 202.25)).toBeLessThan(0.5);
  });

  it('says so when you point at the floor or at nothing', () => {
    expect(pickWall(idx, aim([100, 120, 60], [110, 125, 0]))).toEqual({ miss: 'not-a-wall' });
    expect(pickWall(idx, aim([100, 120, 60], [100, 120, 200]))).not.toHaveProperty('wall');
  });
});

describe('Space Setup wall under the ray', () => {
  it('takes the wall plane you point at, facing you, corner to corner', () => {
    const planes = [
      { label: 'wall', polygon: [[0, 100, 0], [200, 100, 0], [200, 100, 96], [0, 100, 96]] },
      { label: 'wall', polygon: [[0, 300, 0], [200, 300, 0], [200, 300, 96], [0, 300, 96]] },
      { label: 'floor', polygon: [[0, 0, 0], [200, 0, 0], [200, 300, 0]] },
    ];
    const w = pickSetupWall(planes, aim([100, 200, 60], [100, 350, 50]))!;
    expect(w.a.y).toBe(300);
    expect(w.n.y).toBeLessThan(-0.99);
    expect(w.ends).toEqual(['corner', 'corner']);
    expect(pickSetupWall(planes, aim([100, 200, 60], [100, 50, 50]))!.a.y).toBe(100);
    expect(pickSetupWall(planes, aim([100, 200, 60], [400, 200, 50]))).toBeNull();
  });
});
