import { add, dist, rotate, scale, sub, type Vec2 } from './geom2d.js';
import { wallEnds } from './ops.js';
import type { Plan } from './plan.js';
import { convexHull } from './poly.js';
import type { DetectedFace, PP } from './wallDetect.js';
import { findWalls, type FoundOpening, type FreeLookup } from './wallFinder.js';
import { connectWalls } from './wallGraph.js';
import { footprintFromFloor, type Footprint } from './footprint.js';

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
  /** Doorways found in it: center point (plan), width and height, inches. */
  openings: OpeningProposal[];
}

export type OpeningProposal = FoundOpening;

const NO_FREE: FreeLookup = { count: () => 0 };

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
  /** Scanned floor area (for whole-basement floor and ceiling). */
  footprint: Footprint | null;
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

export function findStructure(points: PP[], plan: Plan, opts: StructureOptions, free: FreeLookup = NO_FREE): StructureResult {
  const floor = modeZ(points, -18, 18);
  const ceiling = modeZ(points, 66, 180, 40);
  const z0 = floor ?? 0;
  const H = ceiling ?? z0 + plan.settings.wallHeight;
  const ZS = 6;

  const band = points.filter((p) => p.z > z0 + 10 && p.z < H - 10);
  const axis = opts.axisAngle ?? estimateAxis(band);

  // --- Walls ---------------------------------------------------------------------
  const known: Array<{ a: Vec2; b: Vec2 }> = plan.walls.map((w) => wallEnds(plan, w));
  const found = findWalls(points, free, {
    z0,
    H,
    axis,
    partitionThickness: opts.partitionThickness,
    foundationThickness: opts.foundationThickness,
  });
  // Skip walls the plan already has.
  const fresh = found.filter((f) => {
    const mid = scale(add(f.a, f.b), 0.5);
    const fl = dist(f.a, f.b);
    const fd = { x: (f.b.x - f.a.x) / fl, y: (f.b.y - f.a.y) / fl };
    return !known.some((s) => {
      const len = dist(s.a, s.b);
      if (len < 1) return false;
      const sd = { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len };
      if (Math.abs(sd.x * fd.y - sd.y * fd.x) > 0.17) return false;
      const off = Math.abs(-(mid.x - s.a.x) * sd.y + (mid.y - s.a.y) * sd.x);
      const t = (mid.x - s.a.x) * sd.x + (mid.y - s.a.y) * sd.y;
      return off < 8 && t > -12 && t < len + 12;
    });
  });
  connectWalls(fresh, known, plan.nodes.map((n) => ({ x: n.x, y: n.y })));
  const walls: WallProposal[] = fresh.map((f) => ({
    face: { a: f.faceA, b: f.faceB, n: f.n, rms: 0, support: Math.round(f.confidence * 100) },
    a: f.a,
    b: f.b,
    thickness: f.thickness,
    foundation: f.foundation,
    confidence: f.confidence,
    openings: f.openings,
  }));

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
    // Height levels for post detection: below the ceiling only (ceiling points are everywhere).
    if (p.z < H - 4) g.lv.add(Math.floor((p.z - z0) / ZS));
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

  // Join pieces of one duct/beam split by an unseen stretch: same height, in line, close.
  for (let i = 0; i < soffits.length; i++) {
    for (let j = i + 1; j < soffits.length; j++) {
      const A = soffits[i];
      const B = soffits[j];
      if (Math.abs(A.bottom - B.bottom) > 1) continue;
      const box = (s2: SoffitProposal) => {
        const ls = s2.poly.map(toLocal);
        return { x0: Math.min(...ls.map((q) => q.x)), x1: Math.max(...ls.map((q) => q.x)), y0: Math.min(...ls.map((q) => q.y)), y1: Math.max(...ls.map((q) => q.y)) };
      };
      const a = box(A);
      const b = box(B);
      const sameY = Math.abs(a.y0 - b.y0) <= 6 && Math.abs(a.y1 - b.y1) <= 6;
      const sameX = Math.abs(a.x0 - b.x0) <= 6 && Math.abs(a.x1 - b.x1) <= 6;
      const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
      if (!((sameY && gapX <= 48) || (sameX && gapY <= 48))) continue;
      const u = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };
      A.poly = [
        { x: u.x0, y: u.y0 },
        { x: u.x1, y: u.y0 },
        { x: u.x1, y: u.y1 },
        { x: u.x0, y: u.y1 },
      ].map(toPlan);
      A.bottom = Math.min(A.bottom, B.bottom);
      soffits.splice(j, 1);
      j = i;
    }
  }

  // Posts: thin columns seen over nearly the whole floor-to-ceiling height.
  const fullLevels = Math.floor((H - 4 - z0) / ZS);
  const topLevel = Math.floor((H - 12 - z0) / ZS);
  const tall = new Set(
    [...grid.entries()]
      .filter(([, g]) => {
        if (g.n < 30 || g.lv.size < fullLevels * 0.85 || nearWall(center(g), 20)) return false;
        // must reach up to the ceiling: shelves and appliances stop short
        for (let lv = topLevel; lv < fullLevels; lv++) if (!g.lv.has(lv)) return false;
        return true;
      })
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

  const floorPts = points.filter((p) => Math.abs(p.z - z0) < 3);
  const footprint = footprintFromFloor(floorPts, axis);
  return { floorOffset: floor, ceiling, axis, walls, soffits, posts, footprint };
}

/** Helper for tests and previews: a rectangle around a center, axis-aligned in plan space. */
export function rectAround(c: Vec2, w: number, h: number): Vec2[] {
  const half = { x: w / 2, y: h / 2 };
  return [sub(c, half), add(c, { x: half.x, y: -half.y }), add(c, half), add(c, { x: -half.x, y: half.y })];
}
