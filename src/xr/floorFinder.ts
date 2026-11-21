/**
 * Finds the real floor height from headset depth (and floor hit tests).
 * Needed in large-space mode: the 'unbounded' reference space has no floor,
 * its origin is wherever the headset started. Also corrects a wrong system
 * floor in normal mode.
 */
export class FloorFinder {
  private bins = new Map<number, number>();
  private total = 0;
  /** Best floor estimate in world meters, or null. */
  floorY: number | null = null;

  reset(): void {
    this.bins.clear();
    this.total = 0;
    this.floorY = null;
  }

  /** Feed a world-space point; only points well below the eyes count. */
  add(y: number, eyeY: number): void {
    if (y > eyeY - 0.9 || y < eyeY - 2.4) return;
    const b = Math.round(y * 100); // 1 cm bins
    this.bins.set(b, (this.bins.get(b) ?? 0) + 1);
    this.total++;
  }

  /** Recompute; returns the floor if confident. */
  solve(minPoints = 150): number | null {
    let best = 0;
    let bestN = 0;
    for (const [b, n] of this.bins) {
      // Smooth over neighbours: floors are a few cm thick in depth noise.
      const s = n + (this.bins.get(b - 1) ?? 0) + (this.bins.get(b + 1) ?? 0);
      if (s > bestN) [best, bestN] = [b, s];
    }
    if (bestN < minPoints) return this.floorY;
    // Weighted mean of the peak.
    let sw = 0;
    let sy = 0;
    for (let b = best - 2; b <= best + 2; b++) {
      const n = this.bins.get(b) ?? 0;
      sw += n;
      sy += n * b;
    }
    this.floorY = sy / sw / 100;
    return this.floorY;
  }
}
