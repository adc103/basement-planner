import {
  add,
  angleOf,
  dist,
  intersectLines,
  norm,
  perp,
  scale,
  sub,
  type Line,
  type Vec2,
} from './geom2d.js';
import { wallEnds } from './ops.js';
import type { Opening, Plan, Wall } from './plan.js';

/** Quad footprint corners (plan space, inches) for one wall after joins. */
export interface WallFootprint {
  wallId: string;
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  normal: Vec2; // left of a->b
  length: number;
  half: number;
  leftA: Vec2;
  leftB: Vec2;
  rightB: Vec2;
  rightA: Vec2;
  /** Node center, included in the end cap when 2+ walls meet there (fills T-junction gaps). */
  hubA?: Vec2;
  hubB?: Vec2;
}

/** One solid block of wall: a quad footprint extruded from z0 to z1 (inches). */
export interface WallPrism {
  wallId: string;
  /** Footprint polygon (plan space). */
  poly: Vec2[];
  z0: number;
  z1: number;
}

interface Incident {
  wall: Wall;
  /** Outgoing unit direction away from the node. */
  u: Vec2;
  half: number;
  angle: number;
  atA: boolean;
}

/** Miters longer than this multiple of the thicker half are squared off. */
const MITER_LIMIT = 4;

/**
 * Compute mitered footprints for every wall. Walls meeting at a node are
 * joined cleanly (L corners, T junctions, crosses), the free ends are square.
 */
export function computeFootprints(plan: Plan): Map<string, WallFootprint> {
  const byNode = new Map<string, Incident[]>();
  const fps = new Map<string, WallFootprint>();

  for (const w of plan.walls) {
    const { a, b } = wallEnds(plan, w);
    const length = dist(a, b);
    if (length < 1e-6) continue;
    const dir = norm(sub(b, a));
    const normal = perp(dir);
    const half = w.thickness / 2;
    fps.set(w.id, {
      wallId: w.id,
      a,
      b,
      dir,
      normal,
      length,
      half,
      leftA: add(a, scale(normal, half)),
      rightA: sub(a, scale(normal, half)),
      leftB: add(b, scale(normal, half)),
      rightB: sub(b, scale(normal, half)),
    });
    const push = (nodeId: string, inc: Incident) => {
      const list = byNode.get(nodeId) ?? [];
      list.push(inc);
      byNode.set(nodeId, list);
    };
    push(w.a, { wall: w, u: dir, half, angle: angleOf(dir), atA: true });
    const back = scale(dir, -1);
    push(w.b, { wall: w, u: back, half, angle: angleOf(back), atA: false });
  }

  for (const [nodeId, list] of byNode) {
    if (list.length < 2) continue;
    const node = plan.nodes.find((n) => n.id === nodeId)!;
    const N = { x: node.x, y: node.y };
    list.sort((p, q) => p.angle - q.angle);
    const k = list.length;
    for (let i = 0; i < k; i++) {
      const cur = list[i];
      const next = list[(i + 1) % k];
      const prev = list[(i - 1 + k) % k];
      const curPerp = perp(cur.u);
      const leftLine: Line = { p: add(N, scale(curPerp, cur.half)), d: cur.u };
      const rightLine: Line = { p: sub(N, scale(curPerp, cur.half)), d: cur.u };
      const nextRight: Line = { p: sub(N, scale(perp(next.u), next.half)), d: next.u };
      const prevLeft: Line = { p: add(N, scale(perp(prev.u), prev.half)), d: prev.u };
      const limit = MITER_LIMIT * Math.max(cur.half, next.half, prev.half);
      const lc = miter(leftLine, nextRight, N, limit);
      const rc = miter(rightLine, prevLeft, N, limit);
      const fp = fps.get(cur.wall.id);
      if (!fp) continue;
      // Outgoing-left at node a is the wall's left side; at node b it is the wall's right side.
      if (cur.atA) {
        if (lc) fp.leftA = lc;
        if (rc) fp.rightA = rc;
        fp.hubA = N;
      } else {
        if (lc) fp.rightB = lc;
        if (rc) fp.leftB = rc;
        fp.hubB = N;
      }
    }
  }
  return fps;
}

function miter(l1: Line, l2: Line, node: Vec2, limit: number): Vec2 | null {
  const p = intersectLines(l1, l2);
  if (!p) return null; // collinear: the square end already matches
  if (dist(p, node) > limit) return null;
  return p;
}

/** Point on the left/right face at distance s along the wall (s in [0, length]). */
function faceAt(fp: WallFootprint, side: 'left' | 'right', s: number): Vec2 {
  if (s <= 1e-6) return side === 'left' ? fp.leftA : fp.rightA;
  if (s >= fp.length - 1e-6) return side === 'left' ? fp.leftB : fp.rightB;
  const c = add(fp.a, scale(fp.dir, s));
  return side === 'left' ? add(c, scale(fp.normal, fp.half)) : sub(c, scale(fp.normal, fp.half));
}

/**
 * Footprint polygon of the wall between s0 and s1, counter-clockwise when the
 * wall's left side is +normal. End caps at joined nodes include the hub point.
 */
export function footprintPoly(fp: WallFootprint, s0 = 0, s1 = fp.length): Vec2[] {
  const atStart = s0 <= 1e-6;
  const atEnd = s1 >= fp.length - 1e-6;
  const pts: Vec2[] = [];
  // Walk: right(s0) -> right(s1) -> [hubB] -> left(s1) -> left(s0) -> [hubA]
  pts.push(faceAt(fp, 'right', s0), faceAt(fp, 'right', s1));
  if (atEnd && fp.hubB) pts.push(fp.hubB);
  pts.push(faceAt(fp, 'left', s1), faceAt(fp, 'left', s0));
  if (atStart && fp.hubA) pts.push(fp.hubA);
  return dedupe(pts);
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 1e-7) out.push(p);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < 1e-7) out.pop();
  return out;
}

/** Split a wall into solid prisms around its openings. */
export function wallPrisms(fp: WallFootprint, wall: Wall, openings: Opening[]): WallPrism[] {
  const H = wall.height;
  const ops = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => ({
      s0: Math.max(0, o.offset - o.width / 2),
      s1: Math.min(fp.length, o.offset + o.width / 2),
      bottom: Math.max(0, o.sill),
      top: Math.min(H, o.sill + o.height),
    }))
    .filter((o) => o.s1 > o.s0)
    .sort((p, q) => p.s0 - q.s0);

  const prisms: WallPrism[] = [];
  const block = (s0: number, s1: number, z0: number, z1: number) => {
    if (s1 - s0 < 1e-4 || z1 - z0 < 1e-4) return;
    prisms.push({ wallId: wall.id, poly: footprintPoly(fp, s0, s1), z0, z1 });
  };

  let cursor = 0;
  for (const o of ops) {
    const start = Math.max(cursor, o.s0);
    block(cursor, start, 0, H);
    block(start, o.s1, o.top, H); // header
    block(start, o.s1, 0, o.bottom); // below a window
    cursor = Math.max(cursor, o.s1);
  }
  block(cursor, fp.length, 0, H);
  return prisms;
}

/** Total floor area enclosed by a closed polygon, sq ft. */
export function sqft(areaSqIn: number): number {
  return Math.abs(areaSqIn) / 144;
}
