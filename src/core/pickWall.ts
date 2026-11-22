import type { SurfaceIndex } from './fit.js';
import type { Vec2 } from './geom2d.js';

/**
 * Point at a real wall, get the wall. The headset's own hit test runs on live
 * depth and its normals are noisy, so this works on the room mesh instead:
 *  1. the aim ray meets the mesh (nearest surface point facing the ray),
 *  2. a vertical plane is fitted to the mesh patch around that spot (hundreds of
 *     points, not one sample),
 *  3. the plane is followed left and right while the mesh keeps showing it.
 * Plan inches throughout; z is height.
 */

export interface Ray3 {
  o: { x: number; y: number; z: number };
  /** Unit direction. */
  d: { x: number; y: number; z: number };
}

export interface RayHit {
  p: { x: number; y: number; z: number };
  /** Distance along the ray, inches. */
  t: number;
  /** Mesh point index. */
  i: number;
}

/** Why a face ends: a crossing wall (an inside corner), or the mesh stops showing it. */
export type WallEnd = 'corner' | 'unseen';

export interface PickedWall {
  /** Why each end (a, b) is where it is. */
  ends: [WallEnd, WallEnd];
  /** The wall face (the surface you pointed at), from end to end. */
  a: Vec2;
  b: Vec2;
  /** Horizontal unit normal out of the face, toward you. */
  n: Vec2;
  /** Where the ray met the face. */
  hit: { x: number; y: number; z: number };
  /** RMS of the patch points about the fitted face, inches. */
  rms: number;
  points: number;
}

export type PickResult = { wall: PickedWall } | { miss: 'nothing' | 'not-a-wall' | 'too-little' | 'unclear' };

const RAY_R = 2; // inches: mesh points this close to the ray count as hit
const PATCH_R = 24; // inches: patch radius around the hit (horizontal)
const PATCH_DZ = 30; // inches above and below the hit
const ON_FACE = 1.5; // inches: points this close to the face support it
const BIN = 3; // inches: steps when following the face
const MAX_GAP = 24; // inches of unseen face bridged (a door with no header seen)
const MAX_RUN = 600;
const CHUNK = 48;
const CORNER_DEPTH = 18; // inches in front of the face where a crossing wall marks a corner
const CORNER_TALL = 54; // inches of height a crossing wall shows (furniture is lower)
const CORNER_POINTS = 150; // mesh points of it within one 3\" step
const AXIS_SNAP = 12; // degrees: fits this close to the room's square are squared up // inches: never follow a face further than 50'

/** First mesh point along the ray (facing it), or null. */
export function rayHitMesh(idx: SurfaceIndex, ray: Ray3, maxT = 320): RayHit | null {
  const { pos, nrm } = idx.s;
  const { o, d } = ray;
  const step = 24;
  for (let t0 = 0; t0 < maxT; t0 += step) {
    const t1 = Math.min(maxT, t0 + step);
    const a = { x: o.x + d.x * t0, y: o.y + d.y * t0 };
    const b = { x: o.x + d.x * t1, y: o.y + d.y * t1 };
    let best: RayHit | null = null;
    for (const i of idx.near(a, b, RAY_R + 1)) {
      const k = i * 3;
      const vx = pos[k] - o.x;
      const vy = pos[k + 1] - o.y;
      const vz = pos[k + 2] - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 4 || t > maxT) continue;
      if (nrm[k] * d.x + nrm[k + 1] * d.y + nrm[k + 2] * d.z > -0.15) continue; // back side
      const ex = vx - d.x * t;
      const ey = vy - d.y * t;
      const ez = vz - d.z * t;
      if (ex * ex + ey * ey + ez * ez > RAY_R * RAY_R) continue;
      if (!best || t < best.t) best = { p: { x: pos[k], y: pos[k + 1], z: pos[k + 2] }, t, i };
    }
    if (best && best.t <= t1 + RAY_R) return best;
  }
  return null;
}

function mean(xs: number[], ys: number[]): Vec2 {
  let x = 0;
  let y = 0;
  for (let i = 0; i < xs.length; i++) {
    x += xs[i];
    y += ys[i];
  }
  return { x: x / xs.length, y: y / ys.length };
}

const axisCache = new WeakMap<SurfaceIndex, { n: number; ax: number | null }>();

/**
 * The room's main wall direction (radians, modulo 90 degrees) from the mesh normals,
 * or null when no direction stands out (a round room, or too little mesh).
 */
