import { DEPTH_MAX_M, DEPTH_MIN_M, bodyMask, type DepthFrame } from './scanIngest.js';

/**
 * Depth fusion: a truncated signed distance field (TSDF) in sparse bricks.
 * Each depth frame nudges every voxel near the seen surface toward its signed
 * distance from that surface; averaging many frames cancels sensor noise, and
 * a surface-nets pass turns the zero crossing into a mesh. Same idea as
 * KinectFusion and Quest Lasertag's meshing, sized for an 80x60 depth image.
 *
 * Coordinates are plan-root meters (x, y up, z), like DepthFrame.
 */

export const BRICK = 8; // voxels per brick edge
const B3 = BRICK * BRICK * BRICK;
const OFF = 1024; // brick index offset so keys stay positive

export interface TsdfOptions {
  /** Voxel edge, meters. */
  voxel: number;
  /** Truncation distance in front of a surface, meters. */
  trunc: number;
  /**
   * How far behind a surface a reading still counts, meters. Kept short (just
   * over one voxel) so the two sides of a thin wall don't overwrite each
   * other, which would make 2x4 walls come out fat.
   */
  behind: number;
  /** Weight cap: higher = steadier, slower to forget moved things. */
  maxWeight: number;
  /** Voxels need this much weight to be meshed. */
  minWeight: number;
  /** Brick limit (memory guard): ~3 KB each. */
  maxBricks: number;
}

export const DEFAULT_TSDF: TsdfOptions = { voxel: 0.04, trunc: 0.12, behind: 0.045, maxWeight: 40, minWeight: 2, maxBricks: 60_000 };

interface Brick {
  d: Float32Array; // signed distance / trunc, -1..1
  w: Uint8Array; // weight
  /** Color per voxel (rgb) and how many photos it averages, once a photo has reached it. */
  c?: Uint8Array;
  cw?: Uint8Array;
  /** Texture: per voxel, the photo slot that sees it best (NO_SLOT: none) and how well (1-255). */
  ps?: Uint8Array;
  pq?: Uint8Array;
}

/** Photos kept as textures for the mesh (slots), and "no photo". */
export const PHOTO_SLOTS = 32;
export const NO_SLOT = 255;

/** A camera photo placed in the room: for coloring the mesh. */
export interface ColorPhoto {
  /** RGBA pixels, row 0 = top. */
  rgba: Uint8Array | Uint8ClampedArray;
  w: number;
  h: number;
  /** Camera -> plan-root meters (column-major; camera looks down -z, y up). */
  camToRoot: Float32Array | number[];
  /** Pinhole intrinsics in this image's pixels (y down). */
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface BrickMesh {
  key: number;
  /** xyz per vertex, meters. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** rgb per vertex (0-255), empty when no photo has colored this brick yet. */
  colors: Uint8Array;
  /** Photo slot per vertex to texture it from (NO_SLOT: none); empty when no photo has. */
  photos: Uint8Array;
}

const key = (bx: number, by: number, bz: number) => ((bx + OFF) * 2048 + (by + OFF)) * 2048 + (bz + OFF);
export function brickCoords(k: number): [number, number, number] {
  const bz = (k % 2048) - OFF;
  const r = Math.floor(k / 2048);
  return [Math.floor(r / 2048) - OFF, (r % 2048) - OFF, bz];
}

export class TsdfVolume {
  readonly o: TsdfOptions;
  private bricks = new Map<number, Brick>();
  /** Bricks changed since the last mesh pass. */
  readonly dirty = new Set<number>();
  frames = 0;
  private touched = new Set<number>();

  constructor(opts: Partial<TsdfOptions> = {}) {
    this.o = { ...DEFAULT_TSDF, ...opts };
  }

  get brickCount(): number {
    return this.bricks.size;
  }

  clear(): void {
    this.bricks.clear();
    this.dirty.clear();
    this.frames = 0;
    this.slotUse.fill(0);
  }

  /** Voxels each photo slot is the best view of. */
  private slotUse = new Int32Array(PHOTO_SLOTS);

