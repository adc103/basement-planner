import type { DepthFrame } from './scanIngest.js';

/**
 * Passthrough camera calibration, worked out from the scan itself.
 *
 * Quest Browser gives the camera image but not where it points. The depth
 * view's pose and projection ARE known, so: find the outlines of things in
 * the depth (where depth jumps: door frames, furniture, shelf edges), and find
 * the edges in the photo. The camera model is whatever lines the depth
 * outlines up with the photo edges best, across every photo at once.
 *
 * Camera model: a pinhole camera with square pixels, rotated (rx, ry, rz) and
 * offset (tx, ty, tz, meters) from the depth view. Images are W x H, y down.
 */

export interface CamModel {
  f: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rz: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface CalibPhoto {
  /** Grayscale, row 0 = top. */
  gray: Uint8Array;
  w: number;
  h: number;
  /** The depth view's pose and projection when the photo was taken. */
  viewToRoot: Float32Array;
  t: number;
}

/** Sobel edges -> distance (pixels) to the nearest strong edge, capped. */
export function edgeDistance(gray: Uint8Array, w: number, h: number, keep = 0.1, cap = 24): Float32Array {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  // Keep the strongest `keep` share as edges.
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(40, sorted[Math.floor(sorted.length * (1 - keep))]);
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = mag[i] >= thr ? 0 : cap;
  // Two-pass chamfer distance (1, sqrt 2).
  const s2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = D[i];
      if (x > 0) d = Math.min(d, D[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, D[i - w] + 1);
        if (x > 0) d = Math.min(d, D[i - w - 1] + s2);
        if (x < w - 1) d = Math.min(d, D[i - w + 1] + s2);
      }
      D[i] = d;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = D[i];
      if (x < w - 1) d = Math.min(d, D[i + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, D[i + w] + 1);
        if (x < w - 1) d = Math.min(d, D[i + w + 1] + s2);
        if (x > 0) d = Math.min(d, D[i + w - 1] + s2);
      }
      D[i] = Math.min(cap, d);
    }
  return D;
}

/** Invert a rigid 4x4 (column-major). */
function invRigid(M: Float32Array | number[]): number[] {
  const r = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
  const t = [M[12], M[13], M[14]];
  // R^T
  const o = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  o[12] = -(o[0] * t[0] + o[4] * t[1] + o[8] * t[2]);
  o[13] = -(o[1] * t[0] + o[5] * t[1] + o[9] * t[2]);
  o[14] = -(o[2] * t[0] + o[6] * t[1] + o[10] * t[2]);
  return o;
}

const mul = (M: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] => [
  M[0] * x + M[4] * y + M[8] * z + M[12],
  M[1] * x + M[5] * y + M[9] * z + M[13],
  M[2] * x + M[6] * y + M[10] * z + M[14],
];

/**
 * Outline points (where depth jumps, on the near side) from depth frames,
 * in the given view's coordinates (meters, -z forward).
 */
export function contourPoints(frames: DepthFrame[], view: Float32Array, maxPoints = 4000): Float32Array {
  const toView = invRigid(view);
  const out: number[] = [];
  for (const f of frames) {
    const W = f.w;
    const H = f.h;
    const P = f.proj;
    const d = (i: number, j: number) => {
      const v = f.depthMM[j * W + i] / 1000;
      return v > 0.3 && v < 6 ? v : 0;
    };
    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const m = d(i, j);
        if (!m) continue;
        // A jump of 12% + 8 cm to any 4-neighbour: this pixel is an outline.
        let edge = false;
        for (const [a, b] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const n = d(i + a, j + b);
          if (n && n > m * 1.12 + 0.08) edge = true;
        }
        if (!edge) continue;
        const ndcX = ((i + 0.5) / W) * 2 - 1;
        const ndcY = ((j + 0.5) / H) * 2 - 1;
        const vx = ((ndcX + P[8]) / P[0]) * m;
        const vy = ((ndcY + P[9]) / P[5]) * m;
        const r = mul(f.viewToRoot, vx, vy, -m);
        const q = mul(toView, r[0], r[1], r[2]);
        if (q[2] < -0.3) out.push(q[0], q[1], q[2]);
      }
    }
  }
  // Even thinning if there are too many.
  const n = out.length / 3;
  if (n <= maxPoints) return new Float32Array(out);
  const step = n / maxPoints;
  const thin: number[] = [];
  for (let k = 0; k < maxPoints; k++) {
    const i = Math.floor(k * step) * 3;
    thin.push(out[i], out[i + 1], out[i + 2]);
  }
  return new Float32Array(thin);
}