export function roomAxis(idx: SurfaceIndex): number | null {
  const hit = axisCache.get(idx);
  if (hit && hit.n === idx.size) return hit.ax;
  const { nrm } = idx.s;
  const B = 90;
  const hist = new Float64Array(B);
  let total = 0;
  for (let k = 0; k < nrm.length; k += 3) {
    if (Math.abs(nrm[k + 2]) > 0.3) continue;
    let a = (Math.atan2(nrm[k + 1], nrm[k]) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90;
    hist[Math.floor(a) % B]++;
    total++;
  }
  let ax: number | null = null;
  if (total > 500) {
    let best = 0;
    let bi = 0;
    for (let i = 0; i < B; i++) {
      let w = 0;
      for (let d = -2; d <= 2; d++) w += hist[(i + d + B) % B];
      if (w > best) {
        best = w;
        bi = i;
      }
    }
    // Stands out: the 5 degree window holds over twice its even share (5.6%) of wall points.
    if (best > total * 0.12) {
      // Refine on the normals themselves near the peak (4x angle: 90 degree period).
      const peak = ((bi + 0.5) * Math.PI) / 180;
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < nrm.length; k += 3) {
        if (Math.abs(nrm[k + 2]) > 0.3) continue;
        const r = 4 * Math.atan2(nrm[k + 1], nrm[k]);
        const c = Math.cos(r - 4 * peak);
        if (c < Math.cos((4 * 3 * Math.PI) / 180)) continue; // within 3 degrees of the peak
        sx += Math.cos(r);
        sy += Math.sin(r);
      }
      ax = Math.atan2(sy, sx) / 4;
    }
  }
  axisCache.set(idx, { n: idx.size, ax });
  return ax;
}

/** Least-squares line through 2D points: centroid and unit direction. */
function fitLine(xs: number[], ys: number[]): { c: Vec2; u: Vec2 } {
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i];
    cy += ys[i];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: { x: cx, y: cy }, u: { x: Math.cos(ang), y: Math.sin(ang) } };
}

