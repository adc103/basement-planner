import { add, angleOf, intersectLines, norm, perp, scale, sub, polygonArea, type Vec2 } from './geom2d.js';
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
  return faces;
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