/** Rotation matrix (row-major 3x3) from small angles, applied x then y then z. */
function rot(rx: number, ry: number, rz: number): number[] {
  const [a, b, c] = [rx, ry, rz];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // R = Rz * Ry * Rx
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}

/** Project view-space points through the camera model to image pixels (NaN when behind). */
export function projectPoints(m: CamModel, pts: Float32Array, out = new Float32Array((pts.length / 3) * 2)): Float32Array {
  const R = rot(m.rx, m.ry, m.rz);
  for (let k = 0, o = 0; k < pts.length; k += 3, o += 2) {
    const x = pts[k] - m.tx;
    const y = pts[k + 1] - m.ty;
    const z = pts[k + 2] - m.tz;
    const cx = R[0] * x + R[1] * y + R[2] * z;
    const cy = R[3] * x + R[4] * y + R[5] * z;
    const cz = R[6] * x + R[7] * y + R[8] * z;
    if (cz > -0.1) {
      out[o] = out[o + 1] = NaN;
      continue;
    }
    out[o] = m.cx + (m.f * cx) / -cz;
    out[o + 1] = m.cy - (m.f * cy) / -cz;
  }
  return out;
}

export interface CalibSet {
  photos: Array<{ D: Float32Array; w: number; h: number; pts: Float32Array }>;
}

/** Mean edge distance (pixels) of the projected outlines; points off the image count as `cap`. */
export function score(m: CamModel, set: CalibSet, cap = 24): number {
  let s = 0;
  let n = 0;
  for (const ph of set.photos) {
    const uv = projectPoints(m, ph.pts);
    for (let k = 0; k < uv.length; k += 2) {
      const u = uv[k];
      const v = uv[k + 1];
      n++;
      if (!(u >= 0 && v >= 0 && u < ph.w - 1 && v < ph.h - 1)) {
        s += cap;
        continue;
      }
      // Bilinear sample of the distance map.
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const i = y0 * ph.w + x0;
      const D = ph.D;
      s += (D[i] * (1 - fx) + D[i + 1] * fx) * (1 - fy) + (D[i + ph.w] * (1 - fx) + D[i + ph.w + 1] * fx) * fy;
    }
  }
  return n ? s / n : cap;
}

const KEYS: Array<keyof CamModel> = ['f', 'cx', 'cy', 'rx', 'ry', 'rz', 'tx', 'ty', 'tz'];

/** Nelder-Mead over the chosen parameters. */
function nelderMead(fn: (m: CamModel) => number, start: CamModel, keys: Array<keyof CamModel>, steps: Partial<CamModel>, iters = 300): CamModel {
  const n = keys.length;
  const toM = (v: number[]) => {
    const m = { ...start };
    keys.forEach((k, i) => (m[k] = v[i]));
    return m;
  };
  let simplex = [keys.map((k) => start[k])];
  for (let i = 0; i < n; i++) {
    const v = keys.map((k) => start[k]);
    v[i] += steps[keys[i]] ?? 0.01;
    simplex.push(v);
  }
  let vals = simplex.map((v) => fn(toM(v)));
  for (let it = 0; it < iters; it++) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const refl = c.map((x, j) => x + (x - worst[j]));
    const fr = fn(toM(refl));
    if (fr < vals[0]) {
      const exp = c.map((x, j) => x + 2 * (x - worst[j]));
      const fe = fn(toM(exp));
      [simplex[n], vals[n]] = fe < fr ? [exp, fe] : [refl, fr];
    } else if (fr < vals[n - 1]) {
      [simplex[n], vals[n]] = [refl, fr];
    } else {
      const con = c.map((x, j) => x + 0.5 * (worst[j] - x));
      const fc = fn(toM(con));
      if (fc < vals[n]) [simplex[n], vals[n]] = [con, fc];
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j]));
          vals[i] = fn(toM(simplex[i]));
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return toM(simplex[best]);
}

export interface CalibResult {
  model: CamModel;
  /** Mean distance of the outlines to photo edges, pixels (at the photo size). */
  error: number;
  /** The same with no calibration (camera = depth view), for comparison. */
  errorBefore: number;
  photos: number;
}

