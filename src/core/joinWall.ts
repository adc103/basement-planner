import { dist, dot, intersectLines, norm, sub, type Vec2 } from './geom2d.js';
import type { Plan } from './plan.js';

export interface Joined {
  a: Vec2;
  b: Vec2;
  /** Corners of walls already in the plan to move so the walls meet. */
  moves: Array<{ node: string; to: Vec2 }>;
}

/**
 * A new wall's ends, joined to the walls already in the plan that they run into:
 * an end near a crossing wall goes to where the two centerlines meet. Mid-wall that
 * makes a T (the other wall is split there); at the other wall's end, that end moves
 * to the same point so the two make one corner.
 */
export function joinEnds(plan: Plan, a: Vec2, b: Vec2, thickness: number): Joined {
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  const moves: Joined['moves'] = [];
  const end = (e: Vec2, o: Vec2): Vec2 => {
    const L = dist(o, e);
    if (L < 1) return e;
    const v = norm(sub(e, o));
    let best: { p: Vec2; gap: number; move: { node: string; to: Vec2 } | null } | null = null;
    for (const w of plan.walls) {
      const na = nodes.get(w.a);
      const nb = nodes.get(w.b);
      if (!na || !nb) continue;
      const LW = Math.hypot(nb.x - na.x, nb.y - na.y);
      if (LW < 1) continue;
      const d = { x: (nb.x - na.x) / LW, y: (nb.y - na.y) / LW };
      if (Math.abs(v.x * d.y - v.y * d.x) < Math.SQRT1_2) continue; // not crossing (within 45 degrees of parallel)
      const p = intersectLines({ p: o, d: v }, { p: na, d });
      if (!p) continue;
      // Near this end along the new wall: within both half thicknesses and a bit.
      const gap = Math.abs(dot(sub(p, o), v) - L);
      if (gap > w.thickness / 2 + thickness / 2 + 6) continue;
      // On the other wall, or just past one of its ends.
      const t = dot(sub(p, na), d);
      const reach = thickness / 2 + 12;
      if (t < -reach || t > LW + reach) continue;
      let move: { node: string; to: Vec2 } | null = null;
      if (t <= 1) move = { node: na.id, to: p };
      else if (t >= LW - 1) move = { node: nb.id, to: p };
      if (!best || gap < best.gap) best = { p, gap, move };
    }
    if (!best) return e;
    if (best.move) moves.push(best.move);
    return best.p;
  };
  const ja = end(a, b);
  const jb = end(b, a);
  return { a: ja, b: jb, moves };
}
