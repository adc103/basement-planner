import { add, dist, rotate, scale, sub, type Vec2 } from './geom2d.js';
import { wallEnds } from './ops.js';
import type { Plan } from './plan.js';
import { convexHull } from './poly.js';
import type { DetectedFace, PP } from './wallDetect.js';

/**
 * Find basement structure in a scanned point cloud (plan inches, z = height):
 * walls, ceiling height, low areas under ducts/beams (soffits) and posts.
 *
 * Walls are found as long vertical planes that run most of the floor-to-ceiling
 * height, along the room's two main directions (basements are square). Things
 * hanging on or leaning against a wall (a jacket, shelves) don't cover enough
 * height to count, and the wall plane behind them is bridged over, so one wall
 * stays one wall.
 */

export interface WallProposal {
  face: DetectedFace;
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** Nothing seen behind it: probably an outside (foundation) wall. */
  foundation: boolean;
  /** 0..1: how much of the wall's height and length was seen. */
  confidence: number;
}

export interface SoffitProposal {
  poly: Vec2[];
  bottom: number;
}

export interface PostProposal {
  poly: Vec2[];
  height: number;
}

export interface StructureResult {
  floorOffset: number | null;
  ceiling: number | null;
  /** Main direction of the room, radians (plan space). */
  axis: number;
  walls: WallProposal[];
  soffits: SoffitProposal[];
  posts: PostProposal[];
}

export interface StructureOptions {
  eye: Vec2;
  /** Room direction to use; null = estimate from the points. */
  axisAngle: number | null;
  partitionThickness: number;
  foundationThickness: number;
}

/** Most populated 1" height bin in a range. */
function modeZ(points: PP[], lo: number, hi: number, minN = 20): number | null {
  const bins = new Map<number, number>();
  for (const p of points) {
    if (p.z < lo || p.z > hi) continue;
    const b = Math.round(p.z);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [b, n] of bins) {
    const s = n + (bins.get(b - 1) ?? 0) * 0.5 + (bins.get(b + 1) ?? 0) * 0.5;
    if (s > bestN) [best, bestN] = [b, s];
  }
  return bestN >= minN ? best : null;
}

function subsample<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a;
  const step = a.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(a[Math.floor(i * step)]);
  return out;
}

/** Room direction: the rotation where wall points pile up into the sharpest lines. */
export function estimateAxis(pts: Vec2[]): number {
  const sample = subsample(pts, 15000);
  const score = (ang: number) => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const h1 = new Map<number, number>();
    const h2 = new Map<number, number>();
    for (const p of sample) {
      const u = Math.round((p.x * c + p.y * s) / 2);
      const v = Math.round((-p.x * s + p.y * c) / 2);
      h1.set(u, (h1.get(u) ?? 0) + 1);
      h2.set(v, (h2.get(v) ?? 0) + 1);
    }
    let sc = 0;
    for (const n of h1.values()) sc += n * n;
    for (const n of h2.values()) sc += n * n;
    return sc;
  };
  let best = 0;
  let bestS = -1;
  for (let d = 0; d < 90; d += 1) {
    const s = score((d * Math.PI) / 180);
    if (s > bestS) [best, bestS] = [d, s];
  }
  let fine = best;
  for (let d = best - 1; d <= best + 1; d += 0.1) {
    const s = score((d * Math.PI) / 180);
    if (s > bestS) [fine, bestS] = [d, s];
  }
  return (fine * Math.PI) / 180;
}

interface Face {
  /** Offset along the normal direction (plan inches). */
  c: number;
  t0: number;
  t1: number;
  /** Seen fraction (length x height). */
  coverage: number;
  /** Which way the room is: +1 / -1 along the normal. */
  roomSide: number;
  dirIdx: 0 | 1;
}

