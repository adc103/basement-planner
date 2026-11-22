import { describe, expect, it } from 'vitest';
import { TsdfVolume } from '../src/core/tsdf';
import { basementScene, depthFramesFor, type Box } from './synthScan';

const IN = 0.0254;

/** Distance (meters) from a root-space point to the nearest box surface. */
function distToBoxes(boxes: Box[], x: number, y: number, z: number): number {
  // root (x, up, z) meters -> plan (x, y, height) inches
  const p = [x / IN, z / IN, y / IN];
  let best = Infinity;
  for (const b of boxes) {
    let out = 0;
    let inside = Infinity;
    for (let i = 0; i < 3; i++) {
      const d = Math.max(b.min[i] - p[i], 0, p[i] - b.max[i]);
      out += d * d;
      inside = Math.min(inside, p[i] - b.min[i], b.max[i] - p[i]);
    }
    best = Math.min(best, out > 0 ? Math.sqrt(out) : Math.max(0, inside));
  }
  return best * IN;
}

describe('depth fusion (TSDF) and mesh', () => {
  const scene = basementScene();
  const frames = depthFramesFor(scene);
  const vol = new TsdfVolume();
  let t0 = performance.now();
  for (const f of frames) vol.integrate(f);
  const integrateMs = (performance.now() - t0) / frames.length;
  t0 = performance.now();
  const meshes = vol.meshDirty();
  const meshMs = performance.now() - t0;
  const verts: number[] = [];
  let tris = 0;
  for (const m of meshes) {
    verts.push(...m.positions);
    tris += m.indices.length / 3;
  }

  it('is fast enough to run live (an 80x60 frame in a few ms)', () => {
    expect(integrateMs).toBeLessThan(40);
    expect(meshMs).toBeLessThan(5000);
  });

  it('builds a mesh of the room', () => {
    expect(vol.brickCount).toBeGreaterThan(500);
    expect(tris).toBeGreaterThan(20_000);
    let bad = 0;
    for (const m of meshes) for (const i of m.indices) if (i >= m.positions.length / 3) bad++;
    expect(bad).toBe(0);
    console.log(`tsdf: ${frames.length} frames, ${integrateMs.toFixed(1)} ms/frame, ${vol.brickCount} bricks, ${tris} triangles, mesh ${meshMs.toFixed(0)} ms`);
  });

  it('puts the surface within about a centimeter of the real one', () => {
    const d: number[] = [];
    for (let i = 0; i < verts.length; i += 3 * 7) d.push(distToBoxes(scene.boxes, verts[i], verts[i + 1], verts[i + 2]));
    d.sort((a, b) => a - b);
    const median = d[Math.floor(d.length / 2)];
    const p90 = d[Math.floor(d.length * 0.9)];
    expect(median).toBeLessThan(0.012);
    expect(p90).toBeLessThan(0.03);
  });

  it('sees the partition and leaves the doorway open', () => {
    // Vertices on the partition face (x = 200") inside the door (y 30..62", below 80").
    const near = (x: number) => Math.abs(x / IN - 200) < 1.5;
    let face = 0;
    let inDoor = 0;
    for (let i = 0; i < verts.length; i += 3) {
      const px = verts[i] / IN;
      const py = verts[i + 2] / IN;
      const pz = verts[i + 1] / IN;
      if (!near(px * IN) || pz < 4 || pz > 76) continue;
      if (py > 70 && py < 140) face++;
      if (py > 36 && py < 56) inDoor++;
    }
    expect(face).toBeGreaterThan(200);
    expect(inDoor).toBeLessThan(face / 20);
  });

  it('saves and loads', () => {
    const v2 = new TsdfVolume();
    expect(v2.load(vol.serialize())).toBe(true);
    expect(v2.brickCount).toBe(vol.brickCount);
    const a = vol.meshAll().reduce((n, m) => n + m.indices.length, 0);
    const b = v2.meshAll().reduce((n, m) => n + m.indices.length, 0);
    expect(b).toBe(a);
  });

  it('ignores a different voxel size', () => {
    expect(new TsdfVolume({ voxel: 0.05 }).load(vol.serialize())).toBe(false);
  });
});
