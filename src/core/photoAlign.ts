/**
 * Line a camera photo up with the scan. A photo's camera pose comes from the head pose
 * at about the moment it was taken, and on real captures it is often off by 1-5 degrees
 * (timing, rolling shutter, calibration), which smears colors across edges. Like Zhou &
 * Koltun's color map optimization, correct each photo's rotation so its colors agree with
 * what the other photos saw on the same surface points: normalized cross-correlation of
 * gray levels (so exposure differences don't matter), coarse-to-fine search.
 */

export interface PhotoCam {
  /** Camera -> root (column-major; camera looks down -z, y up). */
  camToRoot: Float32Array | number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** Gray image, row 0 = top. */
export interface GrayImage {
  g: Float32Array | Uint8Array;
  w: number;
  h: number;
}

/** Project root-space points into a camera with an extra small rotation (yaw, pitch, roll, radians). */
export function projectInto(cam: PhotoCam, x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): { u: number; v: number; z: number } {
  const M = cam.camToRoot;
  const dx = x - M[12];
  const dy = y - M[13];
  const dz = z - M[14];
  let cx = M[0] * dx + M[1] * dy + M[2] * dz;
  let cy = M[4] * dx + M[5] * dy + M[6] * dz;
  let cz = M[8] * dx + M[9] * dy + M[10] * dz;
  if (yaw) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    [cx, cz] = [c * cx + s * cz, -s * cx + c * cz];
  }
  if (pitch) {
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    [cy, cz] = [c * cy - s * cz, s * cy + c * cz];
  }
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    [cx, cy] = [c * cx - s * cy, s * cx + c * cy];
  }
  const zz = -cz;
  return { z: zz, u: cam.cx + (cam.fx * cx) / zz, v: cam.cy - (cam.fy * cy) / zz };
}

/** The camera with that extra rotation built in (what projectInto applied). */
export function rotatedCam<C extends PhotoCam>(cam: C, yaw: number, pitch: number, roll: number): C {
  // Camera-space rotation R = Rz(roll) * Rx(pitch) * Ry(yaw) applied to root->camera:
  // rootToCam' = R * rootToCam, so camToRoot' = camToRoot * R^T.
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // Ry (as used above: x' = c x + s z, z' = -s x + c z)
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]; // row-major
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const Rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  const R = mul(Rz, mul(Rx, Ry));
  const M = cam.camToRoot;
  // Columns of camToRoot's rotation: camera axes in root. New axes: old axes times R^T.
  const C = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]]; // row-major 3x3 of camToRoot rotation
  const RT = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const N = mul(C, RT);
  const out = Float32Array.from(M as ArrayLike<number>);
  out[0] = N[0];
  out[4] = N[1];
  out[8] = N[2];
  out[1] = N[3];
  out[5] = N[4];
  out[9] = N[5];
  out[2] = N[6];
  out[6] = N[7];
  out[10] = N[8];
  return { ...cam, camToRoot: out };
}

/** Bilinear gray sample, NaN off the image (with a 2 px border). */
export function sampleGray(img: GrayImage, u: number, v: number): number {
  const x = Math.floor(u);
  const y = Math.floor(v);
  if (x < 2 || y < 2 || x >= img.w - 3 || y >= img.h - 3) return NaN;
  const fx = u - x;
  const fy = v - y;
  const i = y * img.w + x;
  const g = img.g;
  return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + img.w] * (1 - fx) * fy + g[i + img.w + 1] * fx * fy;
}

function ncc(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 50) return -1;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb + 1e-9);
}

export interface Alignment {
  yaw: number;
  pitch: number;
  roll: number;
  /** Agreement before and after (normalized cross-correlation, -1..1). */
  before: number;
  after: number;
}

/**
 * The small rotation (within maxDeg) that best lines the photo up with reference gray
 * levels at surface points (xyz, root meters). Points the photo can't see should be left
 * out by the caller. Returns no correction when it doesn't clearly help.
 */
