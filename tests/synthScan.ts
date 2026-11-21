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
