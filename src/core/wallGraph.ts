import { dist, type Vec2 } from './geom2d.js';

/**
 * Join found walls into a clean wall graph, the way you'd draw them: ends
 * meet exactly at corners (L), butt exactly onto the wall they run into (T),
 * and collinear pieces with a tiny gap become one wall. Fixed segments (walls
 * already in the plan) are joined to but never moved.
 *
 * Exact meeting points matter: the plan splits a wall where another one ends
 * on it, which is what lets rooms close.
 */
export interface Seg {
  a: Vec2;
  b: Vec2;
}

const REACH = 30; // inches an end may move to meet another wall

function lineHit(p: Vec2, dir: Vec2, s: Seg): { t: number; u: number; len: number } | null {
  const sx = s.b.x - s.a.x;
  const sy = s.b.y - s.a.y;
  const len = Math.hypot(sx, sy);
  if (len < 1e-6) return null;
  const den = dir.x * sy - dir.y * sx;
  if (Math.abs(den) < 1e-9) return null;
  // p + dir * t = s.a + (s.b - s.a) * u
  const t = ((s.a.x - p.x) * sy - (s.a.y - p.y) * sx) / den;
  const u = ((s.a.x - p.x) * dir.y - (s.a.y - p.y) * dir.x) / den;
  return { t, u, len };
}

export function connectWalls(walls: Seg[], fixed: Seg[] = [], fixedNodes: Vec2[] = []): void {
  // 1. Merge collinear neighbours (same line, small gap or overlap).
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const A = walls[i];
      const B = walls[j];
      const la = dist(A.a, A.b);
      const lb = dist(B.a, B.b);
      if (la < 1 || lb < 1) continue;
      const da = { x: (A.b.x - A.a.x) / la, y: (A.b.y - A.a.y) / la };
      const db = { x: (B.b.x - B.a.x) / lb, y: (B.b.y - B.a.y) / lb };
      if (Math.abs(da.x * db.y - da.y * db.x) > 0.03) continue;
      const off = (p: Vec2) => Math.abs(-(p.x - A.a.x) * da.y + (p.y - A.a.y) * da.x);
      if (off(B.a) > 2 || off(B.b) > 2) continue;
      const t = (p: Vec2) => (p.x - A.a.x) * da.x + (p.y - A.a.y) * da.y;
      const ts = [0, la, t(B.a), t(B.b)];
      const [b0, b1] = [Math.min(ts[2], ts[3]), Math.max(ts[2], ts[3])];
      if (b0 > la + 8 || b1 < -8) continue; // more than 8" apart: separate walls
      const lo = Math.min(...ts);
      const hi = Math.max(...ts);
      const a0 = { ...A.a };
      A.a = { x: a0.x + da.x * lo, y: a0.y + da.y * lo };
      A.b = { x: a0.x + da.x * hi, y: a0.y + da.y * hi };
      walls.splice(j, 1);
      j--;
    }
  }

  // 2. Snap ends: to existing corners first, then onto other walls' lines.
  const all = (): Seg[] => [...walls, ...fixed];
  for (let pass = 0; pass < 2; pass++) {
    for (const w of walls) {
      for (const end of ['a', 'b'] as const) {
        const p = w[end];
        const q = end === 'a' ? w.b : w.a;
        const L = dist(p, q);
        if (L < 1) continue;
        const dir = { x: (p.x - q.x) / L, y: (p.y - q.y) / L };
        // An existing corner close by wins.
        const node = fixedNodes.find((n) => dist(n, p) <= 12);
        if (node) {
          w[end] = { ...node };
          continue;
        }
        let best: { t: number; pt: Vec2 } | null = null;
        for (const s of all()) {
          if (s === w) continue;
          const h = lineHit(p, dir, s);
          if (!h) continue;
          const sDir = { x: (s.b.x - s.a.x) / h.len, y: (s.b.y - s.a.y) / h.len };
          if (Math.abs(dir.x * sDir.y - dir.y * sDir.x) < 0.5) continue; // nearly parallel
          // The meeting point must be near this end, and on (or near the end of) the other wall.
          if (Math.abs(h.t) > REACH) continue;
          if (h.u * h.len < -REACH || h.u * h.len > h.len + REACH) continue;
          if (-h.t > L * 0.5) continue; // never trim away most of the wall
          if (!best || Math.abs(h.t) < Math.abs(best.t)) best = { t: h.t, pt: { x: p.x + dir.x * h.t, y: p.y + dir.y * h.t } };
        }
        if (best) w[end] = best.pt;
      }
    }
  }
}
