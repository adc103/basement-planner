import type { Vec2 } from './geom2d.js';
import type { Evidence, Plan } from './plan.js';

/**
 * Fit, then verify (the ScanRuler idea): a wall or opening is first proposed
 * from the coarse point map, then its faces and edges are fitted to the fine
 * room mesh, and finally it is scored on how much of it the mesh saw and how
 * closely the two agree. The same scoring checks a plan you already have.
 *
 * Everything is plan inches; z is height.
 */

/** Room-mesh vertices with normals (pointing to free space), plan inches. */
export interface Surface {
  pos: Float32Array;
  nrm: Float32Array;
}

export interface WallGeom {
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** Floor and top of the wall, inches. */
  z0: number;
  z1: number;
  openings: Array<{ offset: number; width: number; height: number; sill: number }>;
}

export interface FaceFit {
  /** Signed offset of the face from the given centerline (+ = left normal side). */
  offset: number;
  /** RMS distance of supporting mesh points from the fitted face. */
  rms: number;
  /** Share of the face (outside openings) the mesh covers. */
  coverage: number;
  points: number;
}

export interface WallFit {
  /** Fitted centerline and thickness (unchanged where the mesh can't tell). */
  a: Vec2;
  b: Vec2;
  thickness: number;
  faces: { left: FaceFit | null; right: FaceFit | null };
  /** How far the centerline moved, inches (+ = toward the left normal). */
  shift: number;
  /** Mean distance of the model's faces from the mesh, inches. */
  deviation: number;
  coverage: number;
  evidence: Evidence;
  /** 0..1 */
  confidence: number;
  openings: OpeningFit[];
  /** Stretch along the wall (from a, inches) where the mesh shows its face; null if none. */
  support: [number, number] | null;
}

export interface OpeningFit {
  offset: number;
  width: number;
  /** Share of the opening where the mesh shows wall (should be ~0). */
  blocked: number;
  /** Jambs found on each side. */
  edges: number;
  evidence: Evidence;
}

const CELL = 6; // coverage grid, inches
const BAND = 4; // how far beyond a face to look for its points
const INLIER = 1; // inches: points this close support a face

