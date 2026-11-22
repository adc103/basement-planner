/// <reference lib="webworker" />
import { FreeGrid } from '../core/freeSpace.js';
import type { Plan } from '../core/plan.js';
import { findStructure, type StructureOptions } from '../core/structure.js';
import { planSegs, refineStructure } from '../core/fit.js';
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
  /** Room-mesh vertices and normals (plan inches): fit the walls to them. */
  surfPos?: Float32Array;
  surfNrm?: Float32Array;
}

const free = new FreeGrid(4);

self.onmessage = (e: MessageEvent<ScanJob>) => {
  const job = e.data;
  try {
    const pts: PP[] = [];
    for (let i = 0; i + 2 < job.pts.length; i += 3) pts.push({ x: job.pts[i], y: job.pts[i + 1], z: job.pts[i + 2] });
    free.load({ keys: job.freeKeys, counts: job.freeCounts });
    let res = findStructure(pts, job.plan, job.opts, free);
    res = refineStructure(res, job.surfPos && job.surfNrm ? { pos: job.surfPos, nrm: job.surfNrm } : { pos: new Float32Array(0), nrm: new Float32Array(0) }, planSegs(job.plan));
    (self as unknown as Worker).postMessage({ id: job.id, res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: job.id, error: String(err) });
  }
};
