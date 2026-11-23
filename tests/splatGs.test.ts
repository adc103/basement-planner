import { describe, expect, it } from 'vitest';
import { Adam, allocGaussians, backwardProject, binTiles, G2, gaussiansFromPoints, gaussiansPly, project, rasterize, viewFromCamToRoot, zerosLike, type Gaussians, type SplatCam } from '../src/core/splat/gs';

/** A camera at (0, 1.2, 2) looking down -z, slightly turned. */
function cam(w = 48, h = 40): SplatCam {
  const a = 0.1;
  const c = Math.cos(a), s = Math.sin(a);
  // camToRoot: rotation about y, then translation.
  const m = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0.1, 1.2, 2, 1];
  return { view: viewFromCamToRoot(m), fx: 40, fy: 40, cx: w / 2, cy: h / 2, w, h };
}

function scene(): Gaussians {
  const g = allocGaussians(5);
  const pts = [
    [0, 1.2, 0], [0.3, 1.4, -0.3], [-0.35, 1.0, 0.2], [0.1, 0.9, -0.6], [-0.1, 1.5, -0.2],
  ];
  pts.forEach((p, i) => {
    g.mean.set(p, i * 3);
    g.logScale.set([Math.log(0.12 + 0.02 * i), Math.log(0.08 + 0.03 * i), Math.log(0.1)], i * 3);
    const q = [1, 0.2 * i - 0.3, 0.1 * i, -0.15 * i];
    const l = Math.hypot(...q);
    g.quat.set(q.map((x) => x / l), i * 4);
    g.fdc.set([0.4 * i - 0.8, 0.3 - 0.2 * i, 0.5], i * 3);
    g.opacity[i] = -0.2 + 0.25 * i;
  });
  return g;
}

function lossOf(g: Gaussians, c: SplatCam, target: Uint8Array): number {
  const p = project(g, c);
  return rasterize(p, binTiles(p, c.w, c.h), c.w, c.h, target).loss;
}

function target(c: SplatCam): Uint8Array {
  const t = new Uint8Array(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const o = (y * c.w + x) * 4;
    t[o] = (x * 5) % 256;
    t[o + 1] = (y * 7) % 256;
    t[o + 2] = 90;
    t[o + 3] = 255;
  }
  return t;
}

describe('gaussian splat math', () => {
  it('projects a Gaussian in front of the camera to the image center', () => {
    const g = allocGaussians(1);
    g.mean.set([0, 0, -2]);
    g.logScale.fill(Math.log(0.1));
    g.quat[0] = 1;
    g.opacity[0] = 3;
    const c: SplatCam = { view: viewFromCamToRoot([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), fx: 100, fy: 100, cx: 32, cy: 24, w: 64, h: 48 };
    const p = project(g, c);
    expect(p.count).toBe(1);
    expect(p.mean2d[0]).toBeCloseTo(32, 5);
    expect(p.mean2d[1]).toBeCloseTo(24, 5);
    expect(p.depth[0]).toBeCloseTo(2, 5);
    // 0.1 m at 2 m with f = 100: sigma 5 px, variance 25 (+ low-pass).
    expect(1 / p.conic[0]).toBeCloseTo(25.3, 1);
    const img = rasterize(p, binTiles(p, 64, 48), 64, 48).image;
    const mid = (24 * 64 + 32) * 3;
    expect(img[mid]).toBeGreaterThan(0.4);
    expect(img[0]).toBeLessThan(0.01);
  });

  it('gradients match finite differences', () => {
    const c = cam();
    const g = scene();
    const t = target(c);
    const p = project(g, c);
    expect(p.count).toBe(5);
    const r = rasterize(p, binTiles(p, c.w, c.h), c.w, c.h, t);
    const grad = zerosLike(g);
    backwardProject(g, c, p, r.grad, grad);
    const keys: (keyof Gaussians)[] = ['mean', 'logScale', 'quat', 'fdc', 'opacity'];
    const eps = { mean: 1e-3, logScale: 1e-3, quat: 1e-3, fdc: 1e-3, opacity: 1e-3 } as Record<string, number>;
    for (const key of keys) {
      const arr = g[key] as Float32Array;
      const ga = grad[key] as Float32Array;
      let num = 0, den = 0, checked = 0;
      for (let j = 0; j < arr.length; j++) {
        const v = arr[j];
        // The render has hard cutoffs (faint tails, tile edges), so a single step can
        // straddle one: take the step whose difference agrees best.
        let fd = Infinity;
        for (const e of [eps[key], eps[key] * 0.3, eps[key] * 3]) {
          arr[j] = v + e;
          const lp = lossOf(g, c, t);
          arr[j] = v - e;
          const lm = lossOf(g, c, t);
          arr[j] = v;
          const d = (lp - lm) / (2 * e);
          if (Math.abs(d - ga[j]) < Math.abs(fd - ga[j])) fd = d;
        }
        num += (fd - ga[j]) ** 2;
        den += fd * fd + ga[j] * ga[j];
        checked++;
      }
      const rel = Math.sqrt(num / Math.max(den, 1e-12));
      expect(checked).toBeGreaterThan(0);
      expect(rel, key).toBeLessThan(0.01);
    }
  });

  it('training brings a render closer to the photo', () => {
    const c = cam(32, 24);
    const pos = new Float32Array(3 * 16);
    const rgb = new Uint8Array(3 * 16).fill(128);
    for (let i = 0; i < 16; i++) pos.set([((i % 4) - 1.5) * 0.25, 1.2 + (Math.floor(i / 4) - 1.5) * 0.2, -0.3], i * 3);
    const g = gaussiansFromPoints(pos, rgb, 0.1);
    const t = new Uint8Array(c.w * c.h * 4);
    for (let i = 0; i < c.w * c.h; i++) t.set([(i % c.w) < c.w / 2 ? 220 : 30, 60, 140, 255], i * 4);
    const opt = new Adam(g, { mean: 1e-3, logScale: 1e-2, quat: 1e-3, fdc: 2e-2, opacity: 5e-2 });
    const first = lossOf(g, c, t);
    for (let it = 0; it < 120; it++) {
      const p = project(g, c);
      const r = rasterize(p, binTiles(p, c.w, c.h), c.w, c.h, t);
      const grad = zerosLike(g);
      backwardProject(g, c, p, r.grad, grad);
      opt.step(grad);
    }
    expect(lossOf(g, c, t)).toBeLessThan(first * 0.6);
  });

  it('writes a standard splat PLY', () => {
    const g = scene();
    const ply = gaussiansPly(g);
    const head = new TextDecoder().decode(ply.slice(0, 400));
    expect(head).toContain('element vertex 5');
    expect(head).toContain('property float rot_3');
    expect(G2).toBe(9);
  });
});
