import { dot, sub } from './geom2d.js';
import type { Opening, Plan, Wall } from './plan.js';
import { computeFootprints, type WallFootprint } from './wallGeometry.js';
import { wallEnds, wallLength, wallsAtNode } from './ops.js';

export type MemberKind = 'plate' | 'stud' | 'king' | 'jack' | 'header' | 'cripple' | 'block';

/** One piece of lumber in wall-local coordinates (inches). */
export interface Member {
  wallId: string;
  kind: MemberKind;
  /** Center distance along the wall from node a. */
  s: number;
  /** Size along the wall. */
  len: number;
  /** Bottom / top height. */
  z0: number;
  z1: number;
  /** Depth across the wall (3.5 for 2x4, 5.5 for 2x6). */
  depth: number;
}

const T = 1.5; // lumber thickness

export function studDepth(wall: Wall): number {
  return wall.framing.studSize === '2x6' ? 5.5 : 3.5;
}

/** Header depth for a span, inches (2x6 / 2x8 / 2x10 / 2x12). */
export function headerDepth(span: number): number {
  if (span <= 36) return 5.5;
  if (span <= 60) return 7.25;
  if (span <= 84) return 9.25;
  return 11.25;
}

/** Extent of the wall footprint along its own axis (covers mitered/extended ends). */
function span(fp: WallFootprint): [number, number] {
  const ss = [fp.leftA, fp.rightA, fp.leftB, fp.rightB].map((p) => dot(sub(p, fp.a), fp.dir));
  return [Math.min(...ss), Math.max(...ss)];
}

/** Concrete/block foundation walls aren't framed. */
export function isConcreteWall(w: { kind: string; thickness: number }): boolean {
  return w.kind === 'existing' && w.thickness >= 7;
}

/** How a wall's framing ends and what backing it needs from walls meeting it. */
export interface WallEnds {
  /** Framing extent along the wall from node a, inches. */
  s0: number;
  s1: number;
  /** Extra studs where other walls butt into this one (drywall backing). */
  backers: number[];
}

const COLLINEAR = 0.05;

function dirOf(plan: Plan, w: Wall, fromNode: string): { x: number; y: number } {
  const { a, b } = wallEnds(plan, w);
  const [p, q] = w.a === fromNode ? [a, b] : [b, a];
  const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (q.x - p.x) / L, y: (q.y - p.y) / L };
}

/**
 * Work out each framed wall's ends the way a framer would:
 * - free end: frame to the end of the wall
 * - L corner: the longer wall runs through to the outside corner and gets a
 *   backing stud for the other wall's drywall; the other butts into it
 * - T: the wall that ends on another butts into it; the through wall gets a
 *   pair of backing studs either side of it
 * - against concrete: frame up to the concrete face
 */
export function wallFramingEnds(plan: Plan, w: Wall, fp: WallFootprint, framed: (x: Wall) => boolean): WallEnds {
  const [spanLo, spanHi] = span(fp);
  const L = fp.length;
  const out: WallEnds = { s0: spanLo, s1: spanHi, backers: [] };
  for (const end of ['a', 'b'] as const) {
    const node = end === 'a' ? w.a : w.b;
    const sNode = end === 'a' ? 0 : L;
    const inward = end === 'a' ? 1 : -1;
    const myDir = dirOf(plan, w, node);
    const others = wallsAtNode(plan, node).filter((x) => x.id !== w.id);
    if (!others.length) continue; // free end
    const cross = (x: Wall) => {
      const d = dirOf(plan, x, node);
      return { d, c: Math.abs(myDir.x * d.y - myDir.y * d.x), dot: myDir.x * d.x + myDir.y * d.y };
    };
    const continues = others.find((x) => cross(x).c < COLLINEAR && cross(x).dot < 0);
    const butting = others.filter((x) => cross(x).c >= COLLINEAR);
    const throughPair = butting.find((x) => butting.some((y) => y !== x && cross(y).c >= COLLINEAR && Math.abs(dirOf(plan, x, node).x * dirOf(plan, y, node).y - dirOf(plan, x, node).y * dirOf(plan, y, node).x) < COLLINEAR));
    const setEnd = (s: number) => {
      if (end === 'a') out.s0 = s;
      else out.s1 = s;
    };
    if (continues) {
      // This wall carries on through the node: frame to the node; backing for walls butting here.
      setEnd(sNode);
      for (const b of butting) out.backers.push(sNode + inward * (b.thickness / 2 + T / 2));
      continue;
    }
    if (throughPair) {
      // A tee: this wall ends on another wall running through.
      setEnd(sNode + inward * (throughPair.thickness / 2));
      continue;
    }
    const v = butting[0];
    if (!v) continue;
    // L corner. Concrete always wins; otherwise the longer framed wall runs through.
    const vLen = wallLength(plan, v);
    const iRunThrough = framed(v) && !isConcreteWall(v) && (L > vLen + 0.01 || (Math.abs(L - vLen) <= 0.01 && w.id < v.id));
    if (iRunThrough) {
      // keep the outside corner; back the other wall's inside face
      out.backers.push(sNode + inward * (v.thickness / 2 + T / 2));
    } else {
      setEnd(sNode + inward * (v.thickness / 2));
    }
  }
  // Tees landing in this wall's middle: other walls whose end node sits on this wall.
  // (After the plan splits walls at tees these show up as "continues" above.)
  return out;
}

/**
 * Stud framing for every new wall; with `includeExisting`, also for existing
 * framed partitions (for the x-ray view; they aren't part of the materials list).
 */
