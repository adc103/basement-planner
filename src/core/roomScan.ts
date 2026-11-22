import { add, dist, intersectLines, norm, scale, sub, type Vec2 } from './geom2d.js';
import { convexHull } from './poly.js';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface ScanPlane {
  /** Semantic label from the headset's room setup ('wall', 'floor', 'ceiling', ...). */
  label: string;
  /** Polygon points (any 3D space; `toPlan` maps them). */
  points: P3[];
}

export interface ScanOpening {
  type: 'door' | 'window';
  /** Distance from wall end a to the opening's center, inches. */
  offset: number;
  width: number;
  height: number;
  sill: number;
}

export interface ScanWall {
  a: Vec2;
  b: Vec2;
  /** Inches: measured between the two faces of a shared wall, else the foundation default. */
  thickness?: number;
  openings?: ScanOpening[];
}

export interface ScanResult {
  /** Existing wall centerlines, plan inches. */
  walls: ScanWall[];
  /** Floor and ceiling heights in the plan root's local meters, if seen. */
  floorY: number | null;
  ceilingY: number | null;
}

/** Corners closer than this (inches) are joined at their line intersection. */
const JOIN = 18;

/**
 * Turn detected room planes into existing-wall centerlines.
 * `toPlan` maps a point to plan inches plus its height (meters) in the plan root.
 */
