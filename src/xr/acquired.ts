import type { Vec2 } from '../core/geom2d.js';

/**
 * SketchUp/Fusion-style point acquisition: rest the cursor on a corner or
 * midpoint for a moment and it becomes a reference, so guide lines run
 * through it (line up with that corner, square off it). Keeps the last few.
 */
export class Acquired {
  private list: Vec2[] = [];
  private cand: Vec2 | null = null;
  private since = 0;
  /** Seconds the cursor must rest on a point to acquire it. */
  dwell = 0.3;

  hover(p: Vec2 | null, time: number): void {
    if (!p) {
      this.cand = null;
      return;
    }
    if (!this.cand || Math.hypot(this.cand.x - p.x, this.cand.y - p.y) > 0.05) {
      this.cand = { ...p };
      this.since = time;
      return;
    }
    if (time - this.since >= this.dwell && !this.list.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05)) {
      this.list.unshift({ ...p });
      if (this.list.length > 3) this.list.pop();
    }
  }

  points(): Vec2[] {
    return this.list;
  }

  clear(): void {
    this.list = [];
    this.cand = null;
  }
}
