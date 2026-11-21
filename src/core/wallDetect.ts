import { add, dot, scale, type Vec2 } from './geom2d.js';

/** A point in plan space: (x, y) inches on the floor, z inches above it. */
export interface PP {
  x: number;
  y: number;
  z: number;
}

export interface LineFit {
  /** A point on the line (centroid). */
  c: Vec2;
  /** Unit direction along the wall. */
  d: Vec2;
  /** RMS distance of the points from the line, inches. */
  rms: number;
}

/** Total-least-squares line through 2D points (principal axis). */
export function fitLine(pts: Vec2[]): LineFit | null {
  const n = pts.length;
  if (n < 2) return null;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  let e = 0;
  for (const p of pts) {
    const off = -(p.x - cx) * d.y + (p.y - cy) * d.x;
    e += off * off;
  }
  return { c: { x: cx, y: cy }, d, rms: Math.sqrt(e / n) };
}

const across = (p: Vec2, f: LineFit) => -(p.x - f.c.x) * f.d.y + (p.y - f.c.y) * f.d.x;
const along = (p: Vec2, f: LineFit) => dot({ x: p.x - f.c.x, y: p.y - f.c.y }, f.d);

/** Fit with iterative outlier trimming (drops points further than `keep` inches). */
export function robustFit(pts: Vec2[], keep = 2, rounds = 3): { fit: LineFit; inliers: Vec2[] } | null {
  let cur = pts;
  let fit = fitLine(cur);
  for (let i = 0; fit && i < rounds; i++) {
    const tol = Math.max(keep, fit.rms * 2);
    const next = cur.filter((p) => Math.abs(across(p, fit!)) <= tol);
    if (next.length < 2 || next.length === cur.length) break;
    cur = next;
    fit = fitLine(cur);
  }
  return fit ? { fit, inliers: cur } : null;
}

export interface DetectedFace {
  /** Ends of the wall's visible surface, plan inches. */
  a: Vec2;
  b: Vec2;
  /** Unit normal pointing out of the wall toward the viewer. */
  n: Vec2;
  rms: number;
  support: number;
}

/**
 * Wall surface from points swept along it with the pointer (hit-test samples).
 * Needs at least 6" of travel. `eye` decides which side the room is on.
 */
export function faceFromSweep(samples: PP[], eye: Vec2): DetectedFace | null {
  const pts = samples.map((s) => ({ x: s.x, y: s.y }));
  const r = robustFit(pts, 1.5);
  if (!r) return null;
  return faceFromFit(r.fit, r.inliers, eye, 6);
}

/**
 * One-tap wall detection from the room mesh. Starting at the tapped point, fit
 * the wall plane from nearby mesh vertices, then grow along it until the wall
 * ends (a gap wider than `maxGap` inches).
 */
export function detectWallFromMesh(
  vertices: PP[],
  seed: PP,
  eye: Vec2,
  opts: { ceiling?: number; maxGap?: number; band?: number } = {},
): DetectedFace | null {
  const ceiling = opts.ceiling ?? 96;
  const maxGap = opts.maxGap ?? 10;
  const band = opts.band ?? 2;
  // Wall-height vertices only (skip floor and ceiling surfaces).
  const zLo = 6;
  const zHi = Math.max(zLo + 12, ceiling - 6);
  const wallPts: Vec2[] = [];
  for (const v of vertices) if (v.z >= zLo && v.z <= zHi) wallPts.push({ x: v.x, y: v.y });

  // 1. Local plane around the seed.
  const near = wallPts.filter((p) => Math.hypot(p.x - seed.x, p.y - seed.y) <= 18);
  if (near.length < 8) return null;
  const local = robustFit(near, 1.5);
  if (!local || local.fit.rms > 1.5) return null; // not flat here (corner, clutter)
  const fit0 = local.fit;
  if (Math.abs(across(seed, fit0)) > 4) return null;

  // 2. Grow along the line, stopping at gaps.
  const grow = (f: LineFit) => {
    const ts = wallPts
      .filter((p) => Math.abs(across(p, f)) <= band)
      .map((p) => ({ p, t: along(p, f) }))
      .sort((a, b) => a.t - b.t);
    const t0 = along(seed, f);
    let i = ts.findIndex((x) => x.t >= t0);
    if (i < 0) i = ts.length - 1;
    let lo = i;
    let hi = i;
    while (lo > 0 && ts[lo].t - ts[lo - 1].t <= maxGap) lo--;
    while (hi < ts.length - 1 && ts[hi + 1].t - ts[hi].t <= maxGap) hi++;
    return ts.slice(lo, hi + 1).map((x) => x.p);
  };
  let inliers = grow(fit0);
  // 3. Refit on the whole run for accuracy, grow once more.
  const refit = robustFit(inliers, 1.5);
  if (refit && refit.fit.rms <= 2) inliers = grow(refit.fit);
  const final = robustFit(inliers, 1.5);
  if (!final) return null;
  return faceFromFit(final.fit, final.inliers, eye, 12);
}

function faceFromFit(fit: LineFit, inliers: Vec2[], eye: Vec2, minLen: number): DetectedFace | null {
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of inliers) {
    const t = along(p, fit);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  if (!(tMax - tMin >= minLen)) return null;
  const a = add(fit.c, scale(fit.d, tMin));
  const b = add(fit.c, scale(fit.d, tMax));
  let n = { x: -fit.d.y, y: fit.d.x };
  if ((eye.x - fit.c.x) * n.x + (eye.y - fit.c.y) * n.y < 0) n = scale(n, -1);
  return { a, b, n, rms: fit.rms, support: inliers.length };
}

/** Existing-wall centerline: the surface pushed back by half the thickness. */
export function centerlineFromFace(face: DetectedFace, thickness: number): { a: Vec2; b: Vec2 } {
  const back = scale(face.n, -thickness / 2);
  return { a: add(face.a, back), b: add(face.b, back) };
}
