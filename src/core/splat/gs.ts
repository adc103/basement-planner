/**
 * 3D Gaussian splatting, the math (after Kerbl et al. 2023 and gsplat): Gaussians in the
 * scan's frame (meters, y up), projected into a photo's camera, alpha-blended front to
 * back per pixel, and the gradients of an image loss back to each Gaussian's position,
 * size, rotation, color and opacity. This is the CPU reference: the per-pixel part also
 * runs on the GPU (see the trainer); the rest runs here for both.
 */

export const SH_C0 = 0.28209479177387814;
export const TILE = 16;

export interface Gaussians {
  n: number;
  mean: Float32Array; // 3n
  logScale: Float32Array; // 3n
  quat: Float32Array; // 4n, (w, x, y, z)
  fdc: Float32Array; // 3n, color = 0.5 + SH_C0 * fdc
  opacity: Float32Array; // n, logit
}

/** A training camera: root -> camera (column-major, camera looks down -z, y up), lens in this image's pixels. */
export interface SplatCam {
  view: Float32Array | number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export function allocGaussians(n: number): Gaussians {
  return { n, mean: new Float32Array(3 * n), logScale: new Float32Array(3 * n), quat: new Float32Array(4 * n), fdc: new Float32Array(3 * n), opacity: new Float32Array(n) };
}

/** Start from colored points: round Gaussians `size` meters across, mostly opaque. */
export function gaussiansFromPoints(pos: Float32Array, rgb: Uint8Array, size = 0.015, opacity = 0.7): Gaussians {
  const n = pos.length / 3;
  const g = allocGaussians(n);
  g.mean.set(pos);
  g.logScale.fill(Math.log(size));
  const lo = Math.log(opacity / (1 - opacity));
  for (let i = 0; i < n; i++) {
    g.quat[i * 4] = 1;
    g.opacity[i] = lo;
    for (let c = 0; c < 3; c++) g.fdc[i * 3 + c] = (rgb[i * 3 + c] / 255 - 0.5) / SH_C0;
  }
  return g;
}

/** Inverse of a camera-to-root matrix (rigid), as root -> camera. */
export function viewFromCamToRoot(m: ArrayLike<number>): Float32Array {
  const v = new Float32Array(16);
  // R^T
  v[0] = m[0];
  v[1] = m[4];
  v[2] = m[8];
  v[4] = m[1];
  v[5] = m[5];
  v[6] = m[9];
  v[8] = m[2];
  v[9] = m[6];
  v[10] = m[10];
  // -R^T t
  v[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
  v[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
  v[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
  v[15] = 1;
  return v;
}

export function rotFromQuat(q: ArrayLike<number>, o: number, R: Float64Array): number {
  const w = q[o], x = q[o + 1], y = q[o + 2], z = q[o + 3];
  const l = Math.hypot(w, x, y, z) || 1;
  const a = w / l, b = x / l, c = y / l, d = z / l;
  R[0] = 1 - 2 * (c * c + d * d);
  R[1] = 2 * (b * c - a * d);
  R[2] = 2 * (b * d + a * c);
  R[3] = 2 * (b * c + a * d);
  R[4] = 1 - 2 * (b * b + d * d);
  R[5] = 2 * (c * d - a * b);
  R[6] = 2 * (b * d - a * c);
  R[7] = 2 * (c * d + a * b);
  R[8] = 1 - 2 * (b * b + c * c);
  return l;
}

/**
 * A view's Gaussians in screen space (only those in front and on screen): their order
 * in `idx` (into the Gaussians), 2D center, conic (inverse 2D covariance a, b, c),
 * color, opacity, depth, pixel radius. Plus what the backward pass needs.
 */
export interface Projected {
  count: number;
  idx: Uint32Array;
  mean2d: Float32Array; // 2
  conic: Float32Array; // 3
  color: Float32Array; // 3
  alpha: Float32Array; // 1 (sigmoid of opacity)
  depth: Float32Array;
  radius: Float32Array;
  /** 2D covariance before inversion (a, b, c), camera-space point (OpenCV axes: x right, y down, z forward). */
  cov2d: Float32Array;
  pc: Float32Array;
}

const LOWPASS = 0.3;

export function project(g: Gaussians, cam: SplatCam, into?: Projected): Projected {
  const V = cam.view;
  const n = g.n;
  const p = into && into.idx.length >= n ? into : allocProjected(n);
  const { idx, mean2d, conic, color, alpha, depth, radius, cov2d, pc } = p;
  const rc00 = V[0], rc01 = V[4], rc02 = V[8];
  const rc10 = -V[1], rc11 = -V[5], rc12 = -V[9];
  const rc20 = -V[2], rc21 = -V[6], rc22 = -V[10];
  const { fx, fy, w, h } = cam;
  const M = g.mean, LS = g.logScale, Q = g.quat, F = g.fdc, O = g.opacity;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const mx = M[i * 3], my = M[i * 3 + 1], mz = M[i * 3 + 2];
    const x = V[0] * mx + V[4] * my + V[8] * mz + V[12];
    const y = -(V[1] * mx + V[5] * my + V[9] * mz + V[13]);
    const z = -(V[2] * mx + V[6] * my + V[10] * mz + V[14]);
    if (z < 0.1) continue;
    const iz = 1 / z;
    const u = fx * x * iz + cam.cx;
    const v = fy * y * iz + cam.cy;
    // Cheap reject before the covariance: 3 sigma of the largest axis.
    const smax = Math.exp(Math.max(LS[i * 3], LS[i * 3 + 1], LS[i * 3 + 2]));
    const rr = 3 * Math.max(fx, fy) * smax * iz + 2;
    if (u + rr < 0 || v + rr < 0 || u - rr >= w || v - rr >= h) continue;
    let qw = Q[i * 4], qx = Q[i * 4 + 1], qy = Q[i * 4 + 2], qz = Q[i * 4 + 3];
    const ql = 1 / (Math.hypot(qw, qx, qy, qz) || 1);
    qw *= ql; qx *= ql; qy *= ql; qz *= ql;
    const s0 = Math.exp(LS[i * 3]), s1 = Math.exp(LS[i * 3 + 1]), s2 = Math.exp(LS[i * 3 + 2]);
    const m00 = (1 - 2 * (qy * qy + qz * qz)) * s0, m01 = 2 * (qx * qy - qw * qz) * s1, m02 = 2 * (qx * qz + qw * qy) * s2;
    const m10 = 2 * (qx * qy + qw * qz) * s0, m11 = (1 - 2 * (qx * qx + qz * qz)) * s1, m12 = 2 * (qy * qz - qw * qx) * s2;
    const m20 = 2 * (qx * qz - qw * qy) * s0, m21 = 2 * (qy * qz + qw * qx) * s1, m22 = (1 - 2 * (qx * qx + qy * qy)) * s2;
    const S00 = m00 * m00 + m01 * m01 + m02 * m02, S01 = m00 * m10 + m01 * m11 + m02 * m12, S02 = m00 * m20 + m01 * m21 + m02 * m22;
    const S11 = m10 * m10 + m11 * m11 + m12 * m12, S12 = m10 * m20 + m11 * m21 + m12 * m22, S22 = m20 * m20 + m21 * m21 + m22 * m22;
    const j00 = fx * iz, j02 = -fx * x * iz * iz, j11 = fy * iz, j12 = -fy * y * iz * iz;
    const t00 = j00 * rc00 + j02 * rc20, t01 = j00 * rc01 + j02 * rc21, t02 = j00 * rc02 + j02 * rc22;
    const t10 = j11 * rc10 + j12 * rc20, t11 = j11 * rc11 + j12 * rc21, t12 = j11 * rc12 + j12 * rc22;
    const u0 = S00 * t00 + S01 * t01 + S02 * t02, u1 = S01 * t00 + S11 * t01 + S12 * t02, u2 = S02 * t00 + S12 * t01 + S22 * t02;
    const w0 = S00 * t10 + S01 * t11 + S02 * t12, w1 = S01 * t10 + S11 * t11 + S12 * t12, w2 = S02 * t10 + S12 * t11 + S22 * t12;
    const ca = u0 * t00 + u1 * t01 + u2 * t02 + LOWPASS;
    const cb = u0 * t10 + u1 * t11 + u2 * t12;
    const cc = w0 * t10 + w1 * t11 + w2 * t12 + LOWPASS;
    const det = ca * cc - cb * cb;
    if (!(det > 1e-12)) continue;
    const mid = 0.5 * (ca + cc);
    const rad = Math.ceil(3 * Math.sqrt(mid + Math.sqrt(Math.max(0.1, mid * mid - det))));
    if (u + rad < 0 || v + rad < 0 || u - rad >= w || v - rad >= h) continue;
    const id = 1 / det;
    idx[k] = i;
    mean2d[k * 2] = u;
    mean2d[k * 2 + 1] = v;
    conic[k * 3] = cc * id;
    conic[k * 3 + 1] = -cb * id;
    conic[k * 3 + 2] = ca * id;
    cov2d[k * 3] = ca;
    cov2d[k * 3 + 1] = cb;
    cov2d[k * 3 + 2] = cc;
    color[k * 3] = Math.max(0, 0.5 + SH_C0 * F[i * 3]);
    color[k * 3 + 1] = Math.max(0, 0.5 + SH_C0 * F[i * 3 + 1]);
    color[k * 3 + 2] = Math.max(0, 0.5 + SH_C0 * F[i * 3 + 2]);
    alpha[k] = 1 / (1 + Math.exp(-O[i]));
    depth[k] = z;
    radius[k] = rad;
    pc[k * 3] = x;
    pc[k * 3 + 1] = y;
    pc[k * 3 + 2] = z;
    k++;
  }
  p.count = k;
  return p;
}

export function allocProjected(n: number): Projected {
  return {
    count: 0,
    idx: new Uint32Array(n),
    mean2d: new Float32Array(2 * n),
    conic: new Float32Array(3 * n),
    color: new Float32Array(3 * n),
    alpha: new Float32Array(n),
    depth: new Float32Array(n),
    radius: new Float32Array(n),
    cov2d: new Float32Array(3 * n),
    pc: new Float32Array(3 * n),
  };
}

/** Per 16x16 tile, the Gaussians touching it, nearest first: list[ranges[2t] .. ranges[2t+1]). */
export interface Bins {
  tilesX: number;
  tilesY: number;
  ranges: Uint32Array;
  list: Uint32Array;
}

export function binTiles(p: Projected, w: number, h: number): Bins {
  const tx = Math.ceil(w / TILE);
  const ty = Math.ceil(h / TILE);
  const nt = tx * ty;
  // Depth order (front to back): sort by depth.
  // Sort keys: quantized depth above, index below (numeric typed-array sort, no comparator).
  const keys = new Float64Array(p.count);
  for (let i = 0; i < p.count; i++) keys[i] = Math.floor(p.depth[i] * 1e4) * 4194304 + i;
  keys.sort();
  const order = new Uint32Array(p.count);
  for (let i = 0; i < p.count; i++) order[i] = keys[i] % 4194304;
  const counts = new Uint32Array(nt + 1);
  const rect = new Int32Array(4 * p.count);
  for (let k = 0; k < p.count; k++) {
    const u = p.mean2d[k * 2], v = p.mean2d[k * 2 + 1], r = p.radius[k];
    const x0 = Math.max(0, Math.floor((u - r) / TILE)), x1 = Math.min(tx - 1, Math.floor((u + r) / TILE));
    const y0 = Math.max(0, Math.floor((v - r) / TILE)), y1 = Math.min(ty - 1, Math.floor((v + r) / TILE));
    rect[k * 4] = x0;
    rect[k * 4 + 1] = x1;
    rect[k * 4 + 2] = y0;
    rect[k * 4 + 3] = y1;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) counts[yy * tx + xx]++;
  }
  const ranges = new Uint32Array(2 * nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    ranges[2 * t] = total;
    total += counts[t];
    ranges[2 * t + 1] = total;
  }
  const fill = new Uint32Array(nt);
  const list = new Uint32Array(total);
  for (const k of order) {
    for (let yy = rect[k * 4 + 2]; yy <= rect[k * 4 + 3]; yy++) {
      for (let xx = rect[k * 4]; xx <= rect[k * 4 + 1]; xx++) {
        const t = yy * tx + xx;
        list[ranges[2 * t] + fill[t]++] = k;
      }
    }
  }
  return { tilesX: tx, tilesY: ty, ranges, list };
}

/** Per projected Gaussian: d/d(mean2d x, y), d/d(conic a, b, c), d/d(color r, g, b), d/d(alpha). */
export const G2 = 9;

/**
 * Render the view and, with a target image (RGBA bytes, row 0 top), the L1 loss (summed
 * over pixels and channels) and its gradient for each projected Gaussian. CPU reference
 * of the GPU kernel.
 */
export function rasterize(p: Projected, bins: Bins, w: number, h: number, target?: Uint8Array | Uint8ClampedArray): { image: Float32Array; loss: number; grad: Float32Array } {
  const image = new Float32Array(w * h * 3);
  const grad = new Float32Array(p.count * G2);
  let loss = 0;
  const contrib: number[] = [];
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const t = Math.floor(py / TILE) * bins.tilesX + Math.floor(px / TILE);
      const a0 = bins.ranges[2 * t], a1 = bins.ranges[2 * t + 1];
      const fx = px + 0.5, fy = py + 0.5;
      let T = 1;
      let r = 0, gg = 0, b = 0;
      contrib.length = 0;
      for (let s = a0; s < a1; s++) {
        const k = bins.list[s];
        const dx = fx - p.mean2d[k * 2], dy = fy - p.mean2d[k * 2 + 1];
        const ca = p.conic[k * 3], cb = p.conic[k * 3 + 1], cc = p.conic[k * 3 + 2];
        const power = -0.5 * (ca * dx * dx + cc * dy * dy) - cb * dx * dy;
        if (power > 0) continue;
        const al = Math.min(0.99, p.alpha[k] * Math.exp(power));
        if (al < 1 / 255) continue;
        const nT = T * (1 - al);
        if (nT < 1e-4) break;
        r += p.color[k * 3] * al * T;
        gg += p.color[k * 3 + 1] * al * T;
        b += p.color[k * 3 + 2] * al * T;
        contrib.push(s);
        T = nT;
      }
      const o = (py * w + px) * 3;
      image[o] = r;
      image[o + 1] = gg;
      image[o + 2] = b;
      if (!target) continue;
      const q = (py * w + px) * 4;
      const tr = target[q] / 255, tg = target[q + 1] / 255, tb = target[q + 2] / 255;
      loss += Math.abs(r - tr) + Math.abs(gg - tg) + Math.abs(b - tb);
      const dC = [Math.sign(r - tr), Math.sign(gg - tg), Math.sign(b - tb)];
      // Back to front.
      let Tb = T;
      const S = [0, 0, 0];
      for (let c = contrib.length - 1; c >= 0; c--) {
        const k = bins.list[contrib[c]];
        const dx = fx - p.mean2d[k * 2], dy = fy - p.mean2d[k * 2 + 1];
        const ca = p.conic[k * 3], cb = p.conic[k * 3 + 1], cc = p.conic[k * 3 + 2];
        const power = -0.5 * (ca * dx * dx + cc * dy * dy) - cb * dx * dy;
        const gexp = Math.exp(power);
        const al = Math.min(0.99, p.alpha[k] * gexp);
        Tb = Tb / (1 - al);
        const col = [p.color[k * 3], p.color[k * 3 + 1], p.color[k * 3 + 2]];
        // dL/dcolor = T al dC ; dL/dal = T (col - S/(1-al)) . dC ... with S the color behind (weighted).
        let dAl = 0;
        for (let ch = 0; ch < 3; ch++) {
          grad[k * G2 + 5 + ch] += Tb * al * dC[ch];
          dAl += (col[ch] * Tb - S[ch] / (1 - al)) * dC[ch];
          S[ch] += col[ch] * al * Tb;
        }
        if (p.alpha[k] * gexp > 0.99) continue; // clamped: no gradient through it
        // al = alpha * exp(power)
        grad[k * G2 + 8] += gexp * dAl;
        const dPow = al * dAl;
        grad[k * G2 + 0] += dPow * (ca * dx + cb * dy); // d power / d mean2d.x
        grad[k * G2 + 1] += dPow * (cc * dy + cb * dx);
        grad[k * G2 + 2] += dPow * (-0.5 * dx * dx);
        grad[k * G2 + 3] += dPow * (-dx * dy);
        grad[k * G2 + 4] += dPow * (-0.5 * dy * dy);
      }
    }
  }
  return { image, loss, grad };
}

