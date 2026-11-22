import { add, scale, type Vec2 } from './geom2d.js';
import type { PP } from './wallDetect.js';

/**
 * Wall finding from a scanned point cloud plus free-space evidence.
 *
 * Follows the approach of indoor-reconstruction work on cluttered rooms
 * (Adan & Huber, "3D reconstruction of interior wall surfaces under occlusion
 * and clutter"; Okorn et al.; Mura et al.):
 *
 * 1. Basements are rectilinear: find the room's two main directions.
 * 2. Candidate wall planes are dense vertical slices along those directions.
 * 3. Each plane is cut into 4" x 4" surface cells and every cell is labelled
 *      occupied - points lie on the plane
 *      empty    - depth rays passed through it (you saw past it)
 *      unknown  - never seen (hidden behind clutter, or not looked at)
 *    This is what separates a doorway (empty) from a wall behind a shelf (unknown).
 * 4. Wall extent = the run of columns with wall evidence, bridging unknown
 *    stretches; it ends where you can see through it for a long way.
 * 5. Openings = rectangles of empty cells inside a wall: touching the floor they
 *    are doors / openings, higher up they are windows.
 * 6. A plane only counts as a wall if it reaches up near the ceiling, so the
 *    sides of shelves and appliances don't become walls.
 * 7. Thickness and inside/outside come from which side the free space is on;
 *    two faces with solid nothing between them are one partition wall.
 */

export interface FreeLookup {
  count(x: number, y: number, z: number): number;
}

export interface FoundOpening {
  center: Vec2;
  width: number;
  height: number;
  sill: number;
  type: 'door' | 'opening' | 'window';
}

export interface FoundWall {
  a: Vec2;
  b: Vec2;
  thickness: number;
  foundation: boolean;
  /** Unit normal pointing into the room (the side you scanned from). */
  n: Vec2;
  /** The visible face, for reference. */
  faceA: Vec2;
  faceB: Vec2;
  confidence: number;
  openings: FoundOpening[];
}

export interface FinderOptions {
  z0: number;
  H: number;
  axis: number;
  partitionThickness: number;
  foundationThickness: number;
}

const TS = 4; // along-wall cell, inches
const ZS = 4; // height cell
const DOOR_WIDTHS = [24, 28, 30, 32, 34, 36];
const EMPTY = 2;
const OCC = 1;

interface Face {
  dirIdx: 0 | 1;
  c: number;
  /** Span along the wall direction, inches. */
  t0: number;
  t1: number;
  coverage: number;
  roomSide: number;
  foundation: boolean;
  openings: Array<{ t0: number; t1: number; zb: number; zt: number }>;
}

