import type { DepthFrame } from '../src/core/scanIngest';
import { FreeGrid } from '../src/core/freeSpace';
import { ScanMap } from '../src/core/scanMap';

/** Axis-aligned box, plan inches (z = height). */
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

function hit(o: number[], d: number[], b: Box): number {
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < b.min[i] || o[i] > b.max[i]) return Infinity;
      continue;
    }
    let a = (b.min[i] - o[i]) / d[i];
    let c = (b.max[i] - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return Infinity;
  }
  return t0 > 1e-6 ? t0 : Infinity;
}

/**
 * A basement like a real one: 30' x 20', 92" to the joists, 8" foundation walls,
 * a stud partition at x = 200 with a 32" door and a 48" cased opening, a window
 * in the north wall, plus clutter: a 6' shelf, a jacket on a wall, a furnace,
 * a post and a duct.
 */
export function basementScene(): { boxes: Box[]; eyes: Array<[number, number]> } {
  const H = 92;
  const boxes: Box[] = [
    box(-20, -20, -6, 380, 260, 0), // floor slab
    box(-20, -20, H, 380, 260, H + 8), // joists / subfloor
    box(-8, -8, 0, 368, 0, H), // south foundation
    box(-8, 0, 0, 0, 240, H), // west
    box(360, 0, 0, 368, 240, H), // east
    // north foundation with a window 60..92 x, 62..80 z
    box(-8, 240, 0, 60, 248, H),
    box(92, 240, 0, 368, 248, H),
    box(60, 240, 0, 92, 248, 62),
    box(60, 240, 80, 92, 248, H),
    box(40, 270, -6, 110, 274, 110), // window well
    // partition x 200..204.5: door y 30..62 (header 80), opening y 150..198 (beam 84)
    box(200, 0, 0, 204.5, 30, H),
    box(200, 30, 80, 204.5, 62, H),
    box(200, 62, 0, 204.5, 150, H),
    box(200, 150, 84, 204.5, 198, H),
    box(200, 198, 0, 204.5, 240, H),
    // clutter
    box(250, 0.5, 0, 298, 16, 72), // shelf against the south wall
    box(0, 100, 30, 3, 124, 62), // jacket on the west wall
    box(280, 150, 0, 310, 180, 60), // furnace
    box(120, 120, 0, 124, 124, H), // post
    box(20, 170, 80, 190, 182, H), // duct
  ];
  const eyes: Array<[number, number]> = [
    [60, 60], [140, 50], [60, 190], [150, 200], [100, 120], [170, 120],
    [250, 60], [330, 90], [250, 210], [330, 210], [240, 130],
  ];
  return { boxes, eyes };
}

/** Scan the scene like the headset would: depth rays from each eye position. */
export function scanScene(scene: { boxes: Box[]; eyes: Array<[number, number]> }, maxRange = 177) {
  const map = new ScanMap(3, 1_200_000);
  const free = new FreeGrid(4);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
  for (const [ex, ey] of scene.eyes) {
    const o = [ex, ey, 64];
    for (let az = 0; az < 360; az += 2.5) {
      for (let el = -62; el <= 62; el += 3) {
        const a = (az * Math.PI) / 180;
        const e = (el * Math.PI) / 180;
        const d = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
        let t = Infinity;
        for (const b of scene.boxes) t = Math.min(t, hit(o, d, b));
        if (!(t < maxRange)) continue;
        const p = [o[0] + d[0] * t + noise(), o[1] + d[1] * t + noise(), o[2] + d[2] * t + noise()];
        // Each look is sampled a few times while walking.
        map.add(p[0], p[1], p[2]);
        map.add(p[0] + noise(), p[1] + noise(), p[2] + noise());
        free.carve(o[0], o[1], o[2], p[0], p[1], p[2]);
        free.carve(o[0], o[1], o[2], p[0], p[1], p[2]);
      }
    }
  }
  return { map, free };
}

/**
 * A virtual headset: depth frames (80x60, ~90 degree view) looking around from
 * each eye, built the way the real sampler builds them. Replaying them through
 * ingestFrame exercises the same path as a live scan.
 */
export function depthFramesFor(scene: { boxes: Box[]; eyes: Array<[number, number]> }, opts: { yawStep?: number; pitches?: number[] } = {}): DepthFrame[] {
  const W = 80;
  const H = 60;
  const IN = 0.0254;
  const P0 = 1 / Math.tan((90 * Math.PI) / 360);
  const P5 = 1 / Math.tan((72 * Math.PI) / 360);
  const proj = new Float32Array(16);
  proj[0] = P0;
  proj[5] = P5;
  proj[10] = -1;
  proj[11] = -1;
  proj[14] = -0.2;
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.01; // +-5 mm
  const frames: DepthFrame[] = [];
  let t = 0;
  for (const [ex, ey] of scene.eyes) {
    const eye = [ex * IN, 64 * IN, ey * IN]; // root meters: x, up, z
    for (const pitchDeg of opts.pitches ?? [-30, 0, 25]) {
      for (let yawDeg = 0; yawDeg < 360; yawDeg += opts.yawStep ?? 30) {
        const a = (yawDeg * Math.PI) / 180;
        const e = (pitchDeg * Math.PI) / 180;
        const f = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
        const rl = Math.hypot(f[2], f[0]);
        const r = [-f[2] / rl, 0, f[0] / rl];
        const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
        const M = new Float32Array([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, eye[0], eye[1], eye[2], 1]);
        const depthMM = new Uint16Array(W * H);
        const o = [ex, ey, 64];
        for (let j = 0; j < H; j++) {
          for (let i = 0; i < W; i++) {
            const vx = ((i + 0.5) / W * 2 - 1) / P0;
            const vy = ((j + 0.5) / H * 2 - 1) / P5;
            const dr = [r[0] * vx + u[0] * vy + f[0], r[1] * vx + u[1] * vy + f[1], r[2] * vx + u[2] * vy + f[2]];
            const vl = Math.hypot(vx, vy, 1);
            const dl = Math.hypot(dr[0], dr[1], dr[2]);
            const d = [dr[0] / dl, dr[2] / dl, dr[1] / dl]; // plan: x, y, height
            let hitT = Infinity;
            for (const b of scene.boxes) hitT = Math.min(hitT, hit(o, d, b));
            if (!(hitT < 1e5)) continue;
            const planar = (hitT * IN) / vl + noise();
            depthMM[j * W + i] = Math.max(0, Math.min(65535, Math.round(planar * 1000)));
          }
        }
        const back = [eye[0] - f[0] * 0.3, eye[1] - 0.5, eye[2] - f[2] * 0.3] as [number, number, number];
        frames.push({ t: (t += 0.25), w: W, h: H, depthMM, proj, viewToRoot: M, head: eye as [number, number, number], handL: back, handR: back });
      }
    }
  }
  return frames;
}