/** The wall face under the ray, fitted to the room mesh and followed to its ends. */
export function pickWall(idx: SurfaceIndex, ray: Ray3): PickResult {
  const hit = rayHitMesh(idx, ray);
  if (!hit) return { miss: 'nothing' };
  const { pos, nrm } = idx.s;
  const h = hit.p;

  // Normal of the spot: average of the mesh normals right around the hit.
  let snx = 0;
  let sny = 0;
  let snz = 0;
  for (const i of idx.near(h, h, 4)) {
    const k = i * 3;
    const dx = pos[k] - h.x;
    const dy = pos[k + 1] - h.y;
    const dz = pos[k + 2] - h.z;
    if (dx * dx + dy * dy + dz * dz > 16) continue;
    snx += nrm[k];
    sny += nrm[k + 1];
    snz += nrm[k + 2];
  }
  const sl = Math.hypot(snx, sny, snz) || 1;
  if (Math.abs(snz / sl) > 0.6) return { miss: 'not-a-wall' };
  const hl = Math.hypot(snx, sny);
  let n: Vec2 = { x: snx / hl, y: sny / hl };

  // Patch: points around the hit that face the same way.
  const px: number[] = [];
  const py: number[] = [];
  for (const i of idx.near(h, h, PATCH_R)) {
    const k = i * 3;
    const dx = pos[k] - h.x;
    const dy = pos[k + 1] - h.y;
    if (dx * dx + dy * dy > PATCH_R * PATCH_R || Math.abs(pos[k + 2] - h.z) > PATCH_DZ) continue;
    if (Math.abs(nrm[k + 2]) > 0.5 || nrm[k] * n.x + nrm[k + 1] * n.y < 0.75) continue;
    px.push(pos[k]);
    py.push(pos[k + 1]);
  }
  if (px.length < 25) return { miss: 'too-little' };

  // Robust fit: the line (2-point samples) with the most patch points within reach,
  // among lines passing near the spot you pointed at. Clutter or a pipe in the
  // patch can't tilt it the way a plain least-squares fit would.
  let rng = 0x2545f491 ^ px.length;
  const rand = (m: number) => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) % m;
  };
  let axisLocked = false;
  let bestN = -1;
  let bestC: Vec2 = { x: 0, y: 0 };
  let bestU: Vec2 = { x: 1, y: 0 };
  const stride = Math.max(1, Math.floor(px.length / 400));
  for (let it = 0; it < 300; it++) {
    const i = rand(px.length);
    const j = rand(px.length);
    const ux = px[j] - px[i];
    const uy = py[j] - py[i];
    const L = Math.hypot(ux, uy);
    if (L < 8) continue;
    const nx = -uy / L;
    const ny = ux / L;
    if (Math.abs(nx * n.x + ny * n.y) < 0.85) continue; // must face roughly the way the mesh does
    if (Math.abs((h.x - px[i]) * nx + (h.y - py[i]) * ny) > 2) continue;
    // Count on an even subsample (a few hundred points rank lines as well as all of them).
    let cnt = 0;
    for (let q = 0; q < px.length; q += stride) if (Math.abs((px[q] - px[i]) * nx + (py[q] - py[i]) * ny) < ON_FACE) cnt += stride;
    if (cnt > bestN) {
      bestN = cnt;
      bestC = { x: px[i], y: py[i] };
      bestU = { x: ux / L, y: uy / L };
    }
  }
  if (bestN < 20) return { miss: 'too-little' };
  // Most rooms are square: if the room's main direction (or its right angle) is close,
  // try the face along it, and keep it unless it explains clearly fewer points.
  const ax = roomAxis(idx);
  if (ax !== null) {
    const ang = Math.atan2(bestU.y, bestU.x);
    const q = Math.PI / 2;
    const snapped = ax + Math.round((ang - ax) / q) * q;
    if (Math.abs(snapped - ang) < (AXIS_SNAP * Math.PI) / 180) {
      const su = { x: Math.cos(snapped), y: Math.sin(snapped) };
      const sn = { x: -su.y, y: su.x };
      // Offset: the densest 1.5" band along that direction, near the spot you pointed at.
      const offs: number[] = [];
      for (let j = 0; j < px.length; j++) offs.push((px[j] - h.x) * sn.x + (py[j] - h.y) * sn.y);
      let bo = 0;
      let bc = -1;
      for (let o = -2; o <= 2; o += 0.25) {
        let cnt = 0;
        for (const v of offs) if (Math.abs(v - o) < ON_FACE) cnt++;
        if (cnt > bc) {
          bc = cnt;
          bo = o;
        }
      }
      if (bc >= 0.6 * bestN) {
        bestC = { x: h.x + sn.x * bo, y: h.y + sn.y * bo };
        bestU = su;
        axisLocked = true;
      }
    }
  }
  let line = { c: bestC, u: bestU };
  let rms = 0;
  let count = 0;
  for (let pass = 0; pass < 2; pass++) {
    const nn = { x: -line.u.y, y: line.u.x };
    const ix: number[] = [];
    const iy: number[] = [];
    let ss = 0;
    for (let j = 0; j < px.length; j++) {
      const off = (px[j] - line.c.x) * nn.x + (py[j] - line.c.y) * nn.y;
      if (Math.abs(off) > (pass ? 1 : ON_FACE)) continue;
      ix.push(px[j]);
      iy.push(py[j]);
      ss += off * off;
    }
    if (ix.length < 20) return { miss: 'too-little' };
    line = axisLocked ? { c: mean(ix, iy), u: line.u } : fitLine(ix, iy);
    rms = Math.sqrt(ss / ix.length);
    count = ix.length;
  }
  // Follow the face, then refit on the whole stretch found (a 10' wall pins its
  // direction far better than a 4' patch), and follow it again.
  let u = line.u;
  let c = line.c;
  const facing = (v: Vec2): Vec2 => {
    const m = { x: -v.y, y: v.x };
    return m.x * n.x + m.y * n.y >= 0 ? m : { x: -m.x, y: -m.y };
  };
  let fn = facing(u);
  let on: Vec2 = { x: 0, y: 0 };
  let e0 = 0;
  let e1 = 0;
  let endA: WallEnd = 'unseen';
  let endB: WallEnd = 'unseen';
  for (let round = 0; ; round++) {
    const off0 = (h.x - c.x) * fn.x + (h.y - c.y) * fn.y;
    on = { x: h.x - fn.x * off0, y: h.y - fn.y * off0 };
    const f1 = refineCorner(idx, on, u, fn, 1, follow(idx, on, u, fn, 1));
    const f0 = refineCorner(idx, on, u, fn, -1, follow(idx, on, u, fn, -1));
    e1 = f1.len;
    e0 = f0.len;
    endB = f1.end;
    endA = f0.end;
    if (round === 2) break;
    const a = { x: on.x - u.x * e0, y: on.y - u.y * e0 };
    const b = { x: on.x + u.x * e1, y: on.y + u.y * e1 };
    const ix: number[] = [];
    const iy: number[] = [];
    let ss = 0;
    for (const i of idx.near(a, b, ON_FACE + 1)) {
      const k = i * 3;
      const dx = pos[k] - on.x;
      const dy = pos[k + 1] - on.y;
      const s = dx * u.x + dy * u.y;
      const off = dx * fn.x + dy * fn.y;
      if (s < -e0 || s > e1 || Math.abs(off) > 1) continue;
      if (!faces(nrm, k, fn)) continue;
      ix.push(pos[k]);
      iy.push(pos[k + 1]);
      ss += off * off;
    }
    if (ix.length < count) break;
    // Squared up, a short stretch keeps the room's direction; a long one is fitted freely
    // (its points all lie within the band along that direction, so it can only refine it,
    // and positions over a long run are more exact than the mesh normals the axis came from).
    const f = axisLocked && e0 + e1 < 48 ? { c: mean(ix, iy), u } : fitLine(ix, iy);
    u = f.u;
    c = f.c;
    fn = facing(u);
    rms = Math.sqrt(ss / ix.length);
    count = ix.length;
  }
  // Off the room's square and short: more likely clutter than a real angled wall.
  if (ax !== null && !axisLocked && e0 + e1 < 48) return { miss: 'unclear' };
  return {
    wall: {
      a: { x: on.x - u.x * e0, y: on.y - u.y * e0 },
      b: { x: on.x + u.x * e1, y: on.y + u.y * e1 },
      n: fn,
      ends: [endA, endB],
      hit: { x: on.x, y: on.y, z: h.z },
      rms,
      points: count,
    },
  };
}

