// Browser-side: train on /data (from scripts/scratch/mkds.ts), report held-out PSNR before/after.
import { binTiles, gaussiansPly, project } from '../../src/core/splat/gs';
import { GpuRaster } from '../../src/core/splat/gpuRaster';
import { TrainViewAligner, thinPoints } from '../../src/core/splat/alignViews';
import { scaledCam, seedGaussians, SplatTrainer, type TrainImage } from '../../src/core/splat/trainer';
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 160), H = Number(q.get('h') ?? 120), STEPS = Number(q.get('steps') ?? 300);
async function decode(url: string): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d')!;
  x.drawImage(bmp, 0, 0, W, H);
  return x.getImageData(0, 0, W, H).data;
}
function toPng(rgba: Uint8Array | Uint8ClampedArray): Promise<string> {
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  return c.convertToBlob().then((b) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.readAsDataURL(b); }));
}
(async () => {
  const out: any = { images: {} };
  try {
    const gpu = (await GpuRaster.create())!;
    const views = await (await fetch('/data/views.json')).json();
    const seed = new Uint8Array(await (await fetch('/data/seed.bin')).arrayBuffer());
    const n = new DataView(seed.buffer).getUint32(0, true);
    const pos = new Float32Array(seed.buffer.slice(4, 4 + n * 12));
    const rgb = seed.slice(4 + n * 12, 4 + n * 15);
    const nrm = q.get('flat') === '0' ? undefined : new Float32Array(seed.buffer.slice(4 + n * 15, 4 + n * 27));
    const imgs: TrainImage[] = [];
    const aligner = q.get('align') ? new TrainViewAligner(thinPoints(pos, 60000)) : null;
    const ta = performance.now();
    for (const v of views) {
      const rgba = await decode('/data/' + v.file);
      const c2r = aligner ? aligner.add({ ...v, w0: v.w, h0: v.h, rgba, w: W, h: H }) : v.camToRoot;
      imgs.push({ cam: scaledCam(c2r, v.fx, v.fy, v.cx, v.cy, v.w, v.h, W, H), rgba });
    }
    out.alignMs = performance.now() - ta;
    const test = imgs.filter((_, i) => i % 6 === 3);
    const train = imgs.filter((_, i) => i % 6 !== 3);
    const g = seedGaussians(pos, rgb, nrm);
    const tr = new SplatTrainer(gpu, g, train, { steps: STEPS, gradThreshold: Number(q.get('thr') ?? 0.0012), refineEvery: Number(q.get('every') ?? 100) });
    if (q.get('lr')) Object.assign((tr as any).opt.lr, JSON.parse(q.get('lr')!));
    if (q.get('meanlr')) (tr as any).meanLr = Number(q.get('meanlr'));
    const psnr = async (set: TrainImage[], tag?: string) => {
      let mse = 0;
      for (const [k, im] of set.entries()) {
        const p = project(tr.g, im.cam);
        const r = await gpu.run(p, binTiles(p, W, H), W, H, im.rgba, { image: true });
        for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) mse += ((r.image![i * 4 + c] - im.rgba[i * 4 + c]) / 255) ** 2;
        if (tag && k < 2) { out.images[`${tag}${k}`] = await toPng(r.image!); out.images[`photo${k}`] = await toPng(im.rgba); }
      }
      return 10 * Math.log10(1 / (mse / (set.length * W * H * 3)));
    };
    out.gaussians0 = g.n;
    out.testBefore = await psnr(test, 'before');
    out.trainBefore = await psnr(train);
    const t0 = performance.now();
    const curve: number[] = [];
    while (!tr.done) { await tr.train(); if (tr.step % 50 === 0) curve.push(+tr.loss.toFixed(4)); }
    out.msPerStep = (performance.now() - t0) / STEPS;
    out.curve = curve;
    out.testAfter = await psnr(test, 'after');
    out.trainAfter = await psnr(train);
    out.gaussians = tr.g.n; out.added = tr.added; out.removed = tr.removed;
    const plyBytes = gaussiansPly(tr.g, 0.05);
    out.plyBytes = plyBytes.length;
    if (q.get('saveply')) {
      let bin = ''; for (let i = 0; i < plyBytes.length; i += 32768) bin += String.fromCharCode(...plyBytes.subarray(i, i + 32768));
      out.files = { 'trained.ply': btoa(bin), 'cams.json': btoa(JSON.stringify(test.map((t) => ({ view: Array.from(t.cam.view), fx: t.cam.fx, fy: t.cam.fy, cx: t.cam.cx, cy: t.cam.cy, w: t.cam.w, h: t.cam.h })))) };
    }
  } catch (e) { out.error = String((e as Error)?.stack ?? e); }
  (window as any).__result = out;
})();
