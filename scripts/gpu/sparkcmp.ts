// Browser-side: the trained PLY drawn by Spark (what the headset shows) vs our own renderer, same camera.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { binTiles, project, allocGaussians } from '../../src/core/splat/gs';
import { GpuRaster } from '../../src/core/splat/gpuRaster';
(async () => {
  const out: any = { images: {} };
  try {
    const ply = new Uint8Array(await (await fetch('/data/trained.ply')).arrayBuffer());
    const cams = await (await fetch('/data/cams.json')).json();
    const c = cams[Number(new URLSearchParams(location.search).get('i') ?? 0)];
    const W = c.w, H = c.h;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false });
    renderer.setSize(W, H, false);
    const scene = new THREE.Scene();
    const spark = new SparkRenderer({ renderer } as any);
    scene.add(spark as any);
    const mesh = new SplatMesh({ fileBytes: ply, fileName: 'trained.ply' } as any);
    await (mesh as any).initialized;
    scene.add(mesh as any);
    const fovY = 2 * Math.atan(H / 2 / c.fy) * 180 / Math.PI;
    const cam = new THREE.PerspectiveCamera(fovY, W / H, 0.05, 100);
    cam.matrixAutoUpdate = false;
    cam.matrix.fromArray(c.view).invert();
    cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.fromArray(c.view);
    for (let k = 0; k < 30; k++) { renderer.render(scene, cam); await new Promise((r) => setTimeout(r, 100)); }
    out.images.spark = canvas.toDataURL('image/png');
    // Our renderer: parse the PLY back.
    const txt = new TextDecoder().decode(ply.slice(0, 2000));
    const hl = txt.indexOf('end_header\n') + 11;
    const n = Number(/element vertex (\d+)/.exec(txt)![1]);
    const dv = new DataView(ply.buffer, hl);
    const g = allocGaussians(n);
    for (let i = 0; i < n; i++) {
      const f = (k: number) => dv.getFloat32((i * 17 + k) * 4, true);
      g.mean.set([f(0), f(1), f(2)], i * 3); g.fdc.set([f(6), f(7), f(8)], i * 3); g.opacity[i] = f(9);
      g.logScale.set([f(10), f(11), f(12)], i * 3); g.quat.set([f(13), f(14), f(15), f(16)], i * 4);
    }
    const gpu = (await GpuRaster.create())!;
    const sc = { view: c.view, fx: c.fx, fy: c.fy, cx: c.cx, cy: c.cy, w: W, h: H };
    const p = project(g, sc);
    const r = await gpu.run(p, binTiles(p, W, H), W, H, new Uint8Array(W * H * 4), { image: true });
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.image!), W, H), 0, 0);
    out.images.ours = cv.toDataURL('image/png');
    out.n = n;
  } catch (e) { out.error = String((e as Error)?.stack ?? e); }
  (window as any).__result = out;
})();
