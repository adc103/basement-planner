import { describe, expect, it } from 'vitest';
import { alignPhoto, PhotoAligner, projectInto, rotatedCam } from '../src/core/photoAlign';

const cam = { camToRoot: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.2, 1.5, 0.1, 1]), fx: 300, fy: 300, cx: 160, cy: 120 };

describe('lining a photo up with the scan', () => {
  it('builds the correction into the camera the same way it projects', () => {
    const r = rotatedCam(cam, 0.03, -0.02, 0.01);
    for (const p of [[0.5, 1.2, -2], [-0.4, 2, -1.5], [0.1, 0.4, -3]]) {
      const a = projectInto(cam, p[0], p[1], p[2], 0.03, -0.02, 0.01);
      const b = projectInto(r, p[0], p[1], p[2]);
      expect(b.u).toBeCloseTo(a.u, 3);
      expect(b.v).toBeCloseTo(a.v, 3);
    }
  });

  it('finds a photo turned 3 degrees off and corrects it', () => {
    // A wall 2 m ahead with a pattern; the photo was taken from a camera turned 3 deg (yaw)
    // and 1.5 deg (pitch) from the pose we were told.
    const pattern = (x: number, y: number) => 128 + 60 * Math.sin(x * 9) * Math.cos(y * 7) + 40 * Math.sin(x * 23 + y * 3);
    const truth = rotatedCam(cam, (3 * Math.PI) / 180, (1.5 * Math.PI) / 180, 0);
    const w = 320, h = 240;
    const g = new Float32Array(w * h);
    // Render: cast each pixel's ray onto the wall z = -1.9.
    const M = truth.camToRoot;
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
      const dx = (u - cam.cx) / cam.fx, dy = -(v - cam.cy) / cam.fy;
      const d = [M[0] * dx + M[4] * dy - M[8], M[1] * dx + M[5] * dy - M[9], M[2] * dx + M[6] * dy - M[10]];
      const t = (-1.9 - M[14]) / d[2];
      g[v * w + u] = pattern(M[12] + d[0] * t, M[13] + d[1] * t);
    }
    const pts: number[] = [];
    const ref: number[] = [];
    for (let x = -0.8; x <= 1.2; x += 0.02) for (let y = 0.9; y <= 2.1; y += 0.02) {
      pts.push(x, y, -1.9);
      ref.push(pattern(x, y));
    }
    const a = alignPhoto(cam, { g, w, h }, pts, ref);
    expect(a.after).toBeGreaterThan(a.before + 0.2);
    expect((a.yaw * 180) / Math.PI).toBeCloseTo(3, 0);
    expect((a.pitch * 180) / Math.PI).toBeCloseTo(1.5, 0);
  });

  it('lines each new photo up with the ones before it, as a scan goes', () => {
    const pattern = (x: number, y: number) => 128 + 60 * Math.sin(x * 9) * Math.cos(y * 7) + 40 * Math.sin(x * 23 + y * 3);
    const w = 320, h = 240;
    const render = (c: typeof cam) => {
      const g = new Uint8Array(w * h);
      const M = c.camToRoot;
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
        const dx = (u - c.cx) / c.fx, dy = -(v - c.cy) / c.fy;
        const d = [M[0] * dx + M[4] * dy - M[8], M[1] * dx + M[5] * dy - M[9], M[2] * dx + M[6] * dy - M[10]];
        const t = (-1.9 - M[14]) / d[2];
        g[v * w + u] = Math.max(0, Math.min(255, pattern(M[12] + d[0] * t, M[13] + d[1] * t)));
      }
      return { g, w, h };
    };
    const pts: number[] = [];
    for (let x = -0.8; x <= 1.2; x += 0.02) for (let y = 0.9; y <= 2.1; y += 0.02) pts.push(x, y, -1.9);
    const P = Float32Array.from(pts);
    const al = new PhotoAligner();
    // First photo: its pose is right. Second: told the same pose, but really turned 2 deg.
    const first = al.add(cam, render(cam), P);
    expect(first.cam).toBe(cam);
    const turned = rotatedCam(cam, (2 * Math.PI) / 180, 0, 0);
    const second = al.add(cam, render(turned), P);
    expect(second.after).toBeGreaterThan(second.before + 0.2);
    // Its corrected camera projects like the true one.
    const a = projectInto(second.cam, 0.3, 1.5, -1.9);
    const b = projectInto(turned, 0.3, 1.5, -1.9);
    expect(Math.hypot(a.u - b.u, a.v - b.v)).toBeLessThan(1.5);
  });
});
