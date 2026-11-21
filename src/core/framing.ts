import { dot, sub } from './geom2d.js';
import type { Opening, Plan, Wall } from './plan.js';
import { computeFootprints, type WallFootprint } from './wallGeometry.js';

export type MemberKind = 'plate' | 'stud' | 'king' | 'jack' | 'header' | 'cripple';

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

/**
 * Stud framing for every new wall; with `includeExisting`, also for existing
 * framed partitions (for the x-ray view; they aren't part of the materials list).
 */
export function generateFraming(plan: Plan, includeExisting = false): Member[] {
  const fps = computeFootprints(plan);
  const out: Member[] = [];
  for (const w of plan.walls) {
    if (w.kind !== 'new' && !(includeExisting && !isConcreteWall(w))) continue;
    const fp = fps.get(w.id);
    if (fp) out.push(...frameWall(w, fp, plan.openings.filter((o) => o.wallId === w.id)));
  }
  return out;
}

export function frameWall(w: Wall, fp: WallFootprint, openings: Opening[]): Member[] {
  const depth = studDepth(w);
  const H = w.height;
  const [s0, s1] = span(fp);
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

  // Regular studs on layout, plus end studs.
  const spacing = w.framing.spacing;
  const studs = new Set<number>();
  studs.add(s0 + T / 2);
  studs.add(s1 - T / 2);
  // Layout studs, skipping any that would crowd an end stud.
  const clear = (s: number) => s > s0 + 2.5 * T && s < s1 - 2.5 * T;
  if (w.framing.layoutFrom === 'a') {
    for (let s = spacing; s < s1; s += spacing) if (clear(s)) studs.add(s);
  } else {
    for (let s = fp.length - spacing; s > s0; s -= spacing) if (clear(s)) studs.add(s);
  }
  for (const s of [...studs].sort((a, b) => a - b)) {
    if (blocked(s)) continue;
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
    for (const s of studs) {
      if (s <= r.a || s >= r.b) continue;
      add('cripple', s - T / 2, s + T / 2, r.top + r.hd, studTop);
      if (!r.door) add('cripple', s - T / 2, s + T / 2, T, r.o.sill - T);
    }
    if (!r.door) add('plate', r.a, r.b, r.o.sill - T, r.o.sill); // rough sill
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
    if (m.kind === 'plate') plate += m.len;
    else if (m.kind === 'header') headers++;
    else studs++;
  }
  return { studs, plateFeet: plate / 12, headers };
}