export function wallsFromScan(
  planes: ScanPlane[],
  toPlan: (w: P3) => { p: Vec2; y: number },
  foundationThickness: number,
): ScanResult {
  let floorY: number | null = null;
  let ceilingY: number | null = null;
  const faces: Array<{ a: Vec2; b: Vec2 }> = [];
  const floors: Vec2[][] = [];
  const frames: Array<{ door: boolean; a: Vec2; b: Vec2; lo: number; hi: number }> = [];

  const farthest = (pts: Array<{ p: Vec2 }>) => {
    let best = 0;
    let a = pts[0].p;
    let b = pts[0].p;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const d = dist(pts[i].p, pts[j].p);
        if (d > best) [best, a, b] = [d, pts[i].p, pts[j].p];
      }
    return { a, b, len: best };
  };

  for (const pl of planes) {
    const label = pl.label.toLowerCase();
    const pts = pl.points.map(toPlan);
    if (!pts.length) continue;
    const meanY = pts.reduce((s2, q) => s2 + q.y, 0) / pts.length;
    if (label === 'floor') {
      floorY = floorY === null ? meanY : Math.min(floorY, meanY);
      if (pts.length >= 3) floors.push(pts.map((q) => q.p));
    } else if (label === 'ceiling') {
      ceilingY = ceilingY === null ? meanY : Math.max(ceilingY, meanY);
    } else if (label === 'wall') {
      // Horizontal extent of the wall: the furthest pair of points in plan.
      const f = farthest(pts);
      if (f.len >= 12) faces.push({ a: f.a, b: f.b });
    } else if (label.startsWith('door') || label.startsWith('window')) {
      const f = farthest(pts);
      const ys = pts.map((q) => q.y);
      if (f.len >= 12) frames.push({ door: label.startsWith('door'), a: f.a, b: f.b, lo: Math.min(...ys), hi: Math.max(...ys) });
    }
  }

  if (!faces.length) return { walls: [], floorY, ceilingY };

  // Which side of each face is the room: the side with a scanned floor in front of it
  // (Space Setup can hold several rooms), else the side facing the middle of everything.
  const inside = (pt: Vec2, poly: Vec2[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const center = faces.reduce((acc, f) => add(acc, scale(add(f.a, f.b), 0.5 / faces.length)), { x: 0, y: 0 });
  const half = foundationThickness / 2;
  const sides = faces.map((f) => {
    const d = norm(sub(f.b, f.a));
    let n = { x: -d.y, y: d.x }; // points into the room
    const mid = scale(add(f.a, f.b), 0.5);
    // This face's room: the floor outline with an edge running along the face
    // (outlines are rough and can overlap the room next door, so probing for
    // "any floor" isn't enough). The room is on the side where that outline is.
    let room: Vec2[] | null = null;
    let roomD = 12;
    for (const poly of floors) {
      for (let k = 0; k < poly.length; k++) {
        const p0 = poly[k];
        const p1 = poly[(k + 1) % poly.length];
        const L = dist(p0, p1);
        if (L < 1) continue;
        const e = scale(sub(p1, p0), 1 / L);
        if (Math.abs(e.x * d.y - e.y * d.x) > 0.17) continue;
        const t = (mid.x - p0.x) * e.x + (mid.y - p0.y) * e.y;
        if (t < -6 || t > L + 6) continue;
        const off = Math.abs((mid.x - p0.x) * -e.y + (mid.y - p0.y) * e.x);
        if (off < roomD) [roomD, room] = [off, poly];
      }
    }
    const front = room ? inside(add(mid, scale(n, 18)), room) : floors.some((p) => inside(add(mid, scale(n, 18)), p));
    const back = room ? inside(add(mid, scale(n, -18)), room) : floors.some((p) => inside(add(mid, scale(n, -18)), p));
    if (back && !front) n = scale(n, -1);
    else if (front === back && (center.x - mid.x) * n.x + (center.y - mid.y) * n.y < 0) n = scale(n, -1);
    return { ...f, d, n, mid };
  });

  // Two faces back to back, a few inches apart (one room on each side), are the two
  // sides of one wall: its thickness is measured, not assumed.
  const used = new Set<number>();
  const lines: Array<{ a: Vec2; b: Vec2; d: Vec2; thickness: number }> = [];
  for (let i = 0; i < sides.length; i++) {
    if (used.has(i)) continue;
    const f = sides[i];
    let mate = -1;
    let gapBest = Infinity;
    for (let j = 0; j < sides.length; j++) {
      if (j === i || used.has(j)) continue;
      const g = sides[j];
      if (Math.abs(f.d.x * g.d.y - f.d.y * g.d.x) > 0.1) continue;
      if (f.n.x * g.n.x + f.n.y * g.n.y > -0.9) continue; // must face away from each other
      const gap = -((g.mid.x - f.mid.x) * f.n.x + (g.mid.y - f.mid.y) * f.n.y); // g behind f
      if (gap < 2.5 || gap > 10) continue;
      const ta = (g.a.x - f.a.x) * f.d.x + (g.a.y - f.a.y) * f.d.y;
      const tb = (g.b.x - f.a.x) * f.d.x + (g.b.y - f.a.y) * f.d.y;
      const L = dist(f.a, f.b);
      const ov = Math.min(L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
      if (ov < 0.4 * Math.min(L, dist(g.a, g.b))) continue;
      if (gap < gapBest) [gapBest, mate] = [gap, j];
    }
    if (mate >= 0) {
      used.add(i);
      used.add(mate);
      const g = sides[mate];
      const ta = (g.a.x - f.a.x) * f.d.x + (g.a.y - f.a.y) * f.d.y;
      const tb = (g.b.x - f.a.x) * f.d.x + (g.b.y - f.a.y) * f.d.y;
      const t0 = Math.min(0, ta, tb);
      const t1 = Math.max(dist(f.a, f.b), ta, tb);
      const base = add(f.a, scale(f.n, -gapBest / 2));
      lines.push({ a: add(base, scale(f.d, t0)), b: add(base, scale(f.d, t1)), d: f.d, thickness: Math.round(gapBest * 4) / 4 });
    }
  }
  // Single faces: push back by half the foundation thickness, away from the room,
  // so the wall's inside face stays where the headset saw the real wall.
  sides.forEach((f, i) => {
    if (used.has(i)) return;
    lines.push({ a: add(f.a, scale(f.n, -half)), b: add(f.b, scale(f.n, -half)), d: f.d, thickness: foundationThickness });
  });

  // Join neighbouring walls at their true corner (line intersection).
  for (let i = 0; i < lines.length; i++) {
    for (const endI of ['a', 'b'] as const) {
      for (let j = i + 1; j < lines.length; j++) {
        for (const endJ of ['a', 'b'] as const) {
          const pi = lines[i][endI];
          const pj = lines[j][endJ];
          if (dist(pi, pj) > JOIN) continue;
          const x = intersectLines({ p: lines[i].a, d: lines[i].d }, { p: lines[j].a, d: lines[j].d });
          if (x && dist(x, pi) < JOIN * 1.5 && dist(x, pj) < JOIN * 1.5) {
            lines[i][endI] = x;
            lines[j][endJ] = x;
          } else if (!x) {
            const m = scale(add(pi, pj), 0.5);
            lines[i][endI] = m;
            lines[j][endJ] = m;
          }
        }
      }
    }
  }

  // Door and window frames onto the wall they sit in.
  const walls: ScanWall[] = lines.map((l) => ({ a: l.a, b: l.b, thickness: l.thickness, openings: [] }));
  const y0 = floorY ?? 0;
  for (const fr of frames) {
    const mid = scale(add(fr.a, fr.b), 0.5);
    const fd = norm(sub(fr.b, fr.a));
    let best: ScanWall | null = null;
    let bestOff = Infinity;
    for (const w of walls) {
      const d = norm(sub(w.b, w.a));
      if (Math.abs(d.x * fd.y - d.y * fd.x) > 0.17) continue;
      const off = Math.abs((mid.x - w.a.x) * -d.y + (mid.y - w.a.y) * d.x);
      const t = (mid.x - w.a.x) * d.x + (mid.y - w.a.y) * d.y;
      if (off > (w.thickness ?? foundationThickness) / 2 + 8 || t < 0 || t > dist(w.a, w.b)) continue;
      if (off < bestOff) [bestOff, best] = [off, w];
    }
    if (!best) continue;
    const d = norm(sub(best.b, best.a));
    const width = Math.round(dist(fr.a, fr.b) * 4) / 4;
    const sill = Math.max(0, Math.round(((fr.lo - y0) / 0.0254) * 4) / 4);
    const height = Math.round(((fr.hi - fr.lo) / 0.0254) * 4) / 4;
    const door = fr.door || sill < 6;
    best.openings!.push({
      type: door ? 'door' : 'window',
      offset: (mid.x - best.a.x) * d.x + (mid.y - best.a.y) * d.y,
      width,
      height: door ? height + sill : height,
      sill: door ? 0 : sill,
    });
  }
  return { walls, floorY, ceilingY };
}

export interface ScanBox {
  label: string;
  /** The 8 corners of the object's bounding box. */
  corners: P3[];
}

const NOT_OBSTACLES = new Set(['', 'global mesh', 'wall', 'floor', 'ceiling', 'door frame', 'window frame', 'wall art', 'invisible wall face']);

/** Space Setup objects (storage, tables, "other"...) -> obstacle footprints in plan inches. */
export function obstaclesFromScan(
  boxes: ScanBox[],
  toPlan: (w: P3) => { p: Vec2; y: number },
  floorY: number,
): Array<{ label: string; poly: Vec2[]; height: number; source: 'scan' }> {
  const out: Array<{ label: string; poly: Vec2[]; height: number; source: 'scan' }> = [];
  for (const b of boxes) {
    const label = b.label.toLowerCase();
    if (NOT_OBSTACLES.has(label)) continue;
    const pts = b.corners.map(toPlan);
    const poly = convexHull(pts.map((q) => q.p));
    if (poly.length < 3) continue;
    const top = Math.max(...pts.map((q) => q.y));
    const height = (top - floorY) / 0.0254;
    if (height < 1) continue;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) > 240 || Math.max(...ys) - Math.min(...ys) > 240) continue; // >20 ft: not an object
    out.push({ label: b.label || 'object', poly, height, source: 'scan' });
  }
  return out;
}

/** Short fingerprint of a scan so an unchanged room isn't re-imported. */
export function scanSignature(walls: Array<{ a: Vec2; b: Vec2 }>, obstacles: Array<{ poly: Vec2[] }>): string {
  const r = (v: number) => Math.round(v / 3);
  const parts = [
    ...walls.map((w) => [r(w.a.x), r(w.a.y), r(w.b.x), r(w.b.y)].join(',')),
    ...obstacles.map((o) => o.poly.map((p) => `${r(p.x)},${r(p.y)}`).join(';')),
  ].sort();
  let h = 5381;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${walls.length}w${obstacles.length}o:${(h >>> 0).toString(36)}`;
}