export function findWalls(points: PP[], free: FreeLookup, o: FinderOptions): FoundWall[] {
  const { z0, H } = o;
  const zLo = z0 + 3;
  const zHi = H - 4;
  const L = Math.max(4, Math.floor((zHi - zLo) / ZS));
  const topLv = Math.floor((H - 18 - zLo) / ZS); // levels at/above this are "near the ceiling"
  const band = points.filter((p) => p.z > zLo && p.z < zHi);
  const dirs: Vec2[] = [
    { x: Math.cos(o.axis), y: Math.sin(o.axis) },
    { x: -Math.sin(o.axis), y: Math.cos(o.axis) },
  ];
  const faces: Face[] = [];

  for (const dirIdx of [0, 1] as const) {
    const d = dirs[dirIdx];
    const n = { x: -d.y, y: d.x };
    // Bucket points by their offset across (1"), weighting the upper half (less clutter).
    const buckets = new Map<number, PP[]>();
    const hist = new Map<number, number>();
    for (const p of band) {
      const c = Math.round(p.x * n.x + p.y * n.y);
      let b = buckets.get(c);
      if (!b) buckets.set(c, (b = []));
      b.push(p);
      hist.set(c, (hist.get(c) ?? 0) + (p.z > (zLo + zHi) / 2 ? 2 : 1));
    }
    const peaks = [...hist.keys()]
      .map((c) => ({ c, s: (hist.get(c - 1) ?? 0) + (hist.get(c) ?? 0) + (hist.get(c + 1) ?? 0) }))
      .filter((p) => p.s >= 50)
      .sort((a, b) => b.s - a.s);
    const taken: number[] = [];
    for (const pk of peaks) {
      if (taken.some((c) => Math.abs(c - pk.c) < 3)) continue;
      taken.push(pk.c);
      const near: PP[] = [];
      for (let c = pk.c - 2; c <= pk.c + 2; c++) for (const p of buckets.get(c) ?? []) near.push(p);
      if (near.length < 40) continue;
      const cs = near.map((p) => p.x * n.x + p.y * n.y).sort((a, b) => a - b);
      const cMed = cs[Math.floor(cs.length / 2)];
      faces.push(...facesOnPlane(near, cMed, d, n, dirIdx));
    }
  }

  function facesOnPlane(near: PP[], c: number, d: Vec2, n: Vec2, dirIdx: 0 | 1): Face[] {
    const tOf = (p: Vec2) => p.x * d.x + p.y * d.y;
    let tMin = Infinity;
    let tMax = -Infinity;
    const occ = new Map<number, Uint8Array>();
    for (const p of near) {
      if (Math.abs(p.x * n.x + p.y * n.y - c) > 2) continue;
      const t = tOf(p);
      const ti = Math.floor(t / TS);
      const lv = Math.floor((p.z - zLo) / ZS);
      if (lv < 0 || lv >= L) continue;
      let col = occ.get(ti);
      if (!col) occ.set(ti, (col = new Uint8Array(L)));
      col[lv] = OCC;
      tMin = Math.min(tMin, ti);
      tMax = Math.max(tMax, ti);
    }
    if (!Number.isFinite(tMin)) return [];
    // Label every cell: occupied / empty (rays passed) / unknown.
    const i0 = tMin - 30;
    const i1 = tMax + 30;
    const N = i1 - i0 + 1;
    const grid: Uint8Array[] = [];
    const W: boolean[] = [];
    const top: boolean[] = [];
    const empN: number[] = [];
    for (let k = 0; k < N; k++) {
      const ti = i0 + k;
      const src = occ.get(ti);
      const col = new Uint8Array(L);
      const t = (ti + 0.5) * TS;
      let o = 0;
      let e = 0;
      let tp = false;
      for (let lv = 0; lv < L; lv++) {
        if (src && src[lv]) {
          col[lv] = OCC;
          o++;
          if (lv >= topLv) tp = true;
          continue;
        }
        const z = zLo + (lv + 0.5) * ZS;
        const x = n.x * c + d.x * t;
        const y = n.y * c + d.y * t;
        if (free.count(x, y, z) >= 2) {
          col[lv] = EMPTY;
          e++;
        }
      }
      grid.push(col);
      W.push(o >= Math.max(3, L * 0.2));
      top.push(tp);
      empN.push(e);
    }

    // Longest empty run in a column (one unknown cell allowed inside).
    const emptyRun = (col: Uint8Array): [number, number] | null => {
      let best: [number, number] | null = null;
      let s = -1;
      let le = -1;
      let gap = 0;
      const close = () => {
        if (s >= 0 && (!best || le + 1 - s > best[1] - best[0])) best = [s, le + 1];
        s = -1;
        gap = 0;
      };
      for (let lv = 0; lv < L; lv++) {
        const st = col[lv];
        if (st === EMPTY) {
          if (s < 0) s = lv;
          le = lv;
        } else if (st === 0 && s >= 0 && gap === 0) gap = 1;
        else close();
      }
      close();
      return best;
    };

    // Walk the columns into wall spans.
    const out: Face[] = [];
    let k = W.indexOf(true);
    while (k >= 0 && k < N) {
      const start = k;
      let last = k;
      let j = k + 1;
      while (j < N) {
        if (W[j]) {
          last = j;
          j++;
          continue;
        }
        // Gap of non-wall columns: decide whether the wall continues across it.
        let g = j;
        while (g < N && !W[g]) g++;
        if (g >= N) break; // nothing more on this plane
        const width = (g - j) * TS;
        let seen = 0;
        let header = 0;
        for (let q = j; q < g; q++) {
          if (empN[q] >= L * 0.4) seen++;
          if (top[q]) header++;
        }
        const seenThrough = seen >= (g - j) * 0.6;
        const hasHeader = header >= (g - j) * 0.6;
        const bridge = seenThrough ? (hasHeader ? width <= 144 : width <= 72) : width <= 120;
        if (!bridge) break;
        j = g;
      }
      const end = last;
      const len = (end - start + 1) * TS;
      // Openings inside the span: rectangles of empty cells.
      const runs: Array<[number, number] | null> = [];
      for (let q = start; q <= end; q++) runs.push(emptyRun(grid[q]));
      const openings: Face['openings'] = [];
      let q = 0;
      while (q < runs.length) {
        const r = runs[q];
        if (!r || r[1] - r[0] < 4) {
          q++;
          continue;
        }
        let e = q;
        const zbs: number[] = [];
        const zts: number[] = [];
        while (e < runs.length) {
          const rr = runs[e];
          if (!rr || rr[1] - rr[0] < 4) break;
          // Overlaps the opening so far?
          const ov = Math.min(rr[1], r[1]) - Math.max(rr[0], r[0]);
          if (ov < 3) break;
          zbs.push(rr[0]);
          zts.push(rr[1]);
          e++;
        }
        const w = (e - q) * TS;
        if (w >= 16) {
          zbs.sort((a, b) => a - b);
          zts.sort((a, b) => a - b);
          const zb = zLo + zbs[Math.floor(zbs.length / 2)] * ZS;
          const zt = zLo + zts[Math.floor(zts.length / 2)] * ZS;
          // Edge columns are part jamb: the clear opening is about a cell wider.
          openings.push({ t0: (i0 + start + q) * TS - TS / 2, t1: (i0 + start + e) * TS + TS / 2, zb, zt });
        }
        q = e;
      }
      // Wallness: enough wall columns, reaching up near the ceiling.
      let wCols = 0;
      let topCols = 0;
      let occCells = 0;
      let stray = 0; // seen-through cells that aren't part of an opening
      const inOpening = (q2: number, lv: number) => {
        const t = (i0 + q2) * TS;
        const z = zLo + lv * ZS;
        return openings.some((op) => t >= op.t0 && t < op.t1 && z >= op.zb && z < op.zt);
      };
      for (let q2 = start; q2 <= end; q2++) {
        if (W[q2]) {
          wCols++;
          if (top[q2]) topCols++;
        }
        for (let lv = 0; lv < L; lv++) {
          if (grid[q2][lv] === OCC) occCells++;
          else if (grid[q2][lv] === EMPTY && !inOpening(q2, lv)) stray++;
        }
      }
      const cells = (end - start + 1) * L;
      const openCols = openings.reduce((s2, op) => s2 + (op.t1 - op.t0) / TS, 0);
      const solidCols = Math.max(1, end - start + 1 - openCols);
      const coverage = occCells / cells;
      if (
        len >= 24 &&
        wCols >= solidCols * 0.5 &&
        topCols >= wCols * 0.3 &&
        coverage >= 0.2 &&
        stray <= cells * 0.15 &&
        openCols <= (end - start + 1) * 0.6
      ) {
        out.push({
          dirIdx,
          c,
          t0: (i0 + start) * TS,
          t1: (i0 + end + 1) * TS,
          coverage,
          roomSide: 0,
          foundation: false,
          openings,
        });
      }
      // Next span starts at the next wall column after this one.
      k = j < N ? W.indexOf(true, Math.max(j, end + 1)) : -1;
    }

    // Room side and foundation from free space either side of the face.
    for (const f of out) {
      let plus = 0;
      let minus = 0;
      for (let t = f.t0 + 6; t < f.t1; t += 12) {
        for (let z = zLo + 12; z < zHi - 6; z += 12) {
          const base = add(scale(n, c), scale(d, t));
          const pp = add(base, scale(n, 8));
          const pm = add(base, scale(n, -8));
          plus += Math.min(4, free.count(pp.x, pp.y, z));
          minus += Math.min(4, free.count(pm.x, pm.y, z));
        }
      }
      f.roomSide = plus >= minus ? 1 : -1;
      const behind = f.roomSide > 0 ? minus : plus;
      const front = f.roomSide > 0 ? plus : minus;
      f.foundation = behind < front * 0.05;
    }
    return out;
  }

  // Pair the two faces of one partition wall: 3-10" apart, back to back, solid between.
  const walls: FoundWall[] = [];
  const used = new Set<Face>();
  faces.sort((a, b) => (b.t1 - b.t0) * b.coverage - (a.t1 - a.t0) * a.coverage);
  for (const f of faces) {
    if (used.has(f)) continue;
    used.add(f);
    const d = dirs[f.dirIdx];
    const n = { x: -d.y, y: d.x };
    const mate = faces.find((g) => {
      if (used.has(g) || g.dirIdx !== f.dirIdx) return false;
      const gap = Math.abs(g.c - f.c);
      if (gap < 2.5 || gap > 10) return false;
      if (Math.min(g.t1, f.t1) - Math.max(g.t0, f.t0) < 0.4 * Math.min(g.t1 - g.t0, f.t1 - f.t0)) return false;
      // back to back: each face's room is on its outer side
      return Math.sign(g.c - f.c) === g.roomSide && Math.sign(f.c - g.c) === f.roomSide;
    });
    let center: number;
    let thickness: number;
    let t0 = f.t0;
    let t1 = f.t1;
    let foundation = f.foundation;
    let openings = f.openings;
    if (mate) {
      used.add(mate);
      center = (f.c + mate.c) / 2;
      thickness = Math.round(Math.abs(f.c - mate.c) * 2) / 2;
      t0 = Math.min(t0, mate.t0);
      t1 = Math.max(t1, mate.t1);
      foundation = false;
      // Openings seen from either side: merge overlapping ones.
      openings = [...f.openings];
      for (const op of mate.openings) {
        const same = openings.find((x) => Math.min(x.t1, op.t1) - Math.max(x.t0, op.t0) > 0);
        if (same) {
          same.t0 = Math.min(same.t0, op.t0);
          same.t1 = Math.max(same.t1, op.t1);
          same.zb = Math.min(same.zb, op.zb);
          same.zt = Math.max(same.zt, op.zt);
        } else openings.push({ ...op });
      }
    } else {
      thickness = foundation ? o.foundationThickness : o.partitionThickness;
      center = f.c - (f.roomSide * thickness) / 2;
    }
    const at = (cc: number, t: number): Vec2 => add(scale(n, cc), scale(d, t));
    walls.push({
      a: at(center, t0),
      b: at(center, t1),
      thickness,
      foundation,
      n: scale(n, f.roomSide),
      faceA: at(f.c, t0),
      faceB: at(f.c, t1),
      confidence: f.coverage,
      openings: openings.map((op) => classifyOpening(op, at(center, (op.t0 + op.t1) / 2), z0, zHi)),
    });
  }
  return splitSeenThrough(walls, free, z0);
}

