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

describe('mesh coloring from photos', () => {
  it('paints what a photo sees with that photo\'s colors, where it sees it', { timeout: 60_000 }, () => {
    const scene = basementScene();
    const frames = depthFramesFor(scene);
    const vol = new TsdfVolume();
    for (const f of frames) vol.integrate(f);
    vol.meshDirty();
    // A photo from one depth view: left half red, right half blue.
    const f = frames[Math.floor(frames.length / 2)];
    const w = 160;
    const h = 120;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(x < w / 2 ? [220, 20, 20, 255] : [20, 20, 220, 255], (y * w + x) * 4);
    const cam = { camToRoot: f.viewToRoot, fx: (f.proj[0] * w) / 2, fy: (f.proj[5] * h) / 2, cx: (w / 2) * (1 - f.proj[8]), cy: (h / 2) * (1 + f.proj[9]) };
    expect(vol.colorize({ rgba, w, h, ...cam })).toBeGreaterThan(10);
    const meshes = vol.meshDirty();
    let right = 0;
    let wrong = 0;
    const M = f.viewToRoot;
    for (const m of meshes) {
      if (!m.colors.length) continue;
      for (let v = 0; v < m.positions.length / 3; v++) {
        const r = m.colors[v * 3];
        const b = m.colors[v * 3 + 2];
        if (r === b) continue; // not reached by the photo
        const px = m.positions[v * 3] - M[12], py = m.positions[v * 3 + 1] - M[13], pz = m.positions[v * 3 + 2] - M[14];
        const z = -(M[8] * px + M[9] * py + M[10] * pz);
        const u = cam.cx + (cam.fx * (M[0] * px + M[1] * py + M[2] * pz)) / z;
        if (Math.abs(u - w / 2) < 8) continue; // the seam
        if (u < w / 2 === r > b) right++;
        else wrong++;
      }
    }
    expect(right).toBeGreaterThan(200);
    expect(wrong / (right + wrong)).toBeLessThan(0.03);
  });
});

describe('photos kept as textures', () => {
  it('keeps a photo where it is the best view, not a repeat, and not one that disagrees', { timeout: 60_000 }, () => {
    const scene = basementScene();
    const frames = depthFramesFor(scene);
    const vol = new TsdfVolume();
    for (const f of frames) vol.integrate(f);
    vol.meshDirty();
    const w = 160;
    const h = 120;
    const shot = (f: (typeof frames)[number], color: [number, number, number]) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set([...color, 255], i * 4);
      return { rgba, w, h, camToRoot: f.viewToRoot, fx: (f.proj[0] * w) / 2, fy: (f.proj[5] * h) / 2, cx: w / 2, cy: h / 2 };
    };
    const f = frames[Math.floor(frames.length / 2)];
    vol.colorize(shot(f, [180, 160, 140]), 4.5, true);
    expect(vol.lastSlot).toBe(0);
    const meshes = vol.meshDirty();
    const textured = meshes.reduce((n, m) => n + m.photos.filter((p) => p === 0).length, 0);
    expect(textured).toBeGreaterThan(100);
    // The same view again adds nothing better: not kept.
    vol.colorize(shot(f, [180, 160, 140]), 4.5, true);
    expect(vol.lastSlot).toBeNull();
    // From a neighbouring view, a photo whose colors disagree with what was seen there
    // (looking at something else) isn't used.
    const g = frames[Math.floor(frames.length / 2) + 1];
    vol.colorize(shot(g, [180, 160, 140]), 4.5, true);
    vol.colorize(shot(g, [20, 200, 30]), 4.5, true);
    expect(vol.lastSlot).toBeNull();
  });
});

describe('saved colors', () => {
  it('keeps photo colors through save and load', () => {
    const vol = new TsdfVolume();
    for (const f of depthFramesFor(basementScene()).slice(0, 40)) vol.integrate(f);
    vol.meshDirty();
    const f = depthFramesFor(basementScene())[20];
    const rgba = new Uint8Array(160 * 120 * 4).fill(200);
    vol.colorize({ rgba, w: 160, h: 120, camToRoot: f.viewToRoot, fx: (f.proj[0] * 160) / 2, fy: (f.proj[5] * 120) / 2, cx: 80, cy: 60 });
    const colored = (v: TsdfVolume) => v.meshAll().reduce((n, m) => n + m.colors.length, 0);
    const before = colored(vol);
    const back = new TsdfVolume();
    expect(back.load(vol.serialize())).toBe(true);
    expect(before).toBeGreaterThan(0);
    expect(colored(back)).toBe(before);
  });
});

describe('scan coverage', () => {
  it('counts the sides a wall was photographed from, per mesh vertex', async () => {
    const { TsdfVolume, COVERED_SIDES } = await import('../src/core/tsdf');
    const vol = new TsdfVolume();
    // A wall at z = -2 (facing +z), seen by a fake depth camera from in front.
    const w = 64, h = 48;
    const depthMM = new Uint16Array(w * h).fill(2000);
    const proj = [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
    const eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1];
    for (let i = 0; i < 4; i++) vol.integrate({ t: i, w, h, depthMM, proj, viewToRoot: Float32Array.from(eye), head: [0, 1.2, 0], handL: [0, 0, 0], handR: [0, 0, 0] } as never);
    const cam = (x: number, yaw: number) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      return { w: 640, h: 480, fx: 400, fy: 400, cx: 320, cy: 240, camToRoot: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.2, 0, 1] };
    };
    const views = () => Math.max(0, ...vol.meshAll().flatMap((m) => [...m.views]));
    expect(views()).toBe(0);
    vol.markSeen(cam(0, 0));
    expect(views()).toBe(1);
    vol.markSeen(cam(0.05, 0)); // same side again: almost nowhere gains a side
    const all = vol.meshAll().flatMap((m) => [...m.views]);
    expect(all.filter((v) => v >= 2).length / all.length).toBeLessThan(0.1);
    vol.markSeen(cam(-1.5, -0.6));
    vol.markSeen(cam(1.5, 0.6));
    expect(views()).toBeGreaterThanOrEqual(COVERED_SIDES);
  });
});