/** Gradients of all parameters, same layout as Gaussians. */
export function zerosLike(g: Gaussians): Gaussians {
  return allocGaussians(g.n);
}

/**
 * Back from screen-space gradients (per projected Gaussian, layout G2) to the Gaussians'
 * own parameters, added into `out`.
 */
export function backwardProject(g: Gaussians, cam: SplatCam, p: Projected, g2: Float32Array | Int32Array, out: Gaussians, scale = 1): void {
  const V = cam.view;
  const rc00 = V[0], rc01 = V[4], rc02 = V[8];
  const rc10 = -V[1], rc11 = -V[5], rc12 = -V[9];
  const rc20 = -V[2], rc21 = -V[6], rc22 = -V[10];
  const { fx, fy } = cam;
  const LS = g.logScale, Q = g.quat, F = g.fdc;
  for (let k = 0; k < p.count; k++) {
    const i = p.idx[k];
    const o = k * G2;
    const dmx = g2[o] * scale, dmy = g2[o + 1] * scale;
    const dA = g2[o + 2] * scale, dB = g2[o + 3] * scale, dCc = g2[o + 4] * scale;
    const dr = g2[o + 5] * scale, dg = g2[o + 6] * scale, db = g2[o + 7] * scale;
    const dal = g2[o + 8] * scale;
    if (!(dmx || dmy || dA || dB || dCc || dr || dg || db || dal)) continue;
    if (0.5 + SH_C0 * F[i * 3] > 0) out.fdc[i * 3] += SH_C0 * dr;
    if (0.5 + SH_C0 * F[i * 3 + 1] > 0) out.fdc[i * 3 + 1] += SH_C0 * dg;
    if (0.5 + SH_C0 * F[i * 3 + 2] > 0) out.fdc[i * 3 + 2] += SH_C0 * db;
    const al = p.alpha[k];
    out.opacity[i] += dal * al * (1 - al);
    // conic = inv(cov): dL/dcov = -conic dL/dconic conic.
    const ca = p.conic[k * 3], cb = p.conic[k * 3 + 1], cc = p.conic[k * 3 + 2];
    const hb = dB / 2;
    const p00 = ca * dA + cb * hb, p01 = ca * hb + cb * dCc, p10 = cb * dA + cc * hb, p11 = cb * hb + cc * dCc;
    const e00 = -(p00 * ca + p01 * cb);
    const e01 = -0.5 * (p00 * cb + p01 * cc + p10 * ca + p11 * cb);
    const e11 = -(p10 * cb + p11 * cc);
    const x = p.pc[k * 3], y = p.pc[k * 3 + 1], z = p.pc[k * 3 + 2];
    const iz = 1 / z;
    const j00 = fx * iz, j02 = -fx * x * iz * iz, j11 = fy * iz, j12 = -fy * y * iz * iz;
    const t00 = j00 * rc00 + j02 * rc20, t01 = j00 * rc01 + j02 * rc21, t02 = j00 * rc02 + j02 * rc22;
    const t10 = j11 * rc10 + j12 * rc20, t11 = j11 * rc11 + j12 * rc21, t12 = j11 * rc12 + j12 * rc22;
    // dS = T^T dCov T
    const a0 = e00 * t00 + e01 * t10, a1 = e00 * t01 + e01 * t11, a2 = e00 * t02 + e01 * t12;
    const b0 = e01 * t00 + e11 * t10, b1 = e01 * t01 + e11 * t11, b2 = e01 * t02 + e11 * t12;
    const d00 = t00 * a0 + t10 * b0, d01 = t00 * a1 + t10 * b1, d02 = t00 * a2 + t10 * b2;
    const d11 = t01 * a1 + t11 * b1, d12 = t01 * a2 + t11 * b2, d22 = t02 * a2 + t12 * b2;
    // Rotation and scale.
    let qw = Q[i * 4], qx = Q[i * 4 + 1], qy = Q[i * 4 + 2], qz = Q[i * 4 + 3];
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
    const s0 = Math.exp(LS[i * 3]), s1 = Math.exp(LS[i * 3 + 1]), s2 = Math.exp(LS[i * 3 + 2]);
    const m00 = r00 * s0, m01 = r01 * s1, m02 = r02 * s2;
    const m10 = r10 * s0, m11 = r11 * s1, m12 = r12 * s2;
    const m20 = r20 * s0, m21 = r21 * s1, m22 = r22 * s2;
    // dM = 2 dS M
    const dm00 = 2 * (d00 * m00 + d01 * m10 + d02 * m20), dm01 = 2 * (d00 * m01 + d01 * m11 + d02 * m21), dm02 = 2 * (d00 * m02 + d01 * m12 + d02 * m22);
    const dm10 = 2 * (d01 * m00 + d11 * m10 + d12 * m20), dm11 = 2 * (d01 * m01 + d11 * m11 + d12 * m21), dm12 = 2 * (d01 * m02 + d11 * m12 + d12 * m22);
    const dm20 = 2 * (d02 * m00 + d12 * m10 + d22 * m20), dm21 = 2 * (d02 * m01 + d12 * m11 + d22 * m21), dm22 = 2 * (d02 * m02 + d12 * m12 + d22 * m22);
    out.logScale[i * 3] += (dm00 * r00 + dm10 * r10 + dm20 * r20) * s0;
    out.logScale[i * 3 + 1] += (dm01 * r01 + dm11 * r11 + dm21 * r21) * s1;
    out.logScale[i * 3 + 2] += (dm02 * r02 + dm12 * r12 + dm22 * r22) * s2;
    const R0 = dm00 * s0, R1 = dm01 * s1, R2 = dm02 * s2, R3 = dm10 * s0, R4 = dm11 * s1, R5 = dm12 * s2, R6 = dm20 * s0, R7 = dm21 * s1, R8 = dm22 * s2;
    const dqw = 2 * (qz * (R3 - R1) + qy * (R2 - R6) + qx * (R7 - R5));
    const dqx = 2 * (qy * (R1 + R3) + qz * (R2 + R6) + qw * (R7 - R5) - 2 * qx * (R4 + R8));
    const dqy = 2 * (qx * (R1 + R3) + qw * (R2 - R6) + qz * (R5 + R7) - 2 * qy * (R0 + R8));
    const dqz = 2 * (qw * (R3 - R1) + qx * (R2 + R6) + qy * (R5 + R7) - 2 * qz * (R0 + R4));
    const dot = dqw * qw + dqx * qx + dqy * qy + dqz * qz;
    out.quat[i * 4] += (dqw - dot * qw) / ql;
    out.quat[i * 4 + 1] += (dqx - dot * qx) / ql;
    out.quat[i * 4 + 2] += (dqy - dot * qy) / ql;
    out.quat[i * 4 + 3] += (dqz - dot * qz) / ql;
    // Mean: the projected center, and J's dependence on the point. dT = 2 dCov T Sigma.
    const S00 = m00 * m00 + m01 * m01 + m02 * m02, S01 = m00 * m10 + m01 * m11 + m02 * m12, S02 = m00 * m20 + m01 * m21 + m02 * m22;
    const S11 = m10 * m10 + m11 * m11 + m12 * m12, S12 = m10 * m20 + m11 * m21 + m12 * m22, S22 = m20 * m20 + m21 * m21 + m22 * m22;
    const u0 = S00 * t00 + S01 * t01 + S02 * t02, u1 = S01 * t00 + S11 * t01 + S12 * t02, u2 = S02 * t00 + S12 * t01 + S22 * t02;
    const w0 = S00 * t10 + S01 * t11 + S02 * t12, w1 = S01 * t10 + S11 * t11 + S12 * t12, w2 = S02 * t10 + S12 * t11 + S22 * t12;
    const dT00 = 2 * (e00 * u0 + e01 * w0), dT01 = 2 * (e00 * u1 + e01 * w1), dT02 = 2 * (e00 * u2 + e01 * w2);
    const dT10 = 2 * (e01 * u0 + e11 * w0), dT11 = 2 * (e01 * u1 + e11 * w1), dT12 = 2 * (e01 * u2 + e11 * w2);
    const dj00 = dT00 * rc00 + dT01 * rc01 + dT02 * rc02;
    const dj02 = dT00 * rc20 + dT01 * rc21 + dT02 * rc22;
    const dj11 = dT10 * rc10 + dT11 * rc11 + dT12 * rc12;
    const dj12 = dT10 * rc20 + dT11 * rc21 + dT12 * rc22;
    const iz2 = iz * iz;
    const dx = fx * iz * dmx - fx * iz2 * dj02;
    const dy = fy * iz * dmy - fy * iz2 * dj12;
    const dz = -fx * x * iz2 * dmx - fy * y * iz2 * dmy - fx * iz2 * dj00 + 2 * fx * x * iz2 * iz * dj02 - fy * iz2 * dj11 + 2 * fy * y * iz2 * iz * dj12;
    out.mean[i * 3] += rc00 * dx + rc10 * dy + rc20 * dz;
    out.mean[i * 3 + 1] += rc01 * dx + rc11 * dy + rc21 * dz;
    out.mean[i * 3 + 2] += rc02 * dx + rc12 * dy + rc22 * dz;
  }
}

