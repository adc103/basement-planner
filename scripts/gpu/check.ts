// Browser-side: the GPU kernel against the CPU reference, on a random scene.
import { allocGaussians, binTiles, G2, project, rasterize, viewFromCamToRoot } from '../../src/core/splat/gs';
import { GpuRaster } from '../../src/core/splat/gpuRaster';
(async () => {
  const out: any = {};
  try {
    const gpu = await GpuRaster.create();
    if (!gpu) throw new Error('no WebGPU');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const N = Number(new URLSearchParams(location.search).get('n') ?? 300);
    const w = 160, h = 120;
    const g = allocGaussians(N);
    for (let i = 0; i < N; i++) {
      g.mean.set([(rnd() - 0.5) * 2, 1.2 + (rnd() - 0.5) * 1.5, -rnd() * 2], i * 3);
      g.logScale.set([Math.log(0.02 + 0.1 * rnd()), Math.log(0.02 + 0.1 * rnd()), Math.log(0.02 + 0.1 * rnd())], i * 3);
      const q = [1, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const l = Math.hypot(...q);
      g.quat.set(q.map((x) => x / l), i * 4);
      g.fdc.set([rnd() * 3 - 1.5, rnd() * 3 - 1.5, rnd() * 3 - 1.5], i * 3);
      g.opacity[i] = rnd() * 4 - 2;
    }
    const cam = { view: viewFromCamToRoot([1,0,0,0,0,1,0,0,0,0,1,0,0,1.2,2,1]), fx: 120, fy: 120, cx: w / 2, cy: h / 2, w, h };
    const t = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) t.set([(i * 13) % 256, (i * 7) % 256, 100, 255], i * 4);
    const p = project(g, cam);
    const bins = binTiles(p, w, h);
    const cpu = rasterize(p, bins, w, h, t);
    const r = await gpu.run(p, bins, w, h, t, { loss: true, image: true });
    let num = 0, den = 0, worst = 0;
    const per = new Array(G2).fill(0).map(() => [0, 0]);
    for (let i = 0; i < cpu.grad.length; i++) { const d = r.grad[i] - cpu.grad[i]; num += d * d; den += cpu.grad[i] ** 2; per[i % G2][0] += d * d; per[i % G2][1] += cpu.grad[i] ** 2; }
    let imgErr = 0;
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) imgErr = Math.max(imgErr, Math.abs(r.image![i * 4 + c] / 255 - Math.min(1, cpu.image[i * 3 + c])));
    out.count = p.count; out.listLen = bins.list.length;
    out.lossCpu = cpu.loss; out.lossGpu = r.loss; out.rel = Math.sqrt(num / den); out.imgErr = imgErr;
    out.perKind = per.map(([a, b]) => +(Math.sqrt(a / (b || 1))).toFixed(4));
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) await gpu.run(p, bins, w, h, t);
    out.msPerRun = (performance.now() - t0) / 5;
  } catch (e) { out.error = String((e as Error)?.stack ?? e); }
  (window as any).__result = out;
})();