export function generateFraming(plan: Plan, includeExisting = false): Member[] {
  const fps = computeFootprints(plan);
  const framed = (x: Wall) => x.kind === 'new' || (includeExisting && !isConcreteWall(x));
  const out: Member[] = [];
  for (const w of plan.walls) {
    if (!framed(w)) continue;
    const fp = fps.get(w.id);
    if (!fp) continue;
    out.push(...frameWall(w, fp, plan.openings.filter((o) => o.wallId === w.id), wallFramingEnds(plan, w, fp, framed)));
  }
  return out;
}

export function frameWall(w: Wall, fp: WallFootprint, openings: Opening[], ends?: WallEnds): Member[] {
  const depth = studDepth(w);
  const H = w.height;
  const [s0, s1] = ends ? [ends.s0, ends.s1] : span(fp);
  const plates = w.framing.topPlates;
  const studTop = H - plates * T;
  const m: Member[] = [];
  const add = (kind: MemberKind, a: number, b: number, z0: number, z1: number) => {
    if (b - a > 0.05 && z1 - z0 > 0.05) m.push({ wallId: w.id, kind, s: (a + b) / 2, len: b - a, z0, z1, depth });
  };

  // Rough openings and the zones where regular studs are replaced.
  const ros = openings
    .map((o) => {
      const a = o.offset - o.width / 2;
      const b = o.offset + o.width / 2;
      const top = Math.min(o.sill + o.height, studTop - 1);
      const hd = Math.min(headerDepth(o.width), studTop - top);
      return { o, a, b, top, hd, door: o.sill <= 0.01 };
    })
    .sort((p, q) => p.a - q.a);
  const blocked = (s: number) => ros.some((r) => s > r.a - 2 * T - 0.5 && s < r.b + 2 * T + 0.5);

  // Bottom plate, broken at door openings.
  let cursor = s0;
  for (const r of ros) {
    if (!r.door) continue;
    add('plate', cursor, r.a, 0, T);
    cursor = r.b;
  }
  add('plate', cursor, s1, 0, T);
  // Top plates.
  for (let k = 0; k < plates; k++) add('plate', s0, s1, H - (k + 1) * T, H - k * T);

  // Fixed studs first: ends, corner/tee backing, kings and jacks.
  const fixed: number[] = [s0 + T / 2, s1 - T / 2];
  for (const b of ends?.backers ?? []) if (b > s0 + T && b < s1 - T && !blocked(b)) fixed.push(b);
  for (const r of ros) fixed.push(r.a - 1.5 * T, r.a - T / 2, r.b + T / 2, r.b + 1.5 * T);
  for (const s of fixed.slice(0, 2)) if (!blocked(s)) add('stud', s - T / 2, s + T / 2, T, studTop);
  for (const s of (ends?.backers ?? []).filter((b) => fixed.includes(b))) add('stud', s - T / 2, s + T / 2, T, studTop);

  // Layout: 16" on center measured from the starting end, so sheet edges land on studs.
  // Skip a layout stud that would crowd one already there (it'd be a wasted stud).
  const spacing = w.framing.spacing;
  const layout: number[] = [];
  if (w.framing.layoutFrom === 'a') for (let s = s0 + spacing; s < s1 - T; s += spacing) layout.push(s);
  else for (let s = s1 - spacing; s > s0 + T; s -= spacing) layout.push(s);
  const studs: number[] = [];
  for (const s of layout) {
    if (blocked(s)) continue;
    if (fixed.some((f) => Math.abs(f - s) < 3)) continue;
    studs.push(s);
    add('stud', s - T / 2, s + T / 2, T, studTop);
  }

  for (const r of ros) {
    // King studs (full height) and jack studs (carry the header).
    add('king', r.a - 2 * T, r.a - T, T, studTop);
    add('king', r.b + T, r.b + 2 * T, T, studTop);
    add('jack', r.a - T, r.a, T, r.top);
    add('jack', r.b, r.b + T, T, r.top);
    add('header', r.a - T, r.b + T, r.top, r.top + r.hd);
    // Cripples above the header and below a window sill, on layout.
    for (const s of layout) {
      if (s <= r.a || s >= r.b) continue;
      add('cripple', s - T / 2, s + T / 2, r.top + r.hd, studTop);
      if (!r.door) add('cripple', s - T / 2, s + T / 2, T, r.o.sill - T);
    }
    if (!r.door) add('plate', r.a, r.b, r.o.sill - T, r.o.sill); // rough sill
  }

  // Fire blocking for walls over 10 ft: a row of blocks between studs at mid-height.
  if (H > 120) {
    const all = [...m.filter((x) => x.kind === 'stud' || x.kind === 'king').map((x) => x.s)].sort((a, b) => a - b);
    const zb = Math.round(H / 2);
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i] + T / 2;
      const b = all[i + 1] - T / 2;
      if (b - a > 2 && !ros.some((r) => a < r.b && b > r.a && zb < r.top + r.hd)) add('block', a, b, zb, zb + T);
    }
  }
  return m;
}

export interface FramingSummary {
  studs: number;
  plateFeet: number;
  headers: number;
}

export function summarizeFraming(members: Member[]): FramingSummary {
  let studs = 0;
  let plate = 0;
  let headers = 0;
  for (const m of members) {
    if (m.kind === 'plate' || m.kind === 'block') plate += m.len;
    else if (m.kind === 'header') headers++;
    else studs++;
  }
  return { studs, plateFeet: plate / 12, headers };
}