/** Adam over all parameters, with a learning rate per kind. */
export class Adam {
  m: Float32Array[];
  v: Float32Array[];
  t = 0;
  constructor(
    private g: Gaussians,
    public lr = { mean: 2e-4, logScale: 5e-3, quat: 1e-3, fdc: 2.5e-3, opacity: 5e-2 },
  ) {
    this.m = this.arrays(g).map((a) => new Float32Array(a.length));
    this.v = this.arrays(g).map((a) => new Float32Array(a.length));
  }
  private arrays(g: Gaussians): Float32Array[] {
    return [g.mean, g.logScale, g.quat, g.fdc, g.opacity];
  }
  /** The same optimizer for `g`, a subset of the old Gaussians (`keep[j]` = old index of new j). */
  remap(g: Gaussians, keep: Uint32Array): Adam {
    const a = new Adam(g, { ...this.lr });
    a.t = this.t;
    const dims = [3, 3, 4, 3, 1];
    for (let k = 0; k < 5; k++) {
      const d = dims[k];
      for (let j = 0; j < keep.length; j++) {
        for (let c = 0; c < d; c++) {
          a.m[k][j * d + c] = this.m[k][keep[j] * d + c];
          a.v[k][j * d + c] = this.v[k][keep[j] * d + c];
        }
      }
    }
    return a;
  }

