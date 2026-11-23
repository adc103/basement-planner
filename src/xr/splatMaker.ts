/** Runs splat training in a worker and reports progress; the result is a standard .ply. */
import type { TrainingView } from '../core/splatDataset.js';
import type { SplatTrainIn, SplatTrainOut } from './splatTrainWorker.js';

export interface SplatProgress {
  step: number;
  steps: number;
  loss: number;
  gaussians: number;
}

export class SplatMaker {
  private worker: Worker | null = null;
  progress: SplatProgress | null = null;

  get running(): boolean {
    return !!this.worker;
  }

  /** WebGPU is what training needs; checked before offering it. */
  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  make(
    views: TrainingView[],
    seed: { pos: Float32Array; rgb: Uint8Array; normals?: Float32Array },
    onProgress: (p: SplatProgress) => void,
    opts: { steps?: number; w?: number; h?: number; maxGaussians?: number } = {},
  ): Promise<Uint8Array> {
    this.stop();
    const worker = new Worker(new URL('./splatTrainWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<Uint8Array>((resolve, reject) => {
      const end = () => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      };
      worker.onmessage = (e: MessageEvent<SplatTrainOut>) => {
        const m = e.data;
        if (m.type === 'progress') {
          this.progress = m;
          onProgress(m);
        } else if (m.type === 'done') {
          end();
          resolve(m.ply);
        } else {
          end();
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        end();
        reject(new Error(e.message || 'Splat training stopped'));
      };
      const msg: SplatTrainIn = { type: 'start', views, seed, steps: opts.steps ?? 2000, w: opts.w ?? 320, h: opts.h ?? 240, maxGaussians: opts.maxGaussians ?? 300_000 };
      worker.postMessage(msg);
    });
  }

  /** Finish early: the worker stops and still returns what it has. */
  finish(): void {
    const m: SplatTrainIn = { type: 'stop' };
    this.worker?.postMessage(m);
  }

  /** Abandon: nothing is returned. */
  stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
