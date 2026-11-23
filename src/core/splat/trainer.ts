/**
 * Splat training loop (after the 3DGS recipe, kept small for a headset): photos picked in
 * a shuffled order, the GPU kernel for the per-pixel part, Adam with the usual learning
 * rates (position decaying over the run), and low-opacity Gaussians pruned as it goes.
 */
import { Adam, allocGaussians, rotFromQuat, allocProjected, backwardProject, binTiles, gaussiansFromPoints, viewFromCamToRoot, zerosLike, project, type Gaussians, type Projected, type SplatCam } from './gs.js';
import type { GpuRaster } from './gpuRaster.js';

export interface TrainImage {
  cam: SplatCam;
  /** RGBA, row 0 at the top, at cam.w x cam.h. */
  rgba: Uint8Array | Uint8ClampedArray;
}

export interface TrainerOptions {
  steps: number;
  /** Prune Gaussians fainter than this at each refine. */
  minOpacity?: number;
  /** Densify and prune every this many steps (until 60% of the run). */
  refineEvery?: number;
  /** Most Gaussians to grow to (the headset's memory and speed budget). */
  maxGaussians?: number;
  /** Screen-space position gradient (per pixel of image height) above which a Gaussian is cloned or split. */
  gradThreshold?: number;
}

/** A photo's lens at another image size (the photo scaled to w x h). */
export function scaledCam(camToRoot: ArrayLike<number>, fx: number, fy: number, cx: number, cy: number, w0: number, h0: number, w: number, h: number): SplatCam {
  const sx = w / w0, sy = h / h0;
  return { view: viewFromCamToRoot(camToRoot), fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy, w, h };
}

/**
 * Start sizes from the spacing of the points (3DGS: mean squared distance to the three
 * nearest neighbours), via a hash grid.
 */
export function seedGaussians(pos: Float32Array, rgb: Uint8Array, normals?: Float32Array, opacity = 0.5): Gaussians {
  const n = pos.length / 3;
  const g = gaussiansFromPoints(pos, rgb, 0.02, opacity);
  const cell = 0.06;
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const best = [Infinity, Infinity, Infinity];
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    best[0] = best[1] = best[2] = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!a) continue;
      for (const j of a) {
        if (j === i) continue;
        const d = (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
        if (d < best[2]) {
          if (d < best[0]) { best[2] = best[1]; best[1] = best[0]; best[0] = d; }
          else if (d < best[1]) { best[2] = best[1]; best[1] = d; }
          else best[2] = d;
        }
      }
    }
    const m = Number.isFinite(best[2]) ? (best[0] + best[1] + best[2]) / 3 : cell * cell;
    const ls = Math.log(Math.min(0.05, Math.max(0.003, Math.sqrt(m))));
    g.logScale.fill(ls, i * 3, i * 3 + 3);
    if (normals) {
      // Flat on the scanned surface: a disc whose thin axis (z) is the surface normal.
      let nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
      const l = Math.hypot(nx, ny, nz);
      if (l > 0.5) {
        nx /= l; ny /= l; nz /= l;
        let qw = 1 + nz, qx = -ny, qy = nx;
        if (qw < 1e-6) { qw = 0; qx = 1; qy = 0; }
        const ql = Math.hypot(qw, qx, qy);
        g.quat.set([qw / ql, qx / ql, qy / ql, 0], i * 4);
        g.logScale[i * 3 + 2] = ls + Math.log(0.15);
      }
    }
  }
  return g;
}