/** A mesh point whose normal is horizontal and close to n. */
function faces(nrm: Float32Array, k: number, n: Vec2): boolean {
  return Math.abs(nrm[k + 2]) <= 0.5 && nrm[k] * n.x + nrm[k + 1] * n.y >= 0.75;
}

/**
 * How far the face (through `on`, along u, facing n) runs in one direction while the
 * mesh shows it. It stops at an inside corner: a crossing wall standing out in front
 * of the face (a door jamb sits inside the wall's thickness instead, so a doorway
 * with its header unseen is bridged).
 */
function follow(idx: SurfaceIndex, on: Vec2, u: Vec2, n: Vec2, dir: 1 | -1): { len: number; end: WallEnd } {
  const { pos, nrm } = idx.s;
  const nb = Math.ceil(MAX_RUN / BIN) + 1;
  const bins = new Uint16Array(nb);
  const cross = new Uint16Array(nb);
  const touch = new Uint16Array(nb);
  const zlo = new Float32Array(nb).fill(1e9);
  const zhi = new Float32Array(nb).fill(-1e9);
  let last = 0;
  let j = 0;
  // Walk out in 4' chunks, so a short wall costs a short query.
  for (let c0 = 0; c0 < MAX_RUN; c0 += CHUNK) {
    const c1 = Math.min(MAX_RUN, c0 + CHUNK);
    const a = { x: on.x + u.x * dir * c0, y: on.y + u.y * dir * c0 };
    const b = { x: on.x + u.x * dir * c1, y: on.y + u.y * dir * c1 };
    for (const i of idx.near(a, b, CORNER_DEPTH + 1)) {
      const k = i * 3;
      const dx = pos[k] - on.x;
      const dy = pos[k + 1] - on.y;
      const s = (dx * u.x + dy * u.y) * dir;
      if (s < c0 || s >= c1) continue;
      const off = dx * n.x + dy * n.y;
      if (Math.abs(nrm[k + 2]) > 0.5) continue;
      const q = Math.floor(s / BIN);
      if (Math.abs(off) <= ON_FACE) {
        if (faces(nrm, k, n)) bins[q]++;
      } else if (off > 2 && off < CORNER_DEPTH && Math.abs(nrm[k] * n.x + nrm[k + 1] * n.y) < 0.3) {
        cross[q]++;
        if (off < 6) touch[q]++;
        zlo[q] = Math.min(zlo[q], pos[k + 2]);
        zhi[q] = Math.max(zhi[q], pos[k + 2]);
      }
    }
    for (; j * BIN < c1 && j < nb; j++) {
      // A crossing wall: touches the face and stands tall (furniture is low, or not against it).
      if (j * BIN > 6 && cross[j] >= CORNER_POINTS && touch[j] >= 15 && zhi[j] - zlo[j] >= CORNER_TALL) return { len: Math.max(last, j * BIN), end: 'corner' };
      if (bins[j] >= 2) last = (j + 1) * BIN;
      else if (j * BIN - last > MAX_GAP) return { len: last, end: 'unseen' };
    }
  }
  return { len: last, end: 'unseen' };
}

/** A Space Setup plane as recorded (plan inches: x, y on the floor, z height). */
export interface SetupPlane {
  label: string;
  polygon: number[][];
}

/**
 * The Space Setup wall under a ray (the headset's own room outline), for spots the
 * room mesh hasn't covered. Its ends are the room's corners.
 */
