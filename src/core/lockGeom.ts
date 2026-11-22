import type { Vec2 } from './geom2d.js';
import type { Constraint, Plan } from './plan.js';
import { formatLength } from './units.js';

/** Where to draw a lock: a dimension line (distance) or a tag point (others). */
export interface LockMark {
  id: string;
  type: Constraint['type'];
  /** For distance: the two ends of the dimension line, plan inches. */
  line: [Vec2, Vec2] | null;
  /** Where the label goes. */
  at: Vec2;
  text: string;
}

export function lockMarks(plan: Pick<Plan, 'nodes' | 'walls' | 'constraints'>): LockMark[] {
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  const W = (id: string | null) => {
    const w = id ? plan.walls.find((x) => x.id === id) : undefined;
    if (!w) return null;
    const a = node.get(w.a);
    const b = node.get(w.b);
    if (!a || !b) return null;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    return { w, a, b, L, d, n: { x: -d.y, y: d.x }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const out: LockMark[] = [];
  for (const c of plan.constraints) {
    const A = W(c.a);
    if (!A) continue;
    if (c.type === 'length') continue; // shown on the wall's own length label
    const B = W(c.b);
    if (!B) continue;
    if (c.type === 'distance') {
      // Middle of where the walls overlap, measured along A.
      const t0 = (B.a.x - A.a.x) * A.d.x + (B.a.y - A.a.y) * A.d.y;
      const t1 = (B.b.x - A.a.x) * A.d.x + (B.b.y - A.a.y) * A.d.y;
      const lo = Math.max(0, Math.min(t0, t1));
      const hi = Math.min(A.L, Math.max(t0, t1));
      const t = lo < hi ? (lo + hi) / 2 : A.L / 2;
      const base = { x: A.a.x + A.d.x * t, y: A.a.y + A.d.y * t };
      const s = (B.mid.x - A.a.x) * A.n.x + (B.mid.y - A.a.y) * A.n.y;
      const sg = s >= 0 ? 1 : -1;
      const inset = c.mode === 'clear' ? [A.w.thickness / 2, Math.abs(s) - B.w.thickness / 2] : [0, Math.abs(s)];
      const p0 = { x: base.x + A.n.x * sg * inset[0], y: base.y + A.n.y * sg * inset[0] };
      const p1 = { x: base.x + A.n.x * sg * inset[1], y: base.y + A.n.y * sg * inset[1] };
      out.push({ id: c.id, type: c.type, line: [p0, p1], at: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, text: `${formatLength(c.value ?? 0)}${c.mode === 'clear' ? ' clear' : ''}, kept` });
    } else {
      // Tag at a shared corner if there is one, else between the walls.
      const shared = [A.w.a, A.w.b].find((n) => n === B.w.a || n === B.w.b);
      const at = shared ? node.get(shared)! : { x: (A.mid.x + B.mid.x) / 2, y: (A.mid.y + B.mid.y) / 2 };
      out.push({ id: c.id, type: c.type, line: null, at: { x: at.x, y: at.y }, text: c.type === 'perpendicular' ? 'square' : c.type === 'parallel' ? 'parallel' : 'in line' });
    }
  }
  return out;
}
