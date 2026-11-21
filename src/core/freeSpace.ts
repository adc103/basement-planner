/**
 * Free-space evidence: every depth ray proves the space between the headset
 * and the surface it hit is empty. Counting those rays per voxel lets wall
 * detection tell a doorway (seen through: rays passed) from a wall hidden
 * behind a shelf (occluded: nothing known), which points alone can't.
 *
 * Plan space, inches, z = height. Sparse voxels keyed by packed indices.
 */
export class FreeGrid {
  readonly voxel: number;
  private counts = new Map<number, number>();
  version = 0;
  readonly maxCells: number;

  constructor(voxelInches = 4, maxCells = 1_500_000) {
    this.voxel = voxelInches;
    this.maxCells = maxCells;
  }

  get size(): number {
    return this.counts.size;
  }

  private key(ix: number, iy: number, iz: number): number {
    const B = 1 << 20;
    return ((ix + (B >> 1)) * B + (iy + (B >> 1))) * 1024 + Math.max(0, Math.min(1023, iz + 64));
  }

  /** Free-ray count of the voxel containing a point. */
  count(x: number, y: number, z: number): number {
    const v = this.voxel;
    return this.counts.get(this.key(Math.floor(x / v), Math.floor(y / v), Math.floor(z / v))) ?? 0;
  }

  /**
   * Mark the voxels along a ray from the eye (o) to a surface hit (p) as free,
   * stopping `keepOut` inches short of the hit so the surface's own voxel stays clean.
   */
  carve(ox: number, oy: number, oz: number, px: number, py: number, pz: number, keepOut = 6): void {
    const dx = px - ox;
    const dy = py - oy;
    const dz = pz - oz;
    const D = Math.hypot(dx, dy, dz);
    const end = D - keepOut;
    if (end <= 0) return;
    const v = this.voxel;
    const step = v * 0.5;
    const ux = dx / D;
    const uy = dy / D;
    const uz = dz / D;
    let last = -1;
    for (let s = step; s < end; s += step) {
      const k = this.key(Math.floor((ox + ux * s) / v), Math.floor((oy + uy * s) / v), Math.floor((oz + uz * s) / v));
      if (k === last) continue;
      last = k;
      const c = this.counts.get(k);
      if (c === undefined) {
        if (this.counts.size >= this.maxCells) continue;
        this.counts.set(k, 1);
      } else if (c < 255) this.counts.set(k, c + 1);
    }
    this.version++;
  }

  clear(): void {
    this.counts.clear();
    this.version++;
  }

  serialize(): { keys: Float64Array; counts: Uint8Array } {
    const keys = new Float64Array(this.counts.size);
    const counts = new Uint8Array(this.counts.size);
    let i = 0;
    for (const [k, c] of this.counts) {
      keys[i] = k;
      counts[i++] = c;
    }
    return { keys, counts };
  }

  load(data: { keys: Float64Array; counts: Uint8Array }): void {
    this.counts.clear();
    for (let i = 0; i < data.keys.length; i++) this.counts.set(data.keys[i], data.counts[i]);
    this.version++;
  }
}