export function pickSetupWall(planes: SetupPlane[], ray: Ray3): PickedWall | null {
  let best: PickedWall | null = null;
  let bestT = Infinity;
  for (const p of planes) {
    if (p.label !== 'wall' || p.polygon.length < 3) continue;
    let A = p.polygon[0];
    let B = p.polygon[1];
    let L = 0;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const q of p.polygon) {
      z0 = Math.min(z0, q[2]);
      z1 = Math.max(z1, q[2]);
      for (const r of p.polygon) {
        const d = Math.hypot(q[0] - r[0], q[1] - r[1]);
        if (d > L) {
          L = d;
          A = q;
          B = r;
        }
      }
    }
    if (L < 6) continue;
    const u = { x: (B[0] - A[0]) / L, y: (B[1] - A[1]) / L };
    let n = { x: -u.y, y: u.x };
    const dn = ray.d.x * n.x + ray.d.y * n.y;
    if (Math.abs(dn) < 1e-3) continue;
    const t = ((A[0] - ray.o.x) * n.x + (A[1] - ray.o.y) * n.y) / dn;
    if (t <= 0 || t >= bestT) continue;
    const hx = ray.o.x + ray.d.x * t;
    const hy = ray.o.y + ray.d.y * t;
    const hz = ray.o.z + ray.d.z * t;
    const s = (hx - A[0]) * u.x + (hy - A[1]) * u.y;
    if (s < 0 || s > L || hz < z0 || hz > z1) continue;
    if (dn > 0) n = { x: -n.x, y: -n.y }; // face the viewer
    bestT = t;
    best = { a: { x: A[0], y: A[1] }, b: { x: B[0], y: B[1] }, n, ends: ['corner', 'corner'], hit: { x: hx, y: hy, z: hz }, rms: 0, points: 0 };
  }
  return best;
}

/**
 * An inside corner found by following the face sits on a 3" step. Fit the crossing
 * wall's face there and end exactly where the two faces meet (their planes'
 * intersection), when that lands near where the mesh said.
 */
function refineCorner(idx: SurfaceIndex, on: Vec2, u: Vec2, n: Vec2, dir: 1 | -1, f: { len: number; end: WallEnd }): { len: number; end: WallEnd } {
  if (f.end !== 'corner') return f;
  const { pos, nrm } = idx.s;
  // The crossing wall's face looks back along the wall, toward where you pointed.
  const back = { x: -u.x * dir, y: -u.y * dir };
  const e = { x: on.x + u.x * dir * f.len, y: on.y + u.y * dir * f.len };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of idx.near(e, e, CORNER_DEPTH + 2)) {
    const k = i * 3;
    if (Math.abs(nrm[k + 2]) > 0.5 || nrm[k] * back.x + nrm[k + 1] * back.y < 0.75) continue;
    const dx = pos[k] - on.x;
    const dy = pos[k + 1] - on.y;
    const s = (dx * u.x + dy * u.y) * dir;
    const off = dx * n.x + dy * n.y;
    if (s < f.len - 8 || s > f.len + 10 || off < 2 || off > CORNER_DEPTH) continue;
    xs.push(pos[k]);
    ys.push(pos[k + 1]);
  }
  if (xs.length < 30) return f;
  // The face: its offset along the wall, from the densest 1" band, then the mean of that band.
  const st = xs.map((x, i) => ((x - on.x) * u.x + (ys[i] - on.y) * u.y) * dir);
  let bestS = f.len;
  let bestN = 0;
  for (let c = f.len - 8; c <= f.len + 10; c += 0.25) {
    let cnt = 0;
    for (const v of st) if (Math.abs(v - c) < 1) cnt++;
    if (cnt > bestN) {
      bestN = cnt;
      bestS = c;
    }
  }
  const band: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (let i = 0; i < st.length; i++) {
    if (Math.abs(st[i] - bestS) >= 1.5) continue;
    band.push(st[i]);
    bx.push(xs[i]);
    by.push(ys[i]);
  }
  if (band.length < 20) return f;
  // Its direction, freely fitted (an out-of-square corner stays out of square), then
  // where that line meets this face.
  const line = fitLine(bx, by);
  const det = u.x * dir * line.u.y - u.y * dir * line.u.x;
  if (Math.abs(det) < 0.5) return f; // not a crossing wall (within 30 degrees of parallel)
  const wx = line.c.x - on.x;
  const wy = line.c.y - on.y;
  const s = (wx * line.u.y - wy * line.u.x) / det;
  if (!(Math.abs(s - f.len) <= 6) || s < 6) return f;
  return { len: s, end: 'corner' };
}
