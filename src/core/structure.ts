import { add, dist, rotate, scale, sub, type Vec2 } from './geom2d.js';
import { wallEnds } from './ops.js';
import type { Plan } from './plan.js';
import { convexHull } from './poly.js';
import { centerlineFromFace, detectWallFromMesh, type DetectedFace, type PP } from './wallDetect.js';

/**
 * Find basement structure in a scanned point cloud (plan inches, z = height):
 * walls, ceiling height, low areas under ducts/beams (soffits) and posts.
 */

export interface WallProposal {
  face: DetectedFace;
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** Few points behind it: probably an outside (foundation) wall. */
  foundation: boolean;
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
  walls: WallProposal[];
  soffits: SoffitProposal[];
  posts: PostProposal[];
}

export interface StructureOptions {
  eye: Vec2;
  axisAngle: number;
  partitionThickness: number;
  foundationThickness: number;
}

/** Most populated 1" height bin in a range. */
function modeZ(points: PP[], lo: number, hi: number): number | null {
  const bins = new Map<number, number>();
  for (const p of points) {
    if (p.z < lo || p.z > hi) continue;
    const b = Math.round(p.z);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [b, n] of bins) if (n > bestN) [best, bestN] = [b, n];
  return bestN >= 20 ? best : null;
}

export function findStructure(points: PP[], plan: Plan, opts: StructureOptions): StructureResult {
  const floor = modeZ(points, -18, 18);
  // Ceiling: the strongest horizontal layer well above head height.
  const ceiling = modeZ(points, 66, 180);
  const H = ceiling ?? plan.settings.wallHeight;

  // --- Walls -------------------------------------------------------------------
  const wallBand = points.filter((p) => p.z > 18 && p.z < H - 12);
  const known: Array<{ a: Vec2; b: Vec2 }> = plan.walls.map((w) => wallEnds(plan, w));
  const found: DetectedFace[] = [];
  const explained = (p: Vec2) =>
    [...found.map((f) => ({ a: f.a, b: f.b })), ...known].some((s) => {
      const len = dist(s.a, s.b);
      if (len < 1) return false;
      const dx = (s.b.x - s.a.x) / len;
      const dy = (s.b.y - s.a.y) / len;
      const t = (p.x - s.a.x) * dx + (p.y - s.a.y) * dy;
      const off = Math.abs(-(p.x - s.a.x) * dy + (p.y - s.a.y) * dx);
      return t > -6 && t < len + 6 && off < 9;
    });
  // Seeds: a coarse sample of the wall band.
  const seeds: PP[] = [];
  const seen = new Set<string>();
  for (const p of wallBand) {
    const k = `${Math.round(p.x / 24)},${Math.round(p.y / 24)}`;
    if (!seen.has(k)) {
      seen.add(k);
      seeds.push(p);
    }
  }
  for (const s of seeds) {
    if (found.length >= 40) break;
    if (explained(s)) continue;
    const f = detectWallFromMesh(points, s, opts.eye, { ceiling: H, maxGap: 14 });
    if (!f || dist(f.a, f.b) < 24 || f.support < 25) continue;
    found.push(f);
  }
  // Drop duplicates: a face lying along a longer one (same line, overlapping).
  const unique = found
    .sort((p, q) => dist(q.a, q.b) - dist(p.a, p.b))
    .filter((f, i, arr) =>
      !arr.slice(0, i).some((g) => {
        const len = dist(g.a, g.b);
        const dx = (g.b.x - g.a.x) / len;
        const dy = (g.b.y - g.a.y) / len;
        const off = (p: Vec2) => Math.abs(-(p.x - g.a.x) * dy + (p.y - g.a.y) * dx);
        const t = (p: Vec2) => (p.x - g.a.x) * dx + (p.y - g.a.y) * dy;
        const mid = scale(add(f.a, f.b), 0.5);
        return off(f.a) < 4 && off(f.b) < 4 && t(mid) > -6 && t(mid) < len + 6;
      }),
    );
  const walls: WallProposal[] = unique.map((f) => {
    // Foundation if almost nothing was seen on the far side.
    const behind = wallBand.filter((p) => {
      const along = (p.x - f.a.x) * (f.b.x - f.a.x) + (p.y - f.a.y) * (f.b.y - f.a.y);
      const len2 = dist(f.a, f.b) ** 2;
      const off = (p.x - f.a.x) * f.n.x + (p.y - f.a.y) * f.n.y;
      return along > 0 && along < len2 && off < -12;
    }).length;
    const foundation = behind < 10;
    const thickness = foundation ? opts.foundationThickness : opts.partitionThickness;
    const c = centerlineFromFace(f, thickness);
    return { face: f, a: c.a, b: c.b, thickness, foundation };
  });

  // --- Low ceiling areas and posts (6" grid in the room's axis frame) ------------
  const cell = 6;
  const toLocal = (p: Vec2) => rotate(p, -opts.axisAngle);
  const toPlan = (p: Vec2) => rotate(p, opts.axisAngle);
  const nearWall = (p: Vec2) =>
    [...walls.map((w) => ({ a: w.face.a, b: w.face.b })), ...known].some((s) => {
      const len = dist(s.a, s.b);
      if (len < 1) return false;
      const t = ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)) / len;
      const off = Math.abs(-(p.x - s.a.x) * (s.b.y - s.a.y) + (p.y - s.a.y) * (s.b.x - s.a.x)) / len;
      return t > -9 && t < len + 9 && off < 12;
    });
  const grid = new Map<string, { i: number; j: number; low: number[]; zMin: number; zMax: number; n: number }>();
  for (const p of points) {
    if (p.z < 4) continue;
    const l = toLocal(p);
    const i = Math.floor(l.x / cell);
    const j = Math.floor(l.y / cell);
    const k = `${i},${j}`;
    let g = grid.get(k);
    if (!g) {
      g = { i, j, low: [], zMin: Infinity, zMax: -Infinity, n: 0 };
      grid.set(k, g);
    }
    g.n++;
    g.zMin = Math.min(g.zMin, p.z);
    g.zMax = Math.max(g.zMax, p.z);
    if (p.z > H - 36 && p.z < H - 3) g.low.push(p.z);
  }
  const center = (g: { i: number; j: number }) => toPlan({ x: (g.i + 0.5) * cell, y: (g.j + 0.5) * cell });

  // Soffits: connected cells with a surface hanging 3"-36" below the ceiling.
  const lowCells = new Set([...grid.entries()].filter(([, g]) => g.low.length >= 3 && !nearWall(center(g))).map(([k]) => k));
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
    if (blob.length < 4) continue; // under 1 sq ft
    const cs = blob.map((b) => grid.get(b)!);
    const i0 = Math.min(...cs.map((c) => c.i));
    const i1 = Math.max(...cs.map((c) => c.i)) + 1;
    const j0 = Math.min(...cs.map((c) => c.j));
    const j1 = Math.max(...cs.map((c) => c.j)) + 1;
    const lows = cs.flatMap((c) => c.low).sort((a, b) => a - b);
    const bottom = Math.round(lows[Math.floor(lows.length * 0.1)]);
    soffits.push({
      poly: [
        { x: i0 * cell, y: j0 * cell },
        { x: i1 * cell, y: j0 * cell },
        { x: i1 * cell, y: j1 * cell },
        { x: i0 * cell, y: j1 * cell },
      ].map(toPlan),
      bottom,
    });
  }

  // Posts: small columns of points running from near the floor to near the ceiling.
  const tall = new Set(
    [...grid.entries()].filter(([, g]) => g.zMin < 24 && g.zMax > H - 24 && g.n >= 12 && !nearWall(center(g))).map(([k]) => k),
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
    if (blob.length > 6) continue; // bigger than ~1 ft: furniture/clutter, not a post
    const pts = blob.flatMap((b) => {
      const [bi, bj] = b.split(',').map(Number);
      return [
        { x: bi * cell, y: bj * cell },
        { x: (bi + 1) * cell, y: bj * cell },
        { x: (bi + 1) * cell, y: (bj + 1) * cell },
        { x: bi * cell, y: (bj + 1) * cell },
      ].map(toPlan);
    });
    posts.push({ poly: convexHull(pts), height: Math.round(H) });
  }

  return { floorOffset: floor, ceiling, walls, soffits, posts };
}

/** Helper for tests and previews: a rectangle around a center, axis-aligned in plan space. */
export function rectAround(c: Vec2, w: number, h: number): Vec2[] {
  const half = { x: w / 2, y: h / 2 };
  return [sub(c, half), add(c, { x: half.x, y: -half.y }), add(c, half), add(c, scale({ x: -half.x, y: half.y }, 1))];
}