/** A spatial index over surface points (2D buckets on the floor). */
export class SurfaceIndex {
  private cells = new Map<number, number[]>();
  constructor(
    readonly s: Surface,
    private cell = 24,
  ) {
    for (let i = 0; i < s.pos.length / 3; i++) {
      const k = this.key(Math.floor(s.pos[i * 3] / cell), Math.floor(s.pos[i * 3 + 1] / cell));
      let a = this.cells.get(k);
      if (!a) this.cells.set(k, (a = []));
      a.push(i);
    }
  }
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  /** Indices of points inside the floor rectangle around a segment, padded by r. */
  near(a: Vec2, b: Vec2, r: number): number[] {
    const out: number[] = [];
    const c = this.cell;
    const i0 = Math.floor((Math.min(a.x, b.x) - r) / c);
    const i1 = Math.floor((Math.max(a.x, b.x) + r) / c);
    const j0 = Math.floor((Math.min(a.y, b.y) - r) / c);
    const j1 = Math.floor((Math.max(a.y, b.y) + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const p of this.cells.get(this.key(i, j)) ?? []) out.push(p);
    return out;
  }
  get size(): number {
    return this.s.pos.length / 3;
  }
}

function median(v: number[]): number {
  const s = [...v].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Fit and score one wall against the mesh. */
export function fitWall(idx: SurfaceIndex, w: WallGeom, opts: { refine?: boolean } = {}): WallFit {
  const refine = opts.refine ?? true;
  const { a, b } = w;
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const n = { x: -d.y, y: d.x }; // left normal
  const half = w.thickness / 2;
  const P = idx.s.pos;
  const N = idx.s.nrm;
  const inOpening = (t: number, z: number) => w.openings.some((o) => Math.abs(t - o.offset) < o.width / 2 && z > w.z0 + o.sill && z < w.z0 + o.sill + o.height);
  // Points on vertical surfaces facing along the wall normal, near either face.
  const side: Record<'left' | 'right', Array<{ t: number; z: number; u: number }>> = { left: [], right: [] };
  // Jamb faces: inside the wall thickness, facing along the wall (+1 = toward b).
  const jambs: Array<{ t: number; z: number; dir: number }> = [];
  for (const i of idx.near(a, b, half + BAND)) {
    const px = P[i * 3];
    const py = P[i * 3 + 1];
    const pz = P[i * 3 + 2];
    if (pz < w.z0 + 3 || pz > w.z1 - 3) continue;
    const t = (px - a.x) * d.x + (py - a.y) * d.y;
    if (t < 1 || t > L - 1) continue;
    const u = (px - a.x) * n.x + (py - a.y) * n.y;
    const nd = N[i * 3] * n.x + N[i * 3 + 1] * n.y;
    if (Math.abs(N[i * 3 + 2]) > 0.5) continue;
    const na = N[i * 3] * d.x + N[i * 3 + 1] * d.y;
    if (Math.abs(na) > 0.8 && Math.abs(u) < half + 1.5) {
      jambs.push({ t, z: pz, dir: Math.sign(na) });
      continue;
    }
    if (Math.abs(nd) < 0.8) continue;
    // A left face looks left (normal +n) and sits on the + side; a right face the opposite.
    if (nd > 0 && u > half - BAND && u < half + BAND) side.left.push({ t, z: pz, u });
    else if (nd < 0 && u < -half + BAND && u > -half - BAND) side.right.push({ t, z: pz, u });
  }
  // Coverage cells of the face outside openings.
  const cols = Math.max(1, Math.floor(L / CELL));
  const rows = Math.max(1, Math.floor((w.z1 - w.z0 - 6) / CELL));
  let faceCells = 0;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) if (!inOpening((i + 0.5) * CELL, w.z0 + 3 + (j + 0.5) * CELL)) faceCells++;
  const fitFace = (pts: Array<{ t: number; z: number; u: number }>): FaceFit | null => {
    if (pts.length < 12) return null;
    let off = median(pts.map((p) => p.u));
    // Two rounds of trimmed mean around the median.
    for (let r = 0; r < 2; r++) {
      const inl = pts.filter((p) => Math.abs(p.u - off) < INLIER * (r ? 1 : 2));
      if (inl.length < 8) break;
      off = inl.reduce((s, p) => s + p.u, 0) / inl.length;
    }
    const inl = pts.filter((p) => Math.abs(p.u - off) < INLIER);
    const rms = Math.sqrt(inl.reduce((s, p) => s + (p.u - off) ** 2, 0) / Math.max(1, inl.length));
    const seen = new Set<number>();
    for (const p of inl) {
      if (inOpening(p.t, p.z)) continue;
      const i = Math.floor(p.t / CELL);
      const j = Math.floor((p.z - w.z0 - 3) / CELL);
      if (i >= 0 && i < cols && j >= 0 && j < rows) seen.add(i * rows + j);
    }
    return { offset: off, rms, coverage: faceCells ? seen.size / faceCells : 0, points: inl.length };
  };
  const left = fitFace(side.left);
  const right = fitFace(side.right);
  // New centerline and thickness.
  let center = 0;
  let thickness = w.thickness;
  const good = (f: FaceFit | null) => !!f && f.coverage >= 0.1;
  if (good(left) && good(right)) {
    const t2 = left!.offset - right!.offset;
    if (t2 > 2 && t2 < 16) {
      thickness = t2;
      center = (left!.offset + right!.offset) / 2;
    }
  } else if (good(left)) center = left!.offset - half;
  else if (good(right)) center = right!.offset + half;
  if (!refine) {
    center = 0;
    thickness = w.thickness;
  }
  const shift = center;
  const na = { x: a.x + n.x * shift, y: a.y + n.y * shift };
  const nb = { x: b.x + n.x * shift, y: b.y + n.y * shift };
  // How far the (possibly refined) model faces sit from the mesh faces.
  const devs: number[] = [];
  if (left) devs.push(Math.abs(left.offset - (center + thickness / 2)));
  if (right) devs.push(Math.abs(right.offset - (center - thickness / 2)));
  const deviation = devs.length ? devs.reduce((s, x) => s + x, 0) / devs.length : Infinity;
  const coverage = Math.max(left?.coverage ?? 0, right?.coverage ?? 0);
  const rms = Math.min(left?.rms ?? Infinity, right?.rms ?? Infinity);
  const evidence: Evidence = coverage >= 0.45 && rms <= 0.75 && deviation <= 1 ? 'measured' : coverage >= 0.12 && deviation <= 2 ? 'partial' : 'inferred';

  // Openings: the mesh should be empty inside, with jambs at the edges.
  const facePts = [...(left ? side.left.filter((p) => Math.abs(p.u - left.offset) < INLIER) : []), ...(right ? side.right.filter((p) => Math.abs(p.u - right.offset) < INLIER) : [])];
  const openings = w.openings.map((o) => fitOpening(facePts, jambs, o, w.z0, refine));
  // Supported stretch: 6" columns seen at two or more heights, first to last.
  let support: [number, number] | null = null;
  {
    const colH = new Map<number, Set<number>>();
    for (const p of facePts) {
      const c = Math.floor(p.t / 6);
      let set = colH.get(c);
      if (!set) colH.set(c, (set = new Set()));
      set.add(Math.floor(p.z / 12));
    }
    const cols = [...colH].filter(([, s]) => s.size >= 2).map(([c]) => c).sort((x, y) => x - y);
    if (cols.length) support = [Math.max(0, cols[0] * 6), Math.min(L, (cols[cols.length - 1] + 1) * 6)];
  }
  return {
    a: na,
    b: nb,
    thickness,
    faces: { left, right },
    shift,
    deviation,
    coverage,
    evidence,
    confidence: Math.min(1, coverage / 0.6),
    openings,
    support,
  };
}

function fitOpening(
  facePts: Array<{ t: number; z: number }>,
  jambPts: Array<{ t: number; z: number; dir: number }>,
  o: WallGeom['openings'][number],
  z0: number,
  refine: boolean,
): OpeningFit {
  // Heights here are absolute; sill is above the floor (z0).
  const bottom = z0 + o.sill;
  const top = bottom + o.height;
  const lo = bottom + 4;
  const hi = top - 4;
  // Jambs: walking out from the center in 1/2" steps, the first column with wall
  // seen at several heights below the top.
  const jamb = (dir: -1 | 1): number | null => {
    const edge = o.offset + (dir * o.width) / 2;
    // Best: the jamb's own face, which faces into the opening (-dir).
    const face = jambPts.filter((p) => p.dir === -dir && Math.abs(p.t - edge) < 6 && p.z > bottom + 2 && p.z < top - 2);
    if (face.length >= 6) return median(face.map((p) => p.t));
    let best: number | null = null;
    for (let s = -6; s <= 6; s += 0.5) {
      const t = edge + dir * s;
      const col = facePts.filter((p) => p.t > t - 0.5 && p.t < t + 0.5 && p.z > bottom + 2 && p.z < top - 2);
      const heights = new Set(col.map((p) => Math.floor(p.z / 6)));
      if (heights.size >= Math.max(3, Math.floor(o.height / 24))) {
        best = t;
        break;
      }
    }
    return best;
  };
  const l = jamb(-1);
  const r = jamb(1);
  let offset = o.offset;
  let width = o.width;
  if (refine && l !== null && r !== null && r - l > 12) {
    offset = (l + r) / 2;
    width = r - l;
  }
  // Blocked share (after fitting): 3" cells inside the opening that hold mesh points.
  const inside = facePts.filter((p) => p.z > lo && p.z < hi && Math.abs(p.t - offset) < width / 2 - 1.5);
  const cells = new Set(inside.map((p) => `${Math.floor(p.t / 3)},${Math.floor(p.z / 3)}`));
  const total = Math.max(1, Math.floor((width - 3) / 3) * Math.floor((hi - lo) / 3));
  const blocked = Math.min(1, cells.size / total);
  const edges = (l !== null ? 1 : 0) + (r !== null ? 1 : 0);
  const evidence: Evidence = blocked < 0.08 && edges === 2 ? 'measured' : blocked < 0.25 ? 'partial' : 'inferred';
  return { offset, width, blocked, edges, evidence };
}

/** A plan wall checked against the mesh: as drawn, and where the mesh says it is. */
export interface WallCheck {
  wallId: string;
  /** The wall as it is in the plan, scored. */
  check: WallFit;
  /** The wall moved and resized to the mesh (what "Fit to scan" applies). */
  fitted: WallFit;
}

/** Room-mesh pieces (plan-root meters, y up) to a plan-inch Surface. */
export function surfaceFromMeshes(pieces: Iterable<{ positions: Float32Array; normals: Float32Array }>, stride = 1): Surface {
  const INCH = 0.0254;
  let n = 0;
  const list = [...pieces];
  for (const p of list) n += Math.ceil(p.positions.length / 3 / stride);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  let o = 0;
  for (const p of list) {
    for (let i = 0; i < p.positions.length / 3; i += stride, o += 3) {
      pos[o] = p.positions[i * 3] / INCH;
      pos[o + 1] = p.positions[i * 3 + 2] / INCH;
      pos[o + 2] = p.positions[i * 3 + 1] / INCH;
      nrm[o] = p.normals[i * 3];
      nrm[o + 1] = p.normals[i * 3 + 2];
      nrm[o + 2] = p.normals[i * 3 + 1];
    }
  }
  return { pos: pos.subarray(0, o), nrm: nrm.subarray(0, o) };
}

/** A plan's walls as segments (to keep proposals from repeating them). */
export function planSegs(plan: Plan): Seg[] {
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  const out: Seg[] = [];
  for (const w of plan.walls) {
    const a = node.get(w.a);
    const b = node.get(w.b);
    if (a && b) out.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, thickness: w.thickness });
  }
  return out;
}