  step(grad: Gaussians, only?: Uint32Array): void {
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-15;
    const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    const P = this.arrays(this.g);
    const G = this.arrays(grad);
    const lrs = [this.lr.mean, this.lr.logScale, this.lr.quat, this.lr.fdc, this.lr.opacity];
    const dims = [3, 3, 4, 3, 1];
    for (let a = 0; a < 5; a++) {
      const p = P[a], gr = G[a], m = this.m[a], v = this.v[a], lr = lrs[a], d = dims[a];
      const upd = (j: number) => {
        const gj = gr[j];
        m[j] = b1 * m[j] + (1 - b1) * gj;
        v[j] = b2 * v[j] + (1 - b2) * gj * gj;
        p[j] -= (lr * (m[j] / c1)) / (Math.sqrt(v[j] / c2) + eps);
      };
      if (only) {
        for (const i of only) for (let c = 0; c < d; c++) upd(i * d + c);
      } else for (let j = 0; j < p.length; j++) upd(j);
    }
  }
}

/** Standard 3D Gaussian splat PLY (degree-0 color), readable by every splat viewer. */
export function gaussiansPly(g: Gaussians, minOpacity = 0.02): Uint8Array {
  const keep: number[] = [];
  const lo = Math.log(minOpacity / (1 - minOpacity));
  for (let i = 0; i < g.n; i++) if (g.opacity[i] > lo) keep.push(i);
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${keep.length}\n${props.map((q) => `property float ${q}`).join('\n')}\nend_header\n`);
  const stride = props.length * 4;
  const out = new Uint8Array(header.length + keep.length * stride);
  out.set(header);
  const dv = new DataView(out.buffer);
  keep.forEach((i, j) => {
    const o = header.length + j * stride;
    const ql = Math.hypot(g.quat[i * 4], g.quat[i * 4 + 1], g.quat[i * 4 + 2], g.quat[i * 4 + 3]) || 1;
    const v = [
      g.mean[i * 3], g.mean[i * 3 + 1], g.mean[i * 3 + 2], 0, 0, 0,
      g.fdc[i * 3], g.fdc[i * 3 + 1], g.fdc[i * 3 + 2], g.opacity[i],
      g.logScale[i * 3], g.logScale[i * 3 + 1], g.logScale[i * 3 + 2],
      g.quat[i * 4] / ql, g.quat[i * 4 + 1] / ql, g.quat[i * 4 + 2] / ql, g.quat[i * 4 + 3] / ql,
    ];
    for (let k = 0; k < v.length; k++) dv.setFloat32(o + k * 4, v[k], true);
  });
  return out;
}