/**
 * A wall can't be where you've looked straight through it. Walk each wall's
 * centre line (inside the wall, behind the face you saw) and cut it wherever the
 * depth rays passed through for longer than a wide doorway: that is what stretches
 * a real wall across a room or merges two offset walls into one. Pieces shorter
 * than 2 ft are dropped; openings stay with the piece they sit in.
 */
export function splitSeenThrough(walls: FoundWall[], free: FreeLookup, z0: number, maxGap = 60): FoundWall[] {
  const out: FoundWall[] = [];
  const STEP = 4;
  for (const w of walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const d = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const n = Math.ceil(L / STEP);
    const seen: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * (L / n);
      const x = w.a.x + d.x * t;
      const y = w.a.y + d.y * t;
      let hits = 0;
      for (const z of [24, 40, 56, 72]) if (free.count(x, y, z0 + z) >= 2) hits++;
      seen.push(hits >= 2);
    }
    // Cut at seen-through runs longer than maxGap.
    const keep: Array<[number, number]> = [];
    let s = 0;
    let i = 0;
    while (i < n) {
      if (!seen[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && seen[j]) j++;
      if ((j - i) * (L / n) > maxGap) {
        if (i > s) keep.push([s, i]);
        s = j;
      }
      i = j;
    }
    if (s < n) keep.push([s, n]);
    if (keep.length === 1 && keep[0][0] === 0 && keep[0][1] === n) {
      out.push(w);
      continue;
    }
    for (const [k0, k1] of keep) {
      const t0 = k0 * (L / n);
      const t1 = k1 * (L / n);
      if (t1 - t0 < 24) continue;
      const at = (p: Vec2, t: number): Vec2 => ({ x: p.x + d.x * t, y: p.y + d.y * t });
      const tOf = (p: Vec2) => (p.x - w.a.x) * d.x + (p.y - w.a.y) * d.y;
      out.push({
        ...w,
        a: at(w.a, t0),
        b: at(w.a, t1),
        faceA: at(w.faceA, t0),
        faceB: at(w.faceA, t1),
        openings: w.openings.filter((o) => tOf(o.center) - o.width / 2 >= t0 - 2 && tOf(o.center) + o.width / 2 <= t1 + 2),
      });
    }
  }
  return out;
}

function classifyOpening(op: { t0: number; t1: number; zb: number; zt: number }, center: Vec2, z0: number, zHi: number): FoundOpening {
  const raw = op.t1 - op.t0;
  const bottom = op.zb - z0;
  const topZ = op.zt - z0;
  // Nothing above the gap up to the joists: a full-height opening.
  const toCeiling = op.zt >= zHi - 1;
  const height = toCeiling ? Math.round(zHi + 4 - z0) : Math.round(topZ + 1);
  if (bottom <= 10) {
    if (raw <= 42 && !toCeiling) {
      const width = DOOR_WIDTHS.reduce((b, w) => (Math.abs(w - raw) < Math.abs(b - raw) ? w : b));
      return { center, width, height: Math.max(78, Math.min(height, 84)), sill: 0, type: 'door' };
    }
    return { center, width: Math.round(raw / 2) * 2, height, sill: 0, type: 'opening' };
  }
  const sill = Math.round(bottom - 1);
  return { center, width: Math.round(raw / 2) * 2, height: Math.max(8, Math.round(topZ + 1 - sill)), sill, type: 'window' };
}