/** Check plan walls (real ones by default) against the mesh, worst first. */
export function checkPlan(plan: Plan, surf: Surface, opts: { includeNew?: boolean; ids?: string[] } = {}): WallCheck[] {
  const idx = new SurfaceIndex(surf);
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  const out: WallCheck[] = [];
  for (const w of plan.walls) {
    if (opts.ids ? !opts.ids.includes(w.id) : w.kind !== 'existing' && !opts.includeNew) continue;
    const a = node.get(w.a);
    const b = node.get(w.b);
    if (!a || !b) continue;
    const geom: WallGeom = {
      a: { x: a.x, y: a.y },
      b: { x: b.x, y: b.y },
      thickness: w.thickness,
      z0: 0,
      z1: w.height,
      openings: plan.openings.filter((o) => o.wallId === w.id).map((o) => ({ offset: o.offset, width: o.width, height: o.height, sill: o.sill })),
    };
    out.push({ wallId: w.id, check: fitWall(idx, geom, { refine: false }), fitted: fitWall(idx, geom) });
  }
  const bad = (c: WallCheck) => (c.check.evidence === 'inferred' ? -1 : c.check.deviation);
  return out.sort((x, y) => bad(y) - bad(x));
}

/** A wall to compare against: centerline, thickness. */
export interface Seg {
  a: Vec2;
  b: Vec2;
  thickness: number;
}

