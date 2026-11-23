/**
 * Trains a Gaussian splat of the room on this device's GPU (WebGPU compute), from the
 * scan's photos (lined up with the scan) and its colored surface points.
 */
import { gaussiansPly } from '../core/splat/gs.js';
import { GpuRaster } from '../core/splat/gpuRaster.js';
import { scaledCam, seedGaussians, SplatTrainer, type TrainImage } from '../core/splat/trainer.js';
import type { TrainingView } from '../core/splatDataset.js';

export type SplatTrainIn =
  | { type: 'start'; views: TrainingView[]; seed: { pos: Float32Array; rgb: Uint8Array; normals?: Float32Array }; steps: number; w: number; h: number; maxGaussians: number }
  | { type: 'stop' };

export type SplatTrainOut =
  | { type: 'progress'; step: number; steps: number; loss: number; gaussians: number }
  | { type: 'done'; ply: Uint8Array; gaussians: number; steps: number }
  | { type: 'error'; message: string };

const post = (m: SplatTrainOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let stop = false;

async function decode(v: TrainingView, w: number, h: number): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(new Blob([v.jpeg as BlobPart], { type: 'image/jpeg' }));
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return x.getImageData(0, 0, w, h).data;
}

async function run(m: Extract<SplatTrainIn, { type: 'start' }>): Promise<void> {
  const gpu = await GpuRaster.create();
  if (!gpu) throw new Error('This browser has no WebGPU, which training needs');
  try {
    const images: TrainImage[] = [];
    for (const v of m.views) images.push({ cam: scaledCam(v.camToRoot, v.fx, v.fy, v.cx, v.cy, v.w, v.h, m.w, m.h), rgba: await decode(v, m.w, m.h) });
    const g = seedGaussians(m.seed.pos, m.seed.rgb, m.seed.normals);
    const tr = new SplatTrainer(gpu, g, images, { steps: m.steps, maxGaussians: m.maxGaussians });
    let last = 0;
    while (!tr.done && !stop) {
      await tr.train();
      const now = performance.now();
      if (now - last > 500) {
        last = now;
        post({ type: 'progress', step: tr.step, steps: m.steps, loss: tr.loss, gaussians: tr.g.n });
      }
    }
    const ply = gaussiansPly(tr.g);
    post({ type: 'done', ply, gaussians: tr.g.n, steps: tr.step }, [ply.buffer]);
  } finally {
    gpu.destroy();
  }
}

self.onmessage = (e: MessageEvent<SplatTrainIn>) => {
  const m = e.data;
  if (m.type === 'stop') {
    stop = true;
    return;
  }
  stop = false;
  run(m).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
