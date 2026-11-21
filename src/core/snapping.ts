import {
  add,
  dist,
  fromAngle,
  intersectLines,
  norm,
  perp,
  projectOnLine,
  projectOnSegment,
  rotate,
  scale,
  sub,
  type Line,
  type Vec2,
} from './geom2d.js';
import { wallEnds } from './ops.js';
import type { Plan } from './plan.js';

/**
 * SketchUp-style inference snapping in plan space (inches).
 *
 * Priority: endpoints > midpoints > guide intersections > on-wall points >
 * single guide lines > grid. Every snap reports the guide lines that produced
 * it so the XR layer can draw them.
 */

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'intersection'
  | 'edge'
  | 'angle'
  | 'extension'
  | 'perpendicular'
  | 'follow'
  | 'grid'
  | 'free';

export interface GuideLine {
  line: Line;
  kind: 'angle' | 'extension' | 'perpendicular' | 'follow';
  /** Where the guide originates (for drawing a dashed segment). */
  origin: Vec2;
}

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  guides: GuideLine[];
  /** Id of the node/wall snapped to, if any. */
  targetId?: string;
}

export interface SnapOptions {
  /** Snap radius in inches (the XR layer derives this from viewing distance). */
  tolerance: number;
  /** Chain start: the last placed point while drawing. */
  from?: Vec2;
  /** Primary axis of the room, radians in plan space. */
  axisAngle: number;
  angleStepDeg: number;
  grid: number;
  /** Thickness of the wall being drawn (for foundation-follow offsets). */
  drawThickness: number;
  /** Gap between a new wall and the foundation it follows. */
  foundationGap: number;
  /** Turn all snapping off (still rounds to 1/4"). */
  disabled?: boolean;
  /** Max number of nearby nodes to build extension guides from. */
  maxGuideNodes?: number;
  /** Ignore this node and its walls (the corner being dragged). */
  excludeNodeId?: string;
}

export const defaultSnapOptions: SnapOptions = {
  tolerance: 3,
  axisAngle: 0,
  angleStepDeg: 45,
  grid: 1,
  drawThickness: 4.5,
  foundationGap: 1,
};

const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  intersection: 2,
  edge: 3,
  follow: 4,
  angle: 5,
  perpendicular: 5,
  extension: 6,
  grid: 7,
  free: 8,
};