export function findStructure(points: PP[], plan: Plan, opts: StructureOptions): StructureResult {
  const floor = modeZ(points, -18, 18);
  const ceiling = modeZ(points, 66, 180, 40);
  const z0 = floor ?? 0;
  const H = ceiling ?? z0 + plan.settings.wallHeight;

  const band = points.filter((p) => p.z > z0 + 10 && p.z < H - 10);
  const axis = opts.axisAngle ?? estimateAxis(band);
  const dirs: Vec2[] = [
    { x: Math.cos(axis), y: Math.sin(axis) },
    { x: -Math.sin(axis), y: Math.cos(axis) },
  ];

  // Height levels (6") the wall should cover between floor and ceiling.
  const ZS = 6;
  const levels = Math.max(1, Math.floor((H - z0 - 20) / ZS));
  const TS = 6; // along-wall cell
  const faces: Face[] = [];

  for (const dirIdx of [0, 1] as const) {
    const d = dirs[dirIdx]; // along the wall
    const n = { x: -d.y, y: d.x }; // wall normal
    const hist = new Map<number, number>();
    for (const p of band) {
      const c = Math.round(p.x * n.x + p.y * n.y);
      hist.set(c, (hist.get(c) ?? 0) + 1);
    }
    const peaks = [...hist.keys()]
      .map((c) => ({ c, s: (hist.get(c - 1) ?? 0) + (hist.get(c) ?? 0) + (hist.get(c + 1) ?? 0) }))
      .filter((p) => p.s >= 60)
      .sort((a, b) => b.s - a.s);
    const taken: number[] = [];
    for (const pk of peaks) {
      if (taken.some((c) => Math.abs(c - pk.c) < 3)) continue;
      taken.push(pk.c);
      const near = band.filter((p) => Math.abs(p.x * n.x + p.y * n.y - pk.c) <= 2);
      if (near.length < 60) continue;
      const cMean = near.reduce((s, p) => s + p.x * n.x + p.y * n.y, 0) / near.length;
      // Along-wall cells: which height levels were seen.
      const cells = new Map<number, Set<number>>();
      for (const p of near) {
        const t = Math.floor((p.x * d.x + p.y * d.y) / TS);
        const lv = Math.floor((p.z - z0 - 10) / ZS);
        let set = cells.get(t);
        if (!set) cells.set(t, (set = new Set()));
        set.add(lv);
      }
      // A cell is wall when it spans much of the height; clutter doesn't.
      const solid = [...cells.entries()].filter(([, s]) => s.size >= levels * 0.6).map(([t]) => t).sort((a, b) => a - b);
      if (solid.length < 4) continue;
      // Join runs, bridging gaps up to 4 ft (something in front, or a doorway to add later).
      let runStart = solid[0];
      let prev = solid[0];
      const runs: Array<[number, number]> = [];
      for (const t of solid.slice(1)) {
        if ((t - prev - 1) * TS > 48) {
          runs.push([runStart, prev]);
          runStart = t;
        }
        prev = t;
      }
      runs.push([runStart, prev]);
      for (const [r0, r1] of runs) {
        const len = (r1 - r0 + 1) * TS;
        if (len < 30) continue;
        let seen = 0;
        for (let t = r0; t <= r1; t++) seen += Math.min(levels, cells.get(t)?.size ?? 0);
        const coverage = seen / ((r1 - r0 + 1) * levels);
        if (coverage < 0.5) continue; // mostly clutter
        // Room side: where most other points are (floor, clutter, other walls).
        let plus = 0;
        let minus = 0;
        for (const p of points) {
          const t = (p.x * d.x + p.y * d.y) / TS;
          if (t < r0 || t > r1 + 1) continue;
          const off = p.x * n.x + p.y * n.y - cMean;
          if (off > 6 && off < 60) plus++;
          else if (off < -6 && off > -60) minus++;
        }
        faces.push({ c: cMean, t0: r0 * TS, t1: (r1 + 1) * TS, coverage, roomSide: plus >= minus ? 1 : -1, dirIdx });
      }
    }
  }

  // Inside a wall nothing is visible: few points strictly between two faces.
  const hollowBetween = (f: Face, g: Face) => {
    const d = dirs[f.dirIdx];
    const n = { x: -d.y, y: d.x };
    const lo = Math.min(f.c, g.c) + 1;
    const hi = Math.max(f.c, g.c) - 1;
    const t0 = Math.max(f.t0, g.t0);
    const t1 = Math.min(f.t1, g.t1);
    let inside = 0;
    for (const p of band) {
      const c = p.x * n.x + p.y * n.y;
      if (c <= lo || c >= hi) continue;
      const t = p.x * d.x + p.y * d.y;
      if (t > t0 && t < t1) inside++;
    }
    return inside < 0.05 * ((t1 - t0) / TS) * levels * 4;
  };

  // Pair the two faces of a thin wall (3-9" apart, nothing between them).
  const used = new Set<Face>();
  const walls: WallProposal[] = [];
  const known: Array<{ a: Vec2; b: Vec2 }> = plan.walls.map((w) => wallEnds(plan, w));
  faces.sort((a, b) => (b.t1 - b.t0) * b.coverage - (a.t1 - a.t0) * a.coverage);
  for (const f of faces) {
    if (used.has(f)) continue;
    used.add(f);
    const d = dirs[f.dirIdx];
    const n = { x: -d.y, y: d.x };
    const mate = faces.find(
      (g) =>
        !used.has(g) &&
        g.dirIdx === f.dirIdx &&
        Math.abs(g.c - f.c) >= 3 &&
        Math.abs(g.c - f.c) <= 9 &&
        Math.min(g.t1, f.t1) - Math.max(g.t0, f.t0) > 0.5 * Math.min(g.t1 - g.t0, f.t1 - f.t0) &&
        hollowBetween(f, g),
    );
    let center: number;
    let thickness: number;
    let t0 = f.t0;
    let t1 = f.t1;
    let foundation = false;
    if (mate) {
      used.add(mate);
      center = (f.c + mate.c) / 2;
      thickness = Math.round(Math.abs(f.c - mate.c) * 2) / 2;
      t0 = Math.min(t0, mate.t0);
      t1 = Math.max(t1, mate.t1);
    } else {
      // One-sided: foundation wall if nothing at all was seen behind it.
      let behind = 0;
      for (const p of band) {
        const t = p.x * d.x + p.y * d.y;
        if (t < t0 || t > t1) continue;
        const off = (p.x * n.x + p.y * n.y - f.c) * f.roomSide;
        if (off < -10) behind++;
      }
      foundation = behind < 15;
      thickness = foundation ? opts.foundationThickness : opts.partitionThickness;
      center = f.c - (f.roomSide * thickness) / 2;
    }
    const at = (c: number, t: number): Vec2 => add(scale(n, c), scale(d, t));
    const a = at(center, t0);
    const b = at(center, t1);
    // Skip walls the plan already has (or that were just found).
    const mid = scale(add(a, b), 0.5);
    const dup = [...known, ...walls.map((w) => ({ a: w.a, b: w.b }))].some((s) => {
      const len = dist(s.a, s.b);
      if (len < 1) return false;
      const sd = { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len };
      if (Math.abs(sd.x * d.y - sd.y * d.x) > 0.17) return false; // not parallel (>10 deg)
      const off = Math.abs(-(mid.x - s.a.x) * sd.y + (mid.y - s.a.y) * sd.x);
      const t = (mid.x - s.a.x) * sd.x + (mid.y - s.a.y) * sd.y;
      return off < 8 && t > -12 && t < len + 12;
    });
    if (dup) continue;
    walls.push({
      face: { a: at(f.c, t0), b: at(f.c, t1), n: scale(n, f.roomSide), rms: 0, support: Math.round(f.coverage * 100) },
      a,
      b,
      thickness,
      foundation,
      confidence: f.coverage,
    });
  }
  // Clean corners: extend or trim ends to meet perpendicular walls within 18".
  for (const w of walls) {
    for (const end of ['a', 'b'] as const) {
      const p = w[end];
      const other = end === 'a' ? w.b : w.a;
      const L = dist(p, other);
      const dir = { x: (p.x - other.x) / L, y: (p.y - other.y) / L };
      let bestT = Infinity;
      for (const v of walls) {
        if (v === w) continue;
        const vd = sub(v.b, v.a);
        const vl = Math.hypot(vd.x, vd.y);
        const vn = { x: vd.x / vl, y: vd.y / vl };
        const den = dir.x * vn.y - dir.y * vn.x;
        if (Math.abs(den) < 0.9) continue; // only near-perpendicular
        const t = ((v.a.x - p.x) * vn.y - (v.a.y - p.y) * vn.x) / den;
        const s = ((v.a.x - p.x) * dir.y - (v.a.y - p.y) * dir.x) / den;
        if (Math.abs(t) <= 18 && s > -18 && s < vl + 18 && Math.abs(t) < Math.abs(bestT)) bestT = t;
      }
      if (bestT !== Infinity) w[end] = add(p, scale(dir, bestT));
    }
  }

  // --- Low ceiling areas and posts (6" grid in the room's axis frame) ------------
  const cell = 6;
  const toLocal = (p: Vec2) => rotate(p, -axis);
  const toPlan = (p: Vec2) => rotate(p, axis);
  const segs = [...walls.map((w) => ({ a: w.a, b: w.b })), ...known];
  const nearWall = (p: Vec2, r = 12) =>
    segs.some((s) => {
      const len = dist(s.a, s.b);
      if (len < 1) return false;
      const t = ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)) / len;
      const off = Math.abs(-(p.x - s.a.x) * (s.b.y - s.a.y) + (p.y - s.a.y) * (s.b.x - s.a.x)) / len;
      return t > -r && t < len + r && off < r;
    });
  const grid = new Map<string, { i: number; j: number; low: number[]; lv: Set<number>; n: number }>();
  for (const p of points) {
    if (p.z < z0 + 4) continue;
    const l = toLocal(p);
    const i = Math.floor(l.x / cell);
    const j = Math.floor(l.y / cell);
    const k = `${i},${j}`;
    let g = grid.get(k);
    if (!g) grid.set(k, (g = { i, j, low: [], lv: new Set(), n: 0 }));
    g.n++;
    g.lv.add(Math.floor((p.z - z0) / ZS));
    if (p.z > H - 36 && p.z < H - 3) g.low.push(p.z);
  }
  const center = (g: { i: number; j: number }) => toPlan({ x: (g.i + 0.5) * cell, y: (g.j + 0.5) * cell });

  // Soffits: connected cells with a flat surface hanging 3"-36" below the ceiling.
  const flatLow = (g: { low: number[] }) => {
    if (g.low.length < 4) return false;
    const m = g.low.reduce((s, z) => s + z, 0) / g.low.length;
    const sd = Math.sqrt(g.low.reduce((s, z) => s + (z - m) ** 2, 0) / g.low.length);
    return sd < 3;
  };
  const lowCells = new Set([...grid.entries()].filter(([, g]) => flatLow(g) && !nearWall(center(g))).map(([k]) => k));
  const soffits: SoffitProposal[] = [];
  const visited = new Set<string>();
  for (const k of lowCells) {
    if (visited.has(k)) continue;
    const stack = [k];
    const blob: string[] = [];
    visited.add(k);
    while (stack.length) {
      const cur = stack.pop()!;
      blob.push(cur);
      const [i, j] = cur.split(',').map(Number);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${i + di},${j + dj}`;
        if (lowCells.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          stack.push(nk);
        }
      }
    }
    if (blob.length < 6) continue; // under 1.5 sq ft: a light or pipe, not a soffit
    const cs = blob.map((b) => grid.get(b)!);
    const i0 = Math.min(...cs.map((c) => c.i));
    const i1 = Math.max(...cs.map((c) => c.i)) + 1;
    const j0 = Math.min(...cs.map((c) => c.j));
    const j1 = Math.max(...cs.map((c) => c.j)) + 1;
    // Mostly-filled boxes only (ducts and beams are straight).
    if (blob.length < 0.5 * (i1 - i0) * (j1 - j0)) continue;
    const lows = cs.flatMap((c) => c.low).sort((a, b) => a - b);
    soffits.push({
      poly: [
        { x: i0 * cell, y: j0 * cell },
        { x: i1 * cell, y: j0 * cell },
        { x: i1 * cell, y: j1 * cell },
        { x: i0 * cell, y: j1 * cell },
      ].map(toPlan),
      bottom: Math.round(lows[Math.floor(lows.length * 0.1)] - z0),
    });
  }

  // Posts: thin columns seen over nearly the whole floor-to-ceiling height.
  const fullLevels = Math.floor((H - z0) / ZS);
  const tall = new Set(
    [...grid.entries()]
      .filter(([, g]) => g.n >= 30 && g.lv.size >= fullLevels * 0.8 && !nearWall(center(g), 18))
      .map(([k]) => k),
  );
  const posts: PostProposal[] = [];
  const seenPost = new Set<string>();
  for (const k of tall) {
    if (seenPost.has(k)) continue;
    const [i, j] = k.split(',').map(Number);
    const blob = [k];
    seenPost.add(k);
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1]]) {
      const nk = `${i + di},${j + dj}`;
      if (tall.has(nk) && !seenPost.has(nk)) {
        seenPost.add(nk);
        blob.push(nk);
      }
    }
    if (blob.length > 4) continue; // bigger than ~1 ft: not a post
    const pts = blob.flatMap((b) => {
      const [bi, bj] = b.split(',').map(Number);
      return [
        { x: bi * cell, y: bj * cell },
        { x: (bi + 1) * cell, y: bj * cell },
        { x: (bi + 1) * cell, y: (bj + 1) * cell },
        { x: bi * cell, y: (bj + 1) * cell },
      ].map(toPlan);
    });
    posts.push({ poly: convexHull(pts), height: Math.round(H - z0) });
  }

  return { floorOffset: floor, ceiling, axis, walls, soffits, posts };
}

/** Helper for tests and previews: a rectangle around a center, axis-aligned in plan space. */
export function rectAround(c: Vec2, w: number, h: number): Vec2[] {
  const half = { x: w / 2, y: h / 2 };
  return [sub(c, half), add(c, { x: half.x, y: -half.y }), add(c, half), add(c, { x: -half.x, y: half.y })];
}
