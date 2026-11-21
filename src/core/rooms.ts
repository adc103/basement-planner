import { add, angleOf, distToSegment, intersectLines, norm, perp, scale, sub, polygonArea, type Vec2 } from './geom2d.js';
import { centroid, pointInPolygon } from './poly.js';
import type { Plan, Room } from './plan.js';

export interface RoomFace {
  /** Stable key: sorted node ids. */
  key: string;
  nodeIds: string[];
  /** Polygon through wall centerlines (CCW). */
  outline: Vec2[];
  /** Clear floor polygon, inside the wall faces. */
  inner: Vec2[];
  /** Clear floor area, square feet. */
  areaSqFt: number;
  /** Label position. */
  center: Vec2;
}

/**
 * Find every closed area bounded by walls (planar faces of the wall graph).
 * Dead-end walls are ignored; the unbounded outside face is dropped.
 */
export function findRoomFaces(plan: Plan): RoomFace[] {
  const pos = new Map(plan.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const half = new Map<string, number>(); // "u|v" -> half thickness of that wall
  const adj = new Map<string, Set<string>>();
  for (const w of plan.walls) {
    if (w.a === w.b) continue;
    (adj.get(w.a) ?? adj.set(w.a, new Set()).get(w.a)!).add(w.b);
    (adj.get(w.b) ?? adj.set(w.b, new Set()).get(w.b)!).add(w.a);
    half.set(`${w.a}|${w.b}`, w.thickness / 2);
    half.set(`${w.b}|${w.a}`, w.thickness / 2);
  }
  // Prune dangling walls (they can't bound a room).
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [n, set] of adj) {
      if (set.size < 2) {
        for (const m of set) adj.get(m)?.delete(n);
        adj.delete(n);
        pruned = true;
      }
    }
  }
  // Outgoing edges sorted by angle.
  const sorted = new Map<string, string[]>();
  for (const [n, set] of adj) {
    const p = pos.get(n)!;
    sorted.set(
      n,
      [...set].sort((a, b) => angleOf(sub(pos.get(a)!, p)) - angleOf(sub(pos.get(b)!, p))),
    );
  }
  const used = new Set<string>();
  const faces: RoomFace[] = [];
  for (const [u, outs] of sorted) {
    for (const v0 of outs) {
      if (used.has(`${u}|${v0}`)) continue;
      const loop: string[] = [];
      let a = u;
      let b = v0;
      let guard = 0;
      while (!used.has(`${a}|${b}`) && guard++ < 10000) {
        used.add(`${a}|${b}`);
        loop.push(a);
        const list = sorted.get(b)!;
        const i = list.indexOf(a);
        const next = list[(i - 1 + list.length) % list.length];
        a = b;
        b = next;
      }
      if (loop.length < 3) continue;
      const outline = loop.map((id) => pos.get(id)!);
      if (polygonArea(outline) <= 1) continue; // outer face (clockwise) or degenerate
      const inner = insetPolygon(outline, loop.map((id, i) => half.get(`${id}|${loop[(i + 1) % loop.length]}`) ?? 0));
      faces.push({
        key: [...loop].sort().join(','),
        nodeIds: loop,
        outline,
        inner,
        areaSqFt: Math.abs(polygonArea(inner)) / 144,
        center: centroid(inner),
      });
    }
  }
  // Areas that surround other rooms (e.g. the open basement around a bedroom):
  // subtract the rooms inside and move the label into open floor.
  for (const f of faces) {
    const inside = faces.filter((g) => g !== f && g.outline.every((p) => pointInPolygon(p, f.outline)));
    if (!inside.length) continue;
    const top = inside.filter((g) => !inside.some((h) => h !== g && g.outline.every((p) => pointInPolygon(p, h.outline))));
    let area = Math.abs(polygonArea(f.inner));
    for (const g of top) {
      const grown = insetPolygon(g.outline, g.nodeIds.map((id, i) => -(half.get(`${id}|${g.nodeIds[(i + 1) % g.nodeIds.length]}`) ?? 0)));
      area -= Math.abs(polygonArea(grown));
    }
    f.areaSqFt = Math.max(0, area) / 144;
    f.center = openSpot(f.inner, top.map((g) => g.outline));
  }
  return faces;
}

/** A point inside `poly`, outside every hole, as far as possible from all edges (grid search). */
export function openSpot(poly: Vec2[], holes: Vec2[][]): Vec2 {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const edges: Array<[Vec2, Vec2]> = [];
  for (const ring of [poly, ...holes]) for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  let best = centroid(poly);
  let bestD = -1;
  const N = 24;
  for (let i = 1; i < N; i++)
    for (let j = 1; j < N; j++) {
      const p = { x: x0 + (w * i) / N, y: y0 + (h * j) / N };
      if (!pointInPolygon(p, poly) || holes.some((hole) => pointInPolygon(p, hole))) continue;
      let d = Infinity;
      for (const [a, b] of edges) d = Math.min(d, distToSegment(p, a, b));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  return best;
}

/** Offset each edge of a CCW polygon inward by its own distance. */
export function insetPolygon(poly: Vec2[], dists: number[]): Vec2[] {
  const n = poly.length;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const d = norm(sub(q, p));
    return { p: add(p, scale(perp(d), dists[i])), d };
  });
  return poly.map((p, i) => {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    return intersectLines(prev, cur) ?? add(p, scale(perp(cur.d), dists[i]));
  });
}

/** The face containing a point, if any. Smallest wins when faces nest. */
export function faceAt(faces: RoomFace[], p: Vec2): RoomFace | undefined {
  return faces
    .filter((f) => pointInPolygon(p, f.outline))
    .sort((a, b) => Math.abs(polygonArea(a.outline)) - Math.abs(polygonArea(b.outline)))[0];
}

/** Pair each named room with its current face (null if its walls no longer close). */
export function resolveRooms(plan: Plan, faces = findRoomFaces(plan)): Array<{ room: Room; face: RoomFace | null }> {
  return plan.rooms.map((room) => ({ room, face: faceAt(faces, room.seed) ?? null }));
}
