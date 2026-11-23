/**
 * Trains a Gaussian splat of the room on this device's GPU (WebGPU compute), from the
 * scan's photos (lined up with the scan) and its colored surface points.
 */
import { gaussiansPly } from '../core/splat/gs.js';
import { thinPoints, TrainViewAligner } from '../core/splat/alignViews.js';
import { GpuRaster } from '../core/splat/gpuRaster.js';
import { scaledCam, seedGaussians, SplatTrainer, type TrainImage } from '../core/splat/trainer.js';
import type { TrainingView } from '../core/splatDataset.js';

export type SplatTrainIn =
  | { type: 'start'; views: TrainingView[]; seed: { pos: Float32Array; rgb: Uint8Array; normals?: Float32Array }; steps: number; w: number; h: number; fullW: number; fullH: number; maxGaussians: number }
  | { type: 'stop' }
  /** Pause while the headset is showing the room (training and drawing share the GPU). */
  | { type: 'pause'; on: boolean };

export type SplatTrainOut =
  | { type: 'progress'; phase: 'align' | 'train'; step: number; steps: number; loss: number; gaussians: number }
  | { type: 'done'; ply: Uint8Array; gaussians: number; steps: number }
  | { type: 'error'; message: string };

const post = (m: SplatTrainOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let stop = false;
let paused = false;

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
    // Line every photo up with the scan first. During the scan the worker only has time to
    // do this for some of them; the rest carry the head pose's camera, often 2-5 degrees
    // off (measured), which smears every splat they touch.
    const aligner = new TrainViewAligner(thinPoints(m.seed.pos, 60_000));
    const images: TrainImage[] = [];
    let last = 0;
    for (const [i, v] of m.views.entries()) {
      if (stop) break;
      const rgba = await decode(v, m.w, m.h);
      const camToRoot = aligner.add({ ...v, w0: v.w, h0: v.h, rgba, w: m.w, h: m.h });
      images.push({
        cam: scaledCam(camToRoot, v.fx, v.fy, v.cx, v.cy, v.w, v.h, m.w, m.h),
        rgba,
        full: async () => ({ cam: scaledCam(camToRoot, v.fx, v.fy, v.cx, v.cy, v.w, v.h, m.fullW, m.fullH), rgba: await decode(v, m.fullW, m.fullH) }),
      });
      const now = performance.now();
      if (now - last > 500) {
        last = now;
        post({ type: 'progress', phase: 'align', step: i + 1, steps: m.views.length, loss: NaN, gaussians: 0 });
      }
    }
    const g = seedGaussians(m.seed.pos, m.seed.rgb, m.seed.normals);
    const tr = new SplatTrainer(gpu, g, images, { steps: m.steps, maxGaussians: m.maxGaussians, fullFrom: m.fullW > m.w ? 0.5 : 1 });
    while (!tr.done && !stop) {
      if (paused) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      await tr.train();
      const now = performance.now();
      if (now - last > 500) {
        last = now;
        post({ type: 'progress', phase: 'train', step: tr.step, steps: m.steps, loss: tr.loss, gaussians: tr.g.n });
      }
    }
    const ply = gaussiansPly(tr.g, 0.05);
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
  if (m.type === 'pause') {
    paused = m.on;
    return;
  }
  stop = false;
  run(m).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
