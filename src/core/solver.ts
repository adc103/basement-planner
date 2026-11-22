import type { Constraint, Plan } from './plan.js';

/**
 * Geometric constraint solver for the plan (the FreeCAD-sketcher idea, sized
 * for a floor plan). Unknowns are the corner positions of walls that carry a
 * constraint; corners you just moved and corners of locked walls stay put.
 * Damped least squares (Levenberg-Marquardt) finds the smallest move of the
 * other corners that makes every constraint true.
 */

/** Plan-like object with mutable nodes (an Immer draft or a plain copy). */
interface Mutable {
  nodes: Array<{ id: string; x: number; y: number }>;
  walls: Plan['walls'];
  constraints: Constraint[];
}

export interface SolveResult {
  ok: boolean;
  /** Largest remaining error, inches. */
  worst: number;
  /** The constraint that couldn't be met. */
  worstId: string | null;
  iterations: number;
  /** Corners the solver moved. */
  moved: string[];
}

/** Inches; angles count as the error over a 100" wall. */
export const SOLVE_TOL = 0.01;
const R = 100;
const REG = 0.02;

export function solveConstraints(plan: Mutable, pinned: ReadonlySet<string> = new Set()): SolveResult {
  const cons = plan.constraints;
  const none: SolveResult = { ok: true, worst: 0, worstId: null, iterations: 0, moved: [] };
  if (!cons.length) return none;
  const wall = new Map(plan.walls.map((w) => [w.id, w]));
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  // Unknowns: corners of constrained walls that aren't pinned or locked.
  const fixed = new Set(pinned);
  for (const w of plan.walls) if (w.locked) fixed.add(w.a).add(w.b);
  const vars: string[] = [];
  const seen = new Set<string>();
  for (const c of cons) {
    for (const wid of [c.a, c.b]) {
      const w = wid ? wall.get(wid) : undefined;
      if (!w) continue;
      for (const n of [w.a, w.b]) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (!fixed.has(n) && node.has(n)) vars.push(n);
      }
    }
  }
  const idx = new Map(vars.map((n, i) => [n, i]));
  const x0 = new Float64Array(vars.length * 2);
  vars.forEach((n, i) => {
    const p = node.get(n)!;
    x0[i * 2] = p.x;
    x0[i * 2 + 1] = p.y;
  });
  const pos = (x: Float64Array, id: string) => {
    const i = idx.get(id);
    if (i !== undefined) return { x: x[i * 2], y: x[i * 2 + 1] };
    const p = node.get(id)!;
    return { x: p.x, y: p.y };
  };
  // Distance constraints keep the side wall b is on now.
  const side = new Map<string, number>();
  for (const c of cons) {
    if (c.type !== 'distance' || !c.b) continue;
    const A = wall.get(c.a);
    const B = wall.get(c.b);
    if (!A || !B) continue;
    const a0 = pos(x0, A.a);
    const a1 = pos(x0, A.b);
    const L = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
    const n = { x: -(a1.y - a0.y) / L, y: (a1.x - a0.x) / L };
    const b0 = pos(x0, B.a);
    const b1 = pos(x0, B.b);
    const s = ((b0.x + b1.x) / 2 - a0.x) * n.x + ((b0.y + b1.y) / 2 - a0.y) * n.y;
    side.set(c.id, s >= 0 ? 1 : -1);
  }
  // Constraint residuals, with the constraint each came from.
  const owner: string[] = [];
  const resid = (x: Float64Array, out: number[]) => {
    out.length = 0;
    owner.length = 0;
    for (const c of cons) {
      const A = wall.get(c.a);
      if (!A) continue;
      const a0 = pos(x, A.a);
      const a1 = pos(x, A.b);
      const La = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1e-9;
      const ua = { x: (a1.x - a0.x) / La, y: (a1.y - a0.y) / La };
      if (c.type === 'length') {
        out.push(La - (c.value ?? La));
        owner.push(c.id);
        continue;
      }
      const B = c.b ? wall.get(c.b) : undefined;
      if (!B) continue;
      const b0 = pos(x, B.a);
      const b1 = pos(x, B.b);
      const Lb = Math.hypot(b1.x - b0.x, b1.y - b0.y) || 1e-9;
      const ub = { x: (b1.x - b0.x) / Lb, y: (b1.y - b0.y) / Lb };
      if (c.type === 'parallel') {
        out.push((ua.x * ub.y - ua.y * ub.x) * R);
        owner.push(c.id);
      } else if (c.type === 'perpendicular') {
        out.push((ua.x * ub.x + ua.y * ub.y) * R);
        owner.push(c.id);
      } else {
        const na = { x: -ua.y, y: ua.x };
        const s0 = (b0.x - a0.x) * na.x + (b0.y - a0.y) * na.y;
        const s1 = (b1.x - a0.x) * na.x + (b1.y - a0.y) * na.y;
        let target = 0;
        if (c.type === 'distance') {
          const center = (c.value ?? 0) + (c.mode === 'clear' ? (A.thickness + B.thickness) / 2 : 0);
          target = (side.get(c.id) ?? 1) * center;
        }
        out.push(s0 - target, s1 - target);
        owner.push(c.id, c.id);
      }
    }
  };
  const r: number[] = [];
  const worstOf = (x: Float64Array) => {
    resid(x, r);
    let worst = 0;
    let worstId: string | null = null;
    r.forEach((v, i) => {
      if (Math.abs(v) > worst) [worst, worstId] = [Math.abs(v), owner[i]];
    });
    return { worst, worstId };
  };
  const n = x0.length;
  let x = Float64Array.from(x0);
  let w0 = worstOf(x);
  if (w0.worst <= SOLVE_TOL) return { ...none, worst: w0.worst };
  if (!n) return { ok: false, worst: w0.worst, worstId: w0.worstId, iterations: 0, moved: [] };

  // Cost: constraint errors plus a weak pull toward where corners started
  // (so the smallest change wins when there is more than one answer). A
  // second, much weaker pass then removes the small bias that pull leaves.
  let reg = REG;
  const anchor = Float64Array.from(x0);
  const full = (xv: Float64Array, out: number[]) => {
    resid(xv, out);
    for (let i = 0; i < n; i++) out.push(reg * (xv[i] - anchor[i]));
  };
  const cost = (v: number[]) => v.reduce((s, e) => s + e * e, 0);
  let fv: number[] = [];
  full(x, fv);
  let c0 = cost(fv);
  let lambda = 1e-3;
  let it = 0;
  const h = 1e-5;
  const xp = new Float64Array(n);
  for (; it < 200; it++) {
    const m = fv.length;
    // Jacobian by central differences.
    const J = new Float64Array(m * n);
    const fp: number[] = [];
    const fm: number[] = [];
    for (let j = 0; j < n; j++) {
      xp.set(x);
      xp[j] += h;
      full(xp, fp);
      xp[j] -= 2 * h;
      full(xp, fm);
      for (let i = 0; i < m; i++) J[i * n + j] = (fp[i] - fm[i]) / (2 * h);
    }
    // (J'J + lambda diag) dx = -J'f
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const fi = fv[i];
      for (let a = 0; a < n; a++) {
        const ja = J[i * n + a];
        if (!ja) continue;
        g[a] += ja * fi;
        for (let b = a; b < n; b++) A[a * n + b] += ja * J[i * n + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const M = Float64Array.from(A);
      for (let a = 0; a < n; a++) M[a * n + a] += lambda * (A[a * n + a] + 1e-9);
      const dx = solveLinear(M, g.map((v) => -v), n);
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = Float64Array.from(x);
      for (let a = 0; a < n; a++) xn[a] += dx[a];
      const fn: number[] = [];
      full(xn, fn);
      const cn = cost(fn);
      if (cn < c0) {
        x = xn;
        fv = fn;
        c0 = cn;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
      } else lambda *= 4;
    }
    w0 = worstOf(x);
    if (reg === REG && (w0.worst <= SOLVE_TOL * 2 || !improved)) {
      // Polish: anchor at the answer so far, barely any pull.
      reg = 1e-4;
      anchor.set(x);
      fv = [];
      full(x, fv);
      c0 = cost(fv);
      lambda = 1e-3;
      continue;
    }
    if (w0.worst <= SOLVE_TOL * 0.1 || !improved) break;
  }
  const ok = w0.worst <= SOLVE_TOL;
  const moved: string[] = [];
  if (ok) {
    vars.forEach((id, i) => {
      const p = node.get(id)!;
      if (Math.abs(p.x - x[i * 2]) > 1e-6 || Math.abs(p.y - x[i * 2 + 1]) > 1e-6) moved.push(id);
      p.x = x[i * 2];
      p.y = x[i * 2 + 1];
    });
  }
  return { ok, worst: w0.worst, worstId: w0.worstId, iterations: it, moved };
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(M: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const A = Float64Array.from(M);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [A[c * n + k], A[p * n + k]] = [A[p * n + k], A[c * n + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Clear (face-to-face) and center distance between two roughly parallel walls. */
export function wallGap(plan: Pick<Mutable, 'nodes' | 'walls'>, aId: string, bId: string): { center: number; clear: number; angle: number } | null {
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  const A = plan.walls.find((w) => w.id === aId);
  const B = plan.walls.find((w) => w.id === bId);
  if (!A || !B) return null;
  const a0 = node.get(A.a)!;
  const a1 = node.get(A.b)!;
  const b0 = node.get(B.a)!;
  const b1 = node.get(B.b)!;
  const La = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
  const Lb = Math.hypot(b1.x - b0.x, b1.y - b0.y) || 1;
  const ua = { x: (a1.x - a0.x) / La, y: (a1.y - a0.y) / La };
  const ub = { x: (b1.x - b0.x) / Lb, y: (b1.y - b0.y) / Lb };
  const angle = Math.acos(Math.min(1, Math.abs(ua.x * ub.x + ua.y * ub.y)));
  const na = { x: -ua.y, y: ua.x };
  const center = Math.abs(((b0.x + b1.x) / 2 - a0.x) * na.x + ((b0.y + b1.y) / 2 - a0.y) * na.y);
  return { center, clear: center - (A.thickness + B.thickness) / 2, angle };
}