export function snapPriority(kind: SnapKind): number {
  return PRIORITY[kind];
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** Round a point to the grid in the room's axis frame. */
export function gridRound(p: Vec2, axisAngle: number, step: number, origin: Vec2 = { x: 0, y: 0 }): Vec2 {
  const local = rotate(sub(p, origin), -axisAngle);
  const r = { x: roundTo(local.x, step), y: roundTo(local.y, step) };
  return add(rotate(r, axisAngle), origin);
}

/** Build the candidate guide lines for this query. */
export function buildGuides(plan: Plan, p: Vec2, opts: SnapOptions): GuideLine[] {
  const guides: GuideLine[] = [];
  const axis = opts.axisAngle;
  const stepRad = (opts.angleStepDeg * Math.PI) / 180;

  // 1. Angle guides from the chain start.
  if (opts.from) {
    const angles = new Set<number>();
    const n = Math.round(Math.PI / stepRad);
    for (let k = 0; k < n; k++) angles.add(axis + k * stepRad);
    // Parallel / perpendicular to walls touching the chain start.
    for (const w of plan.walls) {
      const { a, b } = wallEnds(plan, w);
      if (dist(a, opts.from) < 0.05 || dist(b, opts.from) < 0.05) {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        angles.add(ang);
        angles.add(ang + Math.PI / 2);
      }
    }
    for (const ang of dedupeAngles([...angles])) {
      guides.push({ line: { p: opts.from, d: fromAngle(ang) }, kind: 'angle', origin: opts.from });
    }
  }

  // 2. Extension guides through nearby nodes, along the axis and perpendicular.
  const maxNodes = opts.maxGuideNodes ?? 10;
  const nearNodes = [...plan.nodes]
    .map((nd) => ({ nd, d: Math.hypot(nd.x - p.x, nd.y - p.y) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, maxNodes);
  const axisDir = fromAngle(axis);
  const axisPerp = perp(axisDir);
  for (const { nd } of nearNodes) {
    const np = { x: nd.x, y: nd.y };
    if (opts.from && dist(np, opts.from) < 0.05) continue; // covered by angle guides
    guides.push({ line: { p: np, d: axisDir }, kind: 'extension', origin: np });
    guides.push({ line: { p: np, d: axisPerp }, kind: 'extension', origin: np });
  }

  // 3. Wall extensions (collinear) and foundation-follow lines.
  for (const w of plan.walls) {
    const { a, b } = wallEnds(plan, w);
    const d = norm(sub(b, a));
    const near = projectOnSegment(p, a, b);
    const dNear = dist(near.point, p);
    if (dNear > 20 * 12) continue; // ignore walls more than 20 ft away
    const nearEnd = dist(p, a) < dist(p, b) ? a : b;
    guides.push({ line: { p: a, d }, kind: 'extension', origin: nearEnd });
    if (w.kind === 'existing') {
      const nrm = perp(d);
      const side = Math.sign((p.x - a.x) * nrm.x + (p.y - a.y) * nrm.y) || 1;
      const off = w.thickness / 2 + opts.foundationGap + opts.drawThickness / 2;
      const base = add(a, scale(nrm, side * off));
      guides.push({ line: { p: base, d }, kind: 'follow', origin: projectOnLine(p, { p: base, d }).point });
    }
  }
  return guides;
}

function dedupeAngles(angles: number[]): number[] {
  const out: number[] = [];
  for (const a of angles) {
    // Lines are undirected: compare modulo PI.
    const norm = ((a % Math.PI) + Math.PI) % Math.PI;
    if (!out.some((b) => {
      const diff = Math.abs(norm - b);
      return diff < 1e-3 || Math.abs(diff - Math.PI) < 1e-3;
    })) out.push(norm);
  }
  return out;
}

export function snap(fullPlan: Plan, raw: Vec2, opts: SnapOptions): SnapResult {
  const ex = opts.excludeNodeId;
  const plan: Plan = ex
    ? { ...fullPlan, nodes: fullPlan.nodes.filter((n) => n.id !== ex), walls: fullPlan.walls.filter((w) => w.a !== ex && w.b !== ex) }
    : fullPlan;
  if (opts.disabled) {
    return { point: gridRound(raw, opts.axisAngle, 0.25), kind: 'free', guides: [] };
  }
  const tol = opts.tolerance;

  // --- Point snaps --------------------------------------------------------
  let best: SnapResult | null = null;
  let bestD = tol;
  for (const n of plan.nodes) {
    const d = Math.hypot(n.x - raw.x, n.y - raw.y);
    if (d <= bestD) {
      bestD = d;
      best = { point: { x: n.x, y: n.y }, kind: 'endpoint', guides: [], targetId: n.id };
    }
  }
  // Corners of scanned objects (furnace, storage...).
  for (const o of plan.obstacles) {
    for (const c of o.poly) {
      const d = dist(c, raw);
      if (d <= bestD) {
        bestD = d;
        best = { point: { ...c }, kind: 'endpoint', guides: [], targetId: o.id };
      }
    }
  }
  if (best) return best;

  bestD = tol * 0.8;
  for (const w of plan.walls) {
    const { a, b } = wallEnds(plan, w);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(mid, raw);
    if (d <= bestD) {
      bestD = d;
      best = { point: mid, kind: 'midpoint', guides: [], targetId: w.id };
    }
  }
  if (best) return best;

  // --- Guide lines ---------------------------------------------------------
  const guides = buildGuides(plan, raw, opts);
  const close = guides
    .map((g) => {
      const pr = projectOnLine(raw, g.line);
      return { g, pr, d: dist(pr.point, raw) };
    })
    .filter((c) => c.d <= tol)
    // Angle guides only go forward from the chain start.
    .filter((c) => c.g.kind !== 'angle' || c.pr.t > -tol);

  // Intersections between two close guides.
  let bestX: SnapResult | null = null;
  let bestXD = tol;
  for (let i = 0; i < close.length; i++) {
    for (let j = i + 1; j < close.length; j++) {
      const x = intersectLines(close[i].g.line, close[j].g.line);
      if (!x) continue;
      const d = dist(x, raw);
      if (d <= bestXD) {
        bestXD = d;
        bestX = { point: x, kind: 'intersection', guides: [close[i].g, close[j].g] };
      }
    }
  }

  // On-wall (edge) snaps, optionally refined by a guide crossing that wall.
  let bestE: SnapResult | null = null;
  let bestED = tol;
  for (const w of plan.walls) {
    const { a, b } = wallEnds(plan, w);
    const pr = projectOnSegment(raw, a, b);
    const d = dist(pr.point, raw);
    if (d > bestED) continue;
    bestED = d;
    let point = pr.point;
    let used: GuideLine[] = [];
    const wl: Line = { p: a, d: norm(sub(b, a)) };
    for (const c of close) {
      if (c.g.kind === 'extension' && Math.abs(c.g.line.d.x * wl.d.y - c.g.line.d.y * wl.d.x) < 1e-3) continue;
      const x = intersectLines(wl, c.g.line);
      if (x && dist(x, raw) <= tol) {
        const onSeg = projectOnSegment(x, a, b);
        if (dist(onSeg.point, x) < 0.01) {
          point = x;
          used = [c.g];
          break;
        }
      }
    }
    bestE = { point, kind: 'edge', guides: used, targetId: w.id };
  }

  // Edges of scanned objects.
  for (const o of plan.obstacles) {
    for (let i = 0; i < o.poly.length; i++) {
      const pr = projectOnSegment(raw, o.poly[i], o.poly[(i + 1) % o.poly.length]);
      const d = dist(pr.point, raw);
      if (d < bestED) {
        bestED = d;
        bestE = { point: pr.point, kind: 'edge', guides: [], targetId: o.id };
      }
    }
  }

  if (bestX && (!bestE || bestXD <= bestED + 0.5)) return bestX;
  if (bestE) return bestE;

  if (close.length) {
    close.sort((p, q) => snapPriority(kindOf(p.g)) - snapPriority(kindOf(q.g)) || p.d - q.d);
    const c = close[0];
    // Round the distance along the guide to the grid.
    let point: Vec2;
    if (c.g.kind === 'angle' && opts.from) {
      const t = roundTo(c.pr.t, opts.grid);
      point = add(opts.from, scale(c.g.line.d, t));
    } else {
      const origin = c.g.origin;
      const t = roundTo(projectOnLine(raw, { p: origin, d: c.g.line.d }).t, opts.grid);
      point = add(origin, scale(c.g.line.d, t));
    }
    return { point, kind: kindOf(c.g), guides: [c.g] };
  }

  // --- Grid ---------------------------------------------------------------
  const origin = opts.from ?? (plan.nodes[0] ? { x: plan.nodes[0].x, y: plan.nodes[0].y } : { x: 0, y: 0 });
  return { point: gridRound(raw, opts.axisAngle, opts.grid, origin), kind: 'grid', guides: [] };
}

function kindOf(g: GuideLine): SnapKind {
  return g.kind;
}

/**
 * Primary room axis: direction of the longest wall (existing walls preferred),
 * folded into [0, PI/2) so the axis and its perpendicular are equivalent.
 */
export function primaryAxis(plan: Plan): number {
  let bestLen = 0;
  let ang = 0;
  let haveExisting = false;
  for (const w of plan.walls) {
    const isExisting = w.kind === 'existing';
    if (haveExisting && !isExisting) continue;
    const { a, b } = wallEnds(plan, w);
    const l = dist(a, b);
    if ((isExisting && !haveExisting) || l > bestLen) {
      bestLen = l;
      ang = Math.atan2(b.y - a.y, b.x - a.x);
      haveExisting = haveExisting || isExisting;
    }
  }
  const q = Math.PI / 2;
  return ((ang % q) + q) % q;
}
