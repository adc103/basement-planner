import type { PP } from './wallDetect.js';

/**
 * Sparse voxel map of everything the depth sensor has seen, in plan space
 * (inches; z = height). Each voxel keeps the running mean of its samples, so
 * noise averages out and repeated looks don't grow memory.
 */
export class ScanMap {
  readonly voxel: number;
  private cells = new Map<number, { x: number; y: number; z: number; n: number }>();
  /** Bumped on every change, for cheap "did it change" checks. */
  version = 0;
  readonly maxCells: number;

  constructor(voxelInches = 2, maxCells = 400_000) {
    this.voxel = voxelInches;
    this.maxCells = maxCells;
  }

  get size(): number {
    return this.cells.size;
  }

  /** Pack 3 voxel indices (each within +-2^19) into one safe integer key. */
  private key(ix: number, iy: number, iz: number): number {
    const B = 1 << 20;
    return ((ix + (B >> 1)) * B + (iy + (B >> 1))) * 1024 + Math.max(0, Math.min(1023, iz + 64));
  }

  add(x: number, y: number, z: number): void {
    const v = this.voxel;
    const k = this.key(Math.floor(x / v), Math.floor(y / v), Math.floor(z / v));
    const c = this.cells.get(k);
    if (c) {
      const n = Math.min(c.n + 1, 50);
      c.x += (x - c.x) / n;
      c.y += (y - c.y) / n;
      c.z += (z - c.z) / n;
      c.n = n;
    } else {
      if (this.cells.size >= this.maxCells) return;
      this.cells.set(k, { x, y, z, n: 1 });
    }
    this.version++;
  }

  addMany(pts: Iterable<PP>): void {
    for (const p of pts) this.add(p.x, p.y, p.z);
  }

  /** Voxel centers seen at least `minHits` times (drops one-off noise). */
  points(minHits = 2): PP[] {
    const out: PP[] = [];
    for (const c of this.cells.values()) if (c.n >= minHits) out.push({ x: c.x, y: c.y, z: c.z });
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.version++;
  }

  /** Flat Float32Array [x, y, z, n, ...] for storage. */
  serialize(): Float32Array {
    const a = new Float32Array(this.cells.size * 4);
    let i = 0;
    for (const c of this.cells.values()) {
      a[i++] = c.x;
      a[i++] = c.y;
      a[i++] = c.z;
      a[i++] = c.n;
    }
    return a;
  }

  load(a: Float32Array): void {
    this.cells.clear();
    for (let i = 0; i + 3 < a.length; i += 4) {
      const v = this.voxel;
      const k = this.key(Math.floor(a[i] / v), Math.floor(a[i + 1] / v), Math.floor(a[i + 2] / v));
      this.cells.set(k, { x: a[i], y: a[i + 1], z: a[i + 2], n: a[i + 3] });
    }
    this.version++;
  }
}

/**
 * Depth pixel -> view-space point. (u, v) are normalized screen coords with the
 * origin at the bottom-left (as gl_FragCoord), d the view depth in meters.
 * `proj` is the view's column-major projection matrix.
 */
export function unprojectDepth(u: number, v: number, d: number, proj: ArrayLike<number>): { x: number; y: number; z: number } {
  const ndcX = u * 2 - 1;
  const ndcY = v * 2 - 1;
  return { x: (d * (ndcX + proj[8])) / proj[0], y: (d * (ndcY + proj[9])) / proj[5], z: -d };
}