/**
 * Is `p` the same real wall as `q`? Parallel (within 6 degrees), centerlines
 * closer than their half-thicknesses plus 8", and overlapping along their
 * length by at least 40% of the shorter one.
 */
export function sameWall(p: Seg, q: Seg): boolean {
  const Lp = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
  const Lq = Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
  if (Lp < 1 || Lq < 1) return false;
  const d = { x: (q.b.x - q.a.x) / Lq, y: (q.b.y - q.a.y) / Lq };
  const dp = { x: (p.b.x - p.a.x) / Lp, y: (p.b.y - p.a.y) / Lp };
  if (Math.abs(d.x * dp.y - d.y * dp.x) > 0.105) return false;
  const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
  const off = Math.abs(-(mid.x - q.a.x) * d.y + (mid.y - q.a.y) * d.x);
  if (off > (p.thickness + q.thickness) / 2 + 8) return false;
  const t0 = (p.a.x - q.a.x) * d.x + (p.a.y - q.a.y) * d.y;
  const t1 = (p.b.x - q.a.x) * d.x + (p.b.y - q.a.y) * d.y;
  const overlap = Math.min(Lq, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
  return overlap >= 0.4 * Math.min(Lp, Lq);
}

const EVIDENCE_WEIGHT: Record<Evidence, number> = { measured: 1, partial: 0.6, manual: 0.6, inferred: 0.2 };

/**
 * One proposal per real wall: drop walls the plan already has, and among
 * proposals that are the same wall keep the best supported one.
 */
export function dedupeWalls<W extends Seg & { confidence: number; evidence?: Evidence }>(walls: W[], known: Seg[] = []): W[] {
  const score = (w: W) => EVIDENCE_WEIGHT[w.evidence ?? 'partial'] * (0.3 + w.confidence) * Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const order = [...walls].sort((x, y) => score(y) - score(x));
  const kept: W[] = [];
  for (const w of order) {
    if (known.some((k) => sameWall(w, k))) continue;
    if (kept.some((k) => sameWall(w, k))) continue;
    kept.push(w);
  }
  // Keep the original order (stable ids in review).
  return walls.filter((w) => kept.includes(w));
}