function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class SplatTrainer {
  g: Gaussians;
  private opt: Adam;
  private order: number[] = [];
  private proj: Projected;
  private grad: Gaussians;
  /** Per Gaussian since the last refine: summed screen-space position gradient, and views that touched it. */
  private gradSum = new Float32Array(0);
  private seen = new Uint16Array(0);
  step = 0;
  /** Starting position learning rate (meters per step, decays 100x over the run). */
  meanLr = 5e-4;
  /** Running mean of the per-pixel L1 (0..3), for progress. */
  loss = NaN;
  /** Gaussians added and removed by refining so far. */
  added = 0;
  removed = 0;

  constructor(private gpu: GpuRaster, g: Gaussians, private images: TrainImage[], private o: TrainerOptions) {
    this.g = g;
    this.opt = new Adam(g, { mean: 5e-4, logScale: 5e-3, quat: 1e-3, fdc: 2.5e-3, opacity: 2.5e-2 });
    this.proj = allocProjected(g.n);
    this.grad = zerosLike(g);
    this.gradSum = new Float32Array(g.n);
    this.seen = new Uint16Array(g.n);
  }

  get done(): boolean {
    return this.step >= this.o.steps;
  }

  private next(): TrainImage {
    if (!this.order.length) {
      this.order = this.images.map((_, i) => i);
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
    return this.images[this.order.pop()!];
  }

  async train(): Promise<void> {
    const im = this.next();
    const { w, h } = im.cam;
    const t = this.step / Math.max(1, this.o.steps);
    this.opt.lr.mean = this.meanLr * Math.pow(0.01, t);
    const p = project(this.g, im.cam, this.proj);
    const bins = binTiles(p, w, h);
    const wantLoss = this.step % 10 === 0;
    const r = await this.gpu.run(p, bins, w, h, im.rgba, { loss: wantLoss });
    const gr = this.grad;
    gr.mean.fill(0);
    gr.logScale.fill(0);
    gr.quat.fill(0);
    gr.fdc.fill(0);
    gr.opacity.fill(0);
    backwardProject(this.g, im.cam, p, r.grad, gr);
    for (let k = 0; k < p.count; k++) {
      const gx = r.grad[k * 9], gy = r.grad[k * 9 + 1];
      if (!gx && !gy && !r.grad[k * 9 + 5]) continue;
      const i = p.idx[k];
      this.gradSum[i] += Math.hypot(gx, gy) / h;
      this.seen[i]++;
    }
    this.opt.step(gr);
    if (r.loss !== undefined) {
      const l = r.loss / (w * h);
      this.loss = Number.isNaN(this.loss) ? l : 0.8 * this.loss + 0.2 * l;
    }
    this.step++;
    const every = this.o.refineEvery ?? 200;
    if (this.step % every === 0 && this.step <= 0.6 * this.o.steps) {
      const r2 = this.refine();
      this.added += r2.added;
      this.removed += r2.removed;
    }
  }

  /**
   * 3DGS adaptive density control: Gaussians that keep being pulled across the screen are
   * under-reconstructing; small ones are cloned, big ones split in two smaller ones placed
   * inside them. Faint and oversized ones are dropped.
   */
  refine(): { added: number; removed: number } {
    const g = this.g;
    const lo = Math.log((this.o.minOpacity ?? 0.01) / (1 - (this.o.minOpacity ?? 0.01)));
    const thr = this.o.gradThreshold ?? 0.0012;
    const max = this.o.maxGaussians ?? 400_000;
    const keep: number[] = [];
    const grow: number[] = [];
    for (let i = 0; i < g.n; i++) {
      const big = Math.max(g.logScale[i * 3], g.logScale[i * 3 + 1], g.logScale[i * 3 + 2]);
      if (g.opacity[i] <= lo || big > Math.log(0.3)) continue;
      keep.push(i);
      if (this.seen[i] && this.gradSum[i] / this.seen[i] > thr) grow.push(i);
    }
    // Strongest first, within the budget.
    grow.sort((a, b) => this.gradSum[b] / this.seen[b] - this.gradSum[a] / this.seen[a]);
    grow.length = Math.max(0, Math.min(grow.length, max - keep.length));
    const n = keep.length + grow.length;
    const ng = allocGaussians(n);
    const copy = (i: number, j: number) => {
      ng.mean.set(g.mean.subarray(i * 3, i * 3 + 3), j * 3);
      ng.logScale.set(g.logScale.subarray(i * 3, i * 3 + 3), j * 3);
      ng.quat.set(g.quat.subarray(i * 4, i * 4 + 4), j * 4);
      ng.fdc.set(g.fdc.subarray(i * 3, i * 3 + 3), j * 3);
      ng.opacity[j] = g.opacity[i];
    };
    const src = new Uint32Array(n);
    const where = new Map<number, number>();
    keep.forEach((i, j) => {
      copy(i, j);
      src[j] = i;
      where.set(i, j);
    });
    const R = new Float64Array(9);
    grow.forEach((i, c) => {
      const j = keep.length + c;
      copy(i, j);
      src[j] = i;
      const sMax = Math.exp(Math.max(g.logScale[i * 3], g.logScale[i * 3 + 1], g.logScale[i * 3 + 2]));
      if (sMax < 0.01) return; // clone: same place, the optimizer pulls them apart
      // Split: both halves shrink, offset along the Gaussian's long axes.
      const a = where.get(i)!;
      rotFromQuat(g.quat, i * 4, R);
      // A sample from the Gaussian (in its own axes), mirrored for the other half.
      const z = [gauss(), gauss(), gauss()];
      for (const [t, sign] of [[a, 1], [j, -1]] as const) {
        for (let d = 0; d < 3; d++) {
          let off = 0;
          for (let e = 0; e < 3; e++) off += R[d * 3 + e] * Math.exp(g.logScale[i * 3 + e]) * z[e] * sign;
          ng.mean[t * 3 + d] = g.mean[i * 3 + d] + off;
          ng.logScale[t * 3 + d] = g.logScale[i * 3 + d] - Math.log(1.6);
        }
      }
    });
    const removed = g.n - keep.length;
    this.opt = this.opt.remap(ng, src);
    this.g = ng;
    this.grad = zerosLike(ng);
    this.gradSum = new Float32Array(n);
    this.seen = new Uint16Array(n);
    if (this.proj.idx.length < n) this.proj = allocProjected(Math.ceil(n * 1.25));
    return { added: grow.length, removed };
  }
}