/** The camera model the depth view itself implies (no offset, same field of view). */
export function viewModel(proj: Float32Array, w: number, h: number): CamModel {
  return { f: (proj[0] * w) / 2, cx: (w / 2) * (1 - proj[8]), cy: (h / 2) * (1 + proj[9]), rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 };
}

/**
 * Solve the camera model from photos and the depth frames around each one.
 * Coarse search over field of view and aim, then Nelder-Mead on everything.
 */
export function calibrate(photos: CalibPhoto[], frames: DepthFrame[], opts: { span?: number } = {}): CalibResult {
  const span = opts.span ?? 0.6; // seconds of depth frames around each photo
  const set: CalibSet = { photos: [] };
  for (const p of photos) {
    const near = frames.filter((f) => Math.abs(f.t - p.t) <= span);
    if (!near.length) continue;
    set.photos.push({ D: edgeDistance(p.gray, p.w, p.h), w: p.w, h: p.h, pts: contourPoints(near, p.viewToRoot, 3000) });
  }
  const w = photos[0]?.w ?? 640;
  const h = photos[0]?.h ?? 480;
  const base = viewModel(frames[0].proj, w, h);
  const errorBefore = score(base, set);
  // Coarse: focal length and aim.
  let best = base;
  let bestS = errorBefore;
  for (const f of [0.6, 0.75, 0.9, 1.05, 1.2, 1.4].map((k) => k * (w / 2))) {
    for (const ry of [-0.15, -0.08, 0, 0.08, 0.15]) {
      for (const rx of [-0.15, -0.08, 0, 0.08, 0.15]) {
        const m = { ...base, f, cx: w / 2, cy: h / 2, rx, ry };
        const s = score(m, set);
        if (s < bestS) [best, bestS] = [m, s];
      }
    }
  }
  // Fine: rotation, focal and center first, then the offset as well.
  let m = nelderMead((x) => score(x, set), best, ['f', 'cx', 'cy', 'rx', 'ry', 'rz'], { f: 20, cx: 10, cy: 10, rx: 0.02, ry: 0.02, rz: 0.02 }, 400);
  m = nelderMead((x) => score(x, set), m, KEYS, { f: 8, cx: 5, cy: 5, rx: 0.01, ry: 0.01, rz: 0.01, tx: 0.02, ty: 0.02, tz: 0.02 }, 600);
  return { model: m, error: score(m, set), errorBefore, photos: set.photos.length };
}

/** The camera's factory calibration as the Quest browser reports it (track settings, with the experimental flags on). */
export interface LensData {
  lensCalibration: number[]; // fx, fy, cx, cy, skew (full-sensor pixels)
  lensRotation: { x: number; y: number; z: number; w: number };
  lensTranslation: { x: number; y: number; z: number };
}

/**
 * Where the passthrough camera is and how it sees, from the lens data and the
 * left eye's pose at the moment the photo was captured. Checked against real
 * captures: depth outlines land on photo edges. The rotation is in the camera's
 * own convention (y down, z forward), turned into the scene's (y up, -z forward).
 */
export function lensCamera(lens: LensData, leftViewToRoot: ArrayLike<number>, w: number, h: number): { camToRoot: Float32Array; fx: number; fy: number; cx: number; cy: number } {
  const [FX, FY, CX, CY] = lens.lensCalibration;
  const k = w / (2 * CX); // centred square sensor, scaled to the delivered width
  const { x, y, z, w: qw } = lens.lensRotation;
  const M = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * qw), 2 * (x * z + y * qw),
    2 * (x * y + z * qw), 1 - 2 * (x * x + z * z), 2 * (y * z - x * qw),
    2 * (x * z - y * qw), 2 * (y * z + x * qw), 1 - 2 * (x * x + y * y),
  ];
  // view -> camera rotation R = F * M with F = diag(1, -1, -1); camera -> view is R^T.
  const R = [M[0], M[1], M[2], -M[3], -M[4], -M[5], -M[6], -M[7], -M[8]];
  const t = [lens.lensTranslation.x, lens.lensTranslation.y, -lens.lensTranslation.z];
  // camToView (column-major): columns are R^T's columns = R's rows.
  const C = [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, t[0], t[1], t[2], 1];
  const V = leftViewToRoot;
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += V[i * 4 + r] * C[c * 4 + i];
    out[c * 4 + r] = s;
  }
  return { camToRoot: out, fx: FX * k, fy: FY * k, cx: w / 2, cy: h / 2 + (CY - CX) * k };
}