export function alignPhoto(cam: PhotoCam, img: GrayImage, pts: ArrayLike<number>, ref: ArrayLike<number>, maxDeg = 6): Alignment {
  const n = ref.length;
  const D = Math.PI / 180;
  const score = (yaw: number, pitch: number, roll: number) => {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      const q = projectInto(cam, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], yaw * D, pitch * D, roll * D);
      if (!(q.z > 0.1)) continue;
      const g = sampleGray(img, q.u, q.v);
      if (Number.isFinite(g)) {
        a.push(g);
        b.push(ref[i]);
      }
    }
    return ncc(a, b);
  };
  const before = score(0, 0, 0);
  let best = { s: before, yaw: 0, pitch: 0, roll: 0 };
  for (const step of [1, 0.5, 0.25]) {
    for (let guard = 0; guard < 40; guard++) {
      let moved = false;
      for (const [dy, dp, dr] of [
        [step, 0, 0],
        [-step, 0, 0],
        [0, step, 0],
        [0, -step, 0],
        [0, 0, step],
        [0, 0, -step],
      ]) {
        const y = best.yaw + dy;
        const p = best.pitch + dp;
        const r = best.roll + dr;
        if (Math.abs(y) > maxDeg || Math.abs(p) > maxDeg || Math.abs(r) > maxDeg / 2) continue;
        const s = score(y, p, r);
        if (s > best.s + 1e-4) {
          best = { s, yaw: y, pitch: p, roll: r };
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  // Only a clear gain counts (else it's fitting noise).
  if (best.s < before + 0.02) return { yaw: 0, pitch: 0, roll: 0, before, after: before };
  return { yaw: best.yaw * D, pitch: best.pitch * D, roll: best.roll * D, before, after: best.s };
}

/**
 * Line up a set of photos with each other on the scan's surface points (root meters):
 * a few rounds of aligning each photo to the others' mean gray at the points it sees.
 * Returns each photo's corrected camera and how much it agreed before and after.
 */
export function alignPhotos<C extends PhotoCam>(photos: Array<{ cam: C; img: GrayImage }>, pts: Float32Array, rounds = 3): Array<{ cam: C; before: number; after: number }> {
  const N = pts.length / 3;
  const cams = photos.map((p) => p.cam);
  // Which points each photo sees (quarter-size depth buffer; computed once, the
  // corrections are small).
  const vis = photos.map(({ cam, img }) => {
    const ZW = img.w >> 2;
    const ZH = img.h >> 2;
    const zb = new Float32Array(ZW * ZH).fill(Infinity);
    const pr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const q = projectInto(cam, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      pr[i * 3] = q.u;
      pr[i * 3 + 1] = q.v;
      pr[i * 3 + 2] = q.z;
      if (q.z > 0.2 && q.z < 4.5 && q.u >= 8 && q.v >= 8 && q.u < img.w - 8 && q.v < img.h - 8) {
        const k = (q.v >> 2) * ZW + (q.u >> 2);
        if (q.z < zb[k]) zb[k] = q.z;
      }
    }
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      const z = pr[i * 3 + 2];
      const u = pr[i * 3];
      const v = pr[i * 3 + 1];
      if (!(z > 0.2 && z < 4.5) || u < 8 || v < 8 || u >= img.w - 8 || v >= img.h - 8) continue;
      if (z <= zb[(v >> 2) * ZW + (u >> 2)] + 0.05) out.push(i);
    }
    return Int32Array.from(out);
  });
  const result = photos.map((p) => ({ cam: p.cam, before: NaN, after: NaN }));
  for (let round = 0; round < rounds; round++) {
    // Each photo's gray at its points under its current camera, divided by its mean
    // there (exposure differs from shot to shot).
    const sum = new Float32Array(N);
    const cnt = new Uint16Array(N);
    const own = photos.map(({ img }, pi) => {
      const vals = new Float32Array(vis[pi].length).fill(NaN);
      let s = 0;
      let c = 0;
      vis[pi].forEach((i, k) => {
        const q = projectInto(cams[pi], pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
        const g = sampleGray(img, q.u, q.v);
        if (Number.isFinite(g)) {
          vals[k] = g;
          s += g;
          c++;
        }
      });
      const mean = s / Math.max(1, c) || 1;
      for (let k = 0; k < vals.length; k++) vals[k] /= mean;
      vis[pi].forEach((i, k) => {
        if (Number.isFinite(vals[k])) {
          sum[i] += vals[k];
          cnt[i]++;
        }
      });
      return vals;
    });
    photos.forEach(({ img }, pi) => {
      // The others' mean at this photo's points.
      const sel: number[] = [];
      const ref: number[] = [];
      vis[pi].forEach((i, k) => {
        const mine = Number.isFinite(own[pi][k]);
        const c = cnt[i] - (mine ? 1 : 0);
        if (c < 1) return;
        sel.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
        ref.push((sum[i] - (mine ? own[pi][k] : 0)) / c);
      });
      if (ref.length < 500) return;
      // Every other point is plenty for the search.
      const sp: number[] = [];
      const sr: number[] = [];
      for (let k = 0; k < ref.length; k += 2) {
        sp.push(sel[k * 3], sel[k * 3 + 1], sel[k * 3 + 2]);
        sr.push(ref[k]);
      }
      const a = alignPhoto(cams[pi], img, sp, sr, round === 0 ? 6 : 2);
      if (round === 0) result[pi].before = a.before;
      result[pi].after = a.after;
      if (a.yaw || a.pitch || a.roll) cams[pi] = rotatedCam(cams[pi], a.yaw, a.pitch, a.roll);
    });
  }
  return result.map((r, i) => ({ ...r, cam: cams[i] }));
}

/** Points a camera sees (quarter-size depth buffer test), and that buffer. */
function visibleIn(cam: PhotoCam, w: number, h: number, pts: Float32Array): { idx: Int32Array; zb: Float32Array } {
  const N = pts.length / 3;
  const ZW = w >> 2;
  const ZH = h >> 2;
  const zb = new Float32Array(ZW * ZH).fill(Infinity);
  const pr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const q = projectInto(cam, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    pr[i * 3] = q.u;
    pr[i * 3 + 1] = q.v;
    pr[i * 3 + 2] = q.z;
    if (q.z > 0.2 && q.z < 4.5 && q.u >= 8 && q.v >= 8 && q.u < w - 8 && q.v < h - 8) {
      const k = (q.v >> 2) * ZW + (q.u >> 2);
      if (q.z < zb[k]) zb[k] = q.z;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const z = pr[i * 3 + 2];
    const u = pr[i * 3];
    const v = pr[i * 3 + 1];
    if (!(z > 0.2 && z < 4.5) || u < 8 || v < 8 || u >= w - 8 || v >= h - 8) continue;
    if (z <= zb[(v >> 2) * ZW + (u >> 2)] + 0.05) out.push(i);
  }
  return { idx: Int32Array.from(out), zb };
}

interface Kept {
  cam: PhotoCam;
  img: GrayImage;
  zb: Float32Array;
  mean: number;
  /** Camera position and viewing direction (root), to find overlapping photos quickly. */
  at: [number, number, number];
  dir: [number, number, number];
}

/**
 * Live version for a scan in progress: each new photo is lined up with the photos
 * before it (already lined up), as they come in, then kept as a reference for later
 * ones. Errors then don't pile up the way they would against unaligned neighbours.
 */
export class PhotoAligner {
  private kept: Kept[] = [];

  constructor(private maxKept = 120, private neighbours = 8) {}

  get size(): number {
    return this.kept.length;
  }

  clear(): void {
    this.kept = [];
  }

  /** Line up a new photo with the earlier ones on the scan's surface points; keep it. */
  add<C extends PhotoCam>(cam: C, img: GrayImage, pts: Float32Array): { cam: C; before: number; after: number } {
    const M = cam.camToRoot;
    const at: [number, number, number] = [M[12], M[13], M[14]];
    const dir: [number, number, number] = [-M[8], -M[9], -M[10]];
    let result = { cam, before: NaN, after: NaN };
    const { idx } = visibleIn(cam, img.w, img.h, pts);
    // The earlier photos looking at about the same place.
    const near = this.kept
      .map((k) => ({ k, s: (k.dir[0] * dir[0] + k.dir[1] * dir[1] + k.dir[2] * dir[2]) - Math.hypot(k.at[0] - at[0], k.at[1] - at[1], k.at[2] - at[2]) / 6 }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, this.neighbours)
      .map((x) => x.k);
    if (near.length && idx.length > 500) {
      const sel: number[] = [];
      const ref: number[] = [];
      for (let n = 0; n < idx.length; n += 2) {
        const i = idx[n];
        const x = pts[i * 3];
        const y = pts[i * 3 + 1];
        const z = pts[i * 3 + 2];
        let s = 0;
        let c = 0;
        for (const k of near) {
          const q = projectInto(k.cam, x, y, z);
          if (!(q.z > 0.2) || q.u < 8 || q.v < 8 || q.u >= k.img.w - 8 || q.v >= k.img.h - 8) continue;
          if (q.z > k.zb[(q.v >> 2) * (k.img.w >> 2) + (q.u >> 2)] + 0.05) continue; // hidden there
          const g = sampleGray(k.img, q.u, q.v);
          if (!Number.isFinite(g)) continue;
          s += g / k.mean;
          c++;
        }
        if (!c) continue;
        sel.push(x, y, z);
        ref.push(s / c);
      }
      if (ref.length > 300) {
        const a = alignPhoto(cam, img, sel, ref, 6);
        result = { cam: a.yaw || a.pitch || a.roll ? rotatedCam(cam, a.yaw, a.pitch, a.roll) : cam, before: a.before, after: a.after };
      }
    }
    // Keep it (with its own view of the scan, under the corrected camera).
    const fin = result.cam;
    const v = visibleIn(fin, img.w, img.h, pts);
    let s = 0;
    let c = 0;
    for (let n = 0; n < v.idx.length; n += 4) {
      const i = v.idx[n];
      const q = projectInto(fin, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      const g = sampleGray(img, q.u, q.v);
      if (Number.isFinite(g)) {
        s += g;
        c++;
      }
    }
    const F = fin.camToRoot;
    this.kept.push({ cam: fin, img, zb: v.zb, mean: s / Math.max(1, c) || 1, at: [F[12], F[13], F[14]], dir: [-F[8], -F[9], -F[10]] });
    if (this.kept.length > this.maxKept) this.kept.shift();
    return result;
  }
}