  /** Signed distance at a global voxel, or NaN where nothing is known. */
  private sdf(gx: number, gy: number, gz: number): number {
    const kx = Math.floor(gx / BRICK);
    const ky = Math.floor(gy / BRICK);
    const kz = Math.floor(gz / BRICK);
    const b = this.bricks.get(key(kx, ky, kz));
    if (!b) return NaN;
    const vi = ((gz - kz * BRICK) * BRICK + (gy - ky * BRICK)) * BRICK + (gx - kx * BRICK);
    return b.w[vi] ? b.d[vi] : NaN;
  }

  private brick(k: number, create: boolean): Brick | undefined {
    let b = this.bricks.get(k);
    if (!b && create && this.bricks.size < this.o.maxBricks) {
      b = { d: new Float32Array(B3).fill(1), w: new Uint8Array(B3) };
      this.bricks.set(k, b);
    }
    return b;
  }

  /** Fuse one depth frame. Returns the number of bricks updated. */
  integrate(f: DepthFrame): number {
    const { voxel: vs, trunc } = this.o;
    const bs = vs * BRICK;
    const M = f.viewToRoot;
    const P = f.proj;
    const W = f.w;
    const H = f.h;
    // Depth in meters with your body and arms masked out (0 = no reading).
    const depth = new Float32Array(W * H);
    const mask = bodyMask(f);
    const touched = this.touched;
    touched.clear();
    const mark = (x: number, y: number, z: number) => touched.add(key(Math.floor(x / bs), Math.floor(y / bs), Math.floor(z / bs)));
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const idx = j * W + i;
        const m = f.depthMM[idx] / 1000;
        if (m < DEPTH_MIN_M || m > DEPTH_MAX_M || mask[idx]) continue;
        depth[idx] = m;
        // The surface point and the band around it along the ray.
        const ndcX = ((i + 0.5) / W) * 2 - 1;
        const ndcY = ((j + 0.5) / H) * 2 - 1;
        const vx = (ndcX + P[8]) / P[0];
        const vy = (ndcY + P[9]) / P[5];
        for (const s of [m - trunc, m, m + this.o.behind]) {
          if (s <= 0) continue;
          const px = vx * s;
          const py = vy * s;
          const pz = -s;
          mark(M[0] * px + M[4] * py + M[8] * pz + M[12], M[1] * px + M[5] * py + M[9] * pz + M[13], M[2] * px + M[6] * py + M[10] * pz + M[14]);
        }
      }
    }
    // Root -> view: transpose the rotation (rigid transform).
    const tx = M[12];
    const ty = M[13];
    const tz = M[14];
    const r00 = M[0], r01 = M[1], r02 = M[2];
    const r10 = M[4], r11 = M[5], r12 = M[6];
    const r20 = M[8], r21 = M[9], r22 = M[10];
    const { maxWeight } = this.o;
    let updated = 0;
    for (const k of touched) {
      const b = this.brick(k, true);
      if (!b) continue;
      const [bx, by, bz] = brickCoords(k);
      let any = false;
      for (let z = 0; z < BRICK; z++) {
        for (let y = 0; y < BRICK; y++) {
          for (let x = 0; x < BRICK; x++) {
            const cx = (bx * BRICK + x + 0.5) * vs - tx;
            const cy = (by * BRICK + y + 0.5) * vs - ty;
            const cz = (bz * BRICK + z + 0.5) * vs - tz;
            const vz = r20 * cx + r21 * cy + r22 * cz;
            const dist = -vz;
            if (dist < DEPTH_MIN_M * 0.5) continue;
            const vx = r00 * cx + r01 * cy + r02 * cz;
            const vy = r10 * cx + r11 * cy + r12 * cz;
            const ndcX = (vx * P[0]) / dist - P[8];
            const ndcY = (vy * P[5]) / dist - P[9];
            const pi = Math.floor(((ndcX + 1) / 2) * W);
            const pj = Math.floor(((ndcY + 1) / 2) * H);
            if (pi < 0 || pj < 0 || pi >= W || pj >= H) continue;
            const m = depth[pj * W + pi];
            if (!m) continue;
            const sdf = m - dist;
            // Hidden behind the surface. Readings a little further back are
            // clamped rather than dropped, so slanted views don't pull the
            // surface into the wall; far enough back, the other side of a thin
            // wall is left alone.
            const back = this.o.behind;
            if (sdf < -2 * back) continue;
            const t = Math.min(1, Math.max(sdf, -back) / trunc);
            const vi = (z * BRICK + y) * BRICK + x;
            const w = b.w[vi];
            b.d[vi] = (b.d[vi] * w + t) / (w + 1);
            if (w < maxWeight) b.w[vi] = w + 1;
            any = true;
          }
        }
      }
      if (any) {
        this.dirty.add(k);
        updated++;
      }
    }
    this.frames++;
    return updated;
  }

  /**
   * Paint the surface voxels a photo can see with its colors. Hidden surfaces
   * are left alone: a quarter-resolution depth buffer of the projected surface
   * keeps only the nearest surface at each pixel. Colors average over photos.
   * Returns the number of bricks colored (they are marked for re-meshing).
   */
  /** The slot the last colorize() put its photo in (to upload as a texture), or null. */
  lastSlot: number | null = null;
  /**
   * RGB gains for that photo: the camera's exposure and white balance change from shot to
   * shot, so a wall looks warm in one photo and cool in the next. Scaling each photo to
   * the colors all photos agree on keeps neighbouring triangles from different photos
   * the same color (a simple form of Waechter et al.'s seam leveling).
   */
  lastGain: [number, number, number] = [1, 1, 1];

  colorize(ph: ColorPhoto, maxDist = 4.5, texture = false): number {
    this.lastSlot = null;
    const { voxel: vs, minWeight } = this.o;
    const M = ph.camToRoot;
    const tx = M[12], ty = M[13], tz = M[14];
    const r00 = M[0], r01 = M[1], r02 = M[2];
    const r10 = M[4], r11 = M[5], r12 = M[6];
    const r20 = M[8], r21 = M[9], r22 = M[10];
    const ZW = Math.ceil(ph.w / 4);
    const ZH = Math.ceil(ph.h / 4);
    const zb = new Float32Array(ZW * ZH).fill(Infinity);
    const bs = vs * BRICK;
    const hits: Array<{ b: Brick; k: number; vi: number; u: number; v: number; z: number }> = [];
    for (const [k, b] of this.bricks) {
      const [bx, by, bz] = brickCoords(k);
      // Quick reject: brick centre well outside the view.
      {
        const cx = (bx + 0.5) * bs - tx, cy = (by + 0.5) * bs - ty, cz = (bz + 0.5) * bs - tz;
        const z = -(r20 * cx + r21 * cy + r22 * cz);
        if (z < 0.15 - bs || z > maxDist + bs) continue;
        const u = ph.cx + (ph.fx * (r00 * cx + r01 * cy + r02 * cz)) / Math.max(z, 0.05);
        const v = ph.cy - (ph.fy * (r10 * cx + r11 * cy + r12 * cz)) / Math.max(z, 0.05);
        const m = (ph.fx * bs) / Math.max(z, 0.05);
        if (u < -m || v < -m || u > ph.w + m || v > ph.h + m) continue;
      }
      for (let vi = 0; vi < B3; vi++) {
        if (b.w[vi] < minWeight || Math.abs(b.d[vi]) > 0.5) continue;
        const x = vi % BRICK;
        const y = Math.floor(vi / BRICK) % BRICK;
        const zz = Math.floor(vi / (BRICK * BRICK));
        const cx = (bx * BRICK + x + 0.5) * vs - tx;
        const cy = (by * BRICK + y + 0.5) * vs - ty;
        const cz = (bz * BRICK + zz + 0.5) * vs - tz;
        const z = -(r20 * cx + r21 * cy + r22 * cz);
        if (z < 0.15 || z > maxDist) continue;
        const u = ph.cx + (ph.fx * (r00 * cx + r01 * cy + r02 * cz)) / z;
        const v = ph.cy - (ph.fy * (r10 * cx + r11 * cy + r12 * cz)) / z;
        if (u < 0 || v < 0 || u >= ph.w || v >= ph.h) continue;
        const zi = (v >> 2) * ZW + (u >> 2);
        if (z < zb[zi]) zb[zi] = z;
        hits.push({ b, k, vi, u, v, z });
      }
    }
    const colored = new Set<number>();
    const seen: typeof hits = [];
    for (const h of hits) {
      if (h.z > zb[(h.v >> 2) * ZW + (h.u >> 2)] + 0.06) continue; // behind something nearer
      seen.push(h);
      const b = h.b;
      if (!b.c) {
        b.c = new Uint8Array(B3 * 3);
        b.cw = new Uint8Array(B3);
      }
      const p = ((h.v | 0) * ph.w + (h.u | 0)) * 4;
      const n = b.cw![h.vi];
      const o = h.vi * 3;
      for (let ch = 0; ch < 3; ch++) b.c[o + ch] = Math.round((b.c[o + ch] * n + ph.rgba[p + ch]) / (n + 1));
      if (n < 20) b.cw![h.vi] = n + 1;
      colored.add(h.k);
    }
    if (texture) this.placePhoto(ph, seen, colored);
    for (const k of colored) this.dirty.add(k);
    return colored.size;
  }

  /**
   * Keep the photo as a texture where it is the best view yet: seen square-on, close,
   * near the middle of the picture (Waechter et al.'s view selection, per voxel). It
   * takes a free slot, or the one that is best for the fewest voxels, if it improves
   * more than that one holds.
   */
  private placePhoto(ph: ColorPhoto, seen: Array<{ b: Brick; k: number; vi: number; u: number; v: number; z: number }>, colored: Set<number>): void {
    const M = ph.camToRoot;
    const vs = this.o.voxel;
    const better: Array<{ b: Brick; k: number; vi: number; q: number }> = [];
    const sumP = [0, 0, 0];
    const sumA = [0, 0, 0];
    const rx = ph.w / 2;
    const ry = ph.h / 2;
    for (const h of seen) {
      const [bx, by, bz] = brickCoords(h.k);
      const x = h.vi % BRICK;
      const y = Math.floor(h.vi / BRICK) % BRICK;
      const zz = Math.floor(h.vi / (BRICK * BRICK));
      const gx = bx * BRICK + x;
      const gy = by * BRICK + y;
      const gz = bz * BRICK + zz;
      // Surface normal (toward free space) from the distance field around the voxel.
      const nx = this.sdf(gx + 1, gy, gz) - this.sdf(gx - 1, gy, gz);
      const ny = this.sdf(gx, gy + 1, gz) - this.sdf(gx, gy - 1, gz);
      const nz = this.sdf(gx, gy, gz + 1) - this.sdf(gx, gy, gz - 1);
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 1e-6)) continue;
      // Toward the camera.
      const px = (gx + 0.5) * vs;
      const py = (gy + 0.5) * vs;
      const pz = (gz + 0.5) * vs;
      const dx = M[12] - px;
      const dy = M[13] - py;
      const dz = M[14] - pz;
      const dl = Math.hypot(dx, dy, dz);
      const cos = (nx * dx + ny * dy + nz * dz) / (nl * dl);
      if (cos < 0.3) continue;
      const r2 = ((h.u - ph.cx) / rx) ** 2 + ((h.v - ph.cy) / ry) ** 2;
      const score = cos * cos * Math.min(1, 1.2 / h.z) * Math.max(0.2, 1 - 0.4 * r2);
      const q = Math.max(1, Math.min(255, Math.round(score * 255)));
      const b = h.b;
      // Photo-consistency: where this photo disagrees with what the other photos saw there
      // (averaged), it's likely looking at something else (an edge in front, a misplaced
      // frame from fast head motion): don't texture from it.
      if (b.c && b.cw && b.cw[h.vi] >= 2) {
        const pp = ((h.v | 0) * ph.w + (h.u | 0)) * 4;
        const o = h.vi * 3;
        const diff = Math.abs(ph.rgba[pp] - b.c[o]) + Math.abs(ph.rgba[pp + 1] - b.c[o + 1]) + Math.abs(ph.rgba[pp + 2] - b.c[o + 2]);
        if (diff > 75) continue;
        for (let ch = 0; ch < 3; ch++) {
          sumP[ch] += ph.rgba[pp + ch];
          sumA[ch] += b.c[o + ch];
        }
      }
      const cur = b.pq ? b.pq[h.vi] : 0;
      if (q > cur * 1.1 + 3) better.push({ b, k: h.k, vi: h.vi, q });
    }
    if (better.length < 150) return;
    let slot = -1;
    let least = Infinity;
    for (let i = 0; i < PHOTO_SLOTS; i++) {
      if (this.slotUse[i] < least) {
        least = this.slotUse[i];
        slot = i;
      }
    }
    if (least >= better.length) return; // every slot is worth more than this photo would add
    if (least > 0) {
      // Free the slot: its voxels fall back to their averaged color until a photo covers them.
      for (const [k, b] of this.bricks) {
        if (!b.ps) continue;
        let hit = false;
        for (let vi = 0; vi < B3; vi++) {
          if (b.ps[vi] !== slot) continue;
          b.ps[vi] = NO_SLOT;
          b.pq![vi] = 0;
          hit = true;
        }
        if (hit) this.dirty.add(k);
      }
      this.slotUse[slot] = 0;
    }
    for (const t of better) {
      const b = t.b;
      if (!b.ps) {
        b.ps = new Uint8Array(B3).fill(NO_SLOT);
        b.pq = new Uint8Array(B3);
      }
      const old = b.ps[t.vi];
      if (old !== NO_SLOT) this.slotUse[old]--;
      b.ps[t.vi] = slot;
      b.pq![t.vi] = t.q;
      this.slotUse[slot]++;
      colored.add(t.k);
      this.dirty.add(t.k);
    }
    this.lastSlot = slot;
    const g = [0, 1, 2].map((ch) => (sumP[ch] > 1000 ? Math.max(0.6, Math.min(1.6, sumA[ch] / sumP[ch])) : 1));
    this.lastGain = [g[0], g[1], g[2]];
  }

  /** Signed distance (fraction of trunc) and weight at a global voxel. */
  sample(gx: number, gy: number, gz: number): { d: number; w: number } {
    const bx = Math.floor(gx / BRICK);
    const by = Math.floor(gy / BRICK);
    const bz = Math.floor(gz / BRICK);
    const b = this.bricks.get(key(bx, by, bz));
    if (!b) return { d: 1, w: 0 };
    const vi = ((gz - bz * BRICK) * BRICK + (gy - by * BRICK)) * BRICK + (gx - bx * BRICK);
    return { d: b.d[vi], w: b.w[vi] };
  }

  /** Mesh the dirty bricks (and clear them). Bricks with no surface come back empty. */
  meshDirty(): BrickMesh[] {
    const out: BrickMesh[] = [];
    for (const k of this.dirty) out.push(this.meshBrick(k));
    this.dirty.clear();
    return out;
  }

  /** Mesh every brick (e.g. after loading). */
  meshAll(): BrickMesh[] {
    for (const k of this.bricks.keys()) this.dirty.add(k);
    return this.meshDirty();
  }

  /**
   * Surface nets for one brick. Cells span voxel centers; a cell with a sign
   * change gets one vertex (mean of its edge crossings), and every voxel edge
   * the surface crosses becomes a quad between the four cells around it.
   */
  meshBrick(k: number): BrickMesh {
    const [bx, by, bz] = brickCoords(k);
    const { voxel: vs, minWeight } = this.o;
    const N = BRICK + 3; // local grid -1 .. BRICK+1
    const D = new Float32Array(N * N * N).fill(1);
    const Wt = new Uint8Array(N * N * N);
    const Cc = new Uint8Array(N * N * N * 3);
    const Cw = new Uint8Array(N * N * N);
    const Ps = new Uint8Array(N * N * N).fill(NO_SLOT);
    const Pq = new Uint8Array(N * N * N);
    let anyColor = false;
    let anyPhoto = false;
    const li = (x: number, y: number, z: number) => ((z + 1) * N + (y + 1)) * N + (x + 1);
    // Gather this brick and its neighbours' edge voxels.
    const nb = new Map<number, Brick | undefined>();
    for (let z = -1; z <= BRICK + 1; z++) {
      for (let y = -1; y <= BRICK + 1; y++) {
        for (let x = -1; x <= BRICK + 1; x++) {
          const gx = bx * BRICK + x;
          const gy = by * BRICK + y;
          const gz = bz * BRICK + z;
          const kx = Math.floor(gx / BRICK);
          const ky = Math.floor(gy / BRICK);
          const kz = Math.floor(gz / BRICK);
          const kk = key(kx, ky, kz);
          let b = nb.get(kk);
          if (b === undefined && !nb.has(kk)) {
            b = this.bricks.get(kk);
            nb.set(kk, b);
          }
          if (!b) continue;
          const vi = ((gz - kz * BRICK) * BRICK + (gy - ky * BRICK)) * BRICK + (gx - kx * BRICK);
          const l = li(x, y, z);
          D[l] = b.d[vi];
          Wt[l] = b.w[vi];
          if (b.cw && b.cw[vi]) {
            Cw[l] = b.cw[vi];
            Cc[l * 3] = b.c![vi * 3];
            Cc[l * 3 + 1] = b.c![vi * 3 + 1];
            Cc[l * 3 + 2] = b.c![vi * 3 + 2];
            anyColor = true;
          }
          if (b.ps && b.ps[vi] !== NO_SLOT) {
            Ps[l] = b.ps[vi];
            Pq[l] = b.pq![vi];
            anyPhoto = true;
          }
        }
      }
    }
    const ok = (l: number) => Wt[l] >= minWeight;
    // Cells -1..BRICK-1 (corner at x..x+1); vertex index per cell.
    const C = BRICK + 1;
    const ci = (x: number, y: number, z: number) => ((z + 1) * C + (y + 1)) * C + (x + 1);
    const cellV = new Int32Array(C * C * C).fill(-1);
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const pho: number[] = [];
    const corner = new Float32Array(8);
    for (let z = -1; z < BRICK; z++) {
      for (let y = -1; y < BRICK; y++) {
        for (let x = -1; x < BRICK; x++) {
          let neg = 0;
          let valid = true;
          for (let c = 0; c < 8; c++) {
            const l = li(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
            if (!ok(l)) {
              valid = false;
              break;
            }
            corner[c] = D[l];
            if (D[l] < 0) neg++;
          }
          if (!valid || neg === 0 || neg === 8) continue;
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let n = 0;
          for (let c = 0; c < 8; c++) {
            for (const bit of [1, 2, 4]) {
              if (c & bit) continue;
              const a = corner[c];
              const b = corner[c | bit];
              if (a < 0 === b < 0) continue;
              // Skip fake crossings between two saturated (far) values.
              if (Math.abs(a) > 0.99 && Math.abs(b) > 0.99) continue;
              const t = a / (a - b);
              sx += (c & 1) + (bit === 1 ? t : 0);
              sy += ((c >> 1) & 1) + (bit === 2 ? t : 0);
              sz += ((c >> 2) & 1) + (bit === 4 ? t : 0);
              n++;
            }
          }
          if (!n) continue;
          cellV[ci(x, y, z)] = pos.length / 3;
          // Voxel centers sit at (g + 0.5) * vs.
          pos.push((bx * BRICK + x + 0.5 + sx / n) * vs, (by * BRICK + y + 0.5 + sy / n) * vs, (bz * BRICK + z + 0.5 + sz / n) * vs);
          // Normal: gradient of the field, toward free space.
          const gxv = corner[1] + corner[3] + corner[5] + corner[7] - corner[0] - corner[2] - corner[4] - corner[6];
          const gyv = corner[2] + corner[3] + corner[6] + corner[7] - corner[0] - corner[1] - corner[4] - corner[5];
          const gzv = corner[4] + corner[5] + corner[6] + corner[7] - corner[0] - corner[1] - corner[2] - corner[3];
          const gl = Math.hypot(gxv, gyv, gzv) || 1;
          nrm.push(gxv / gl, gyv / gl, gzv / gl);
          if (anyColor) {
            // The cell's colored corners, averaged; grey where no photo has reached.
            let r = 0, g = 0, bl = 0, cn = 0;
            for (let c = 0; c < 8; c++) {
              const l = li(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
              const wgt = Cw[l];
              if (!wgt) continue;
              r += Cc[l * 3] * wgt;
              g += Cc[l * 3 + 1] * wgt;
              bl += Cc[l * 3 + 2] * wgt;
              cn += wgt;
            }
            if (cn) col.push(Math.round(r / cn), Math.round(g / cn), Math.round(bl / cn));
            else col.push(128, 128, 128);
          }
          if (anyPhoto) {
            // The photo that sees this cell's corners best.
            let bestQ = 0;
            let bestS = NO_SLOT;
            for (let c = 0; c < 8; c++) {
              const l = li(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
              if (Ps[l] !== NO_SLOT && Pq[l] > bestQ) {
                bestQ = Pq[l];
                bestS = Ps[l];
              }
            }
            pho.push(bestS);
          }
        }
      }
    }
    // Quads: edges from voxel v (owned by this brick) to v + axis.
    const idx: number[] = [];
    const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    };
    for (let z = 0; z < BRICK; z++) {
      for (let y = 0; y < BRICK; y++) {
        for (let x = 0; x < BRICK; x++) {
          const l0 = li(x, y, z);
          if (!ok(l0)) continue;
          const d0 = D[l0];
          // +x edge: cells around it differ in y, z.
          {
            const l1 = li(x + 1, y, z);
            if (ok(l1) && d0 < 0 !== D[l1] < 0 && !(Math.abs(d0) > 0.99 && Math.abs(D[l1]) > 0.99))
              quad(cellV[ci(x, y - 1, z - 1)], cellV[ci(x, y, z - 1)], cellV[ci(x, y, z)], cellV[ci(x, y - 1, z)], d0 < 0);
          }
          {
            const l1 = li(x, y + 1, z);
            if (ok(l1) && d0 < 0 !== D[l1] < 0 && !(Math.abs(d0) > 0.99 && Math.abs(D[l1]) > 0.99))
              quad(cellV[ci(x - 1, y, z - 1)], cellV[ci(x - 1, y, z)], cellV[ci(x, y, z)], cellV[ci(x, y, z - 1)], d0 < 0);
          }
          {
            const l1 = li(x, y, z + 1);
            if (ok(l1) && d0 < 0 !== D[l1] < 0 && !(Math.abs(d0) > 0.99 && Math.abs(D[l1]) > 0.99))
              quad(cellV[ci(x - 1, y - 1, z)], cellV[ci(x, y - 1, z)], cellV[ci(x, y, z)], cellV[ci(x - 1, y, z)], d0 < 0);
          }
        }
      }
    }
    return { key: k, positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), colors: new Uint8Array(col), photos: new Uint8Array(pho) };
  }

  // --- Saving -------------------------------------------------------------------
  // [f32 voxel, f32 trunc, u32 count] then per brick: f64 key, 512 f32 d, 512 u8 w.

  serialize(): Uint8Array {
    const per = 8 + B3 * 4 + B3;
    // Photo colors follow as an optional section: u32 count, then per brick f64 key, rgb, weights.
    const colored = [...this.bricks].filter(([, b]) => b.c);
    const cper = 8 + B3 * 4;
    const out = new Uint8Array(12 + this.bricks.size * per + 4 + colored.length * cper);
    const dv = new DataView(out.buffer);
    dv.setFloat32(0, this.o.voxel, true);
    dv.setFloat32(4, this.o.trunc, true);
    dv.setUint32(8, this.bricks.size, true);
    let o = 12;
    for (const [k, b] of this.bricks) {
      dv.setFloat64(o, k, true);
      out.set(new Uint8Array(b.d.buffer, b.d.byteOffset, B3 * 4), o + 8);
      out.set(b.w, o + 8 + B3 * 4);
      o += per;
    }
    dv.setUint32(o, colored.length, true);
    o += 4;
    for (const [k, b] of colored) {
      dv.setFloat64(o, k, true);
      out.set(b.c!, o + 8);
      out.set(b.cw!, o + 8 + B3 * 3);
      o += cper;
    }
    return out;
  }

  load(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 12) return false;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (Math.abs(dv.getFloat32(0, true) - this.o.voxel) > 1e-6) return false; // different grid
    const n = dv.getUint32(8, true);
    const per = 8 + B3 * 4 + B3;
    this.clear();
    let o = 12;
    for (let i = 0; i < n && o + per <= bytes.byteLength; i++, o += per) {
      const k = dv.getFloat64(o, true);
      const d = new Float32Array(bytes.slice(o + 8, o + 8 + B3 * 4).buffer);
      const w = bytes.slice(o + 8 + B3 * 4, o + per);
      this.bricks.set(k, { d, w });
    }
    // Colors (saved by newer versions).
    const cper = 8 + B3 * 4;
    if (o + 4 <= bytes.byteLength) {
      const nc = dv.getUint32(o, true);
      o += 4;
      for (let i = 0; i < nc && o + cper <= bytes.byteLength; i++, o += cper) {
        const b = this.bricks.get(dv.getFloat64(o, true));
        if (!b) continue;
        b.c = bytes.slice(o + 8, o + 8 + B3 * 3);
        b.cw = bytes.slice(o + 8 + B3 * 3, o + cper);
      }
    }
    return true;
  }
}
