/// <reference lib="webworker" />
import { FreeGrid } from '../core/freeSpace.js';
import type { Plan } from '../core/plan.js';
import { findStructure, type StructureOptions } from '../core/structure.js';
import type { PP } from '../core/wallDetect.js';

/** Runs structure detection off the render thread (it can take a few hundred ms). */
export interface ScanJob {
  id: number;
  pts: Float32Array;
  freeKeys: Float64Array;
  freeCounts: Uint8Array;
  freeVoxel: number;
  plan: Plan;
  opts: StructureOptions;
}

const free = new FreeGrid(4);

self.onmessage = (e: MessageEvent<ScanJob>) => {
  const job = e.data;
  try {
    const pts: PP[] = [];
    for (let i = 0; i + 2 < job.pts.length; i += 3) pts.push({ x: job.pts[i], y: job.pts[i + 1], z: job.pts[i + 2] });
    free.load({ keys: job.freeKeys, counts: job.freeCounts });
    const res = findStructure(pts, job.plan, job.opts, free);
    (self as unknown as Worker).postMessage({ id: job.id, res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: job.id, error: String(err) });
  }
};
