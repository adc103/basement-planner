import { describe, expect, it } from 'vitest';
import { exportPly } from '../src/core/exportPly';

describe('exportPly', () => {
  it('writes meters, z up, walls squared to the axes', () => {
    const pts = [];
    // A 100" wall rotated 20 degrees, 50" tall.
    const a = (20 * Math.PI) / 180;
    for (let t = 0; t <= 100; t += 2) for (let z = 0; z <= 50; z += 10) pts.push({ x: t * Math.cos(a), y: t * Math.sin(a), z: z + 3 });
    const ply = exportPly(pts, 3);
    const body = ply.split('end_header\n')[1].trim().split('\n').map((l) => l.split(' ').map(Number));
    expect(ply).toContain(`element vertex ${pts.length}`);
    expect(body.length).toBe(pts.length);
    const ys = body.map((v) => v[1]);
    const xs = body.map((v) => v[0]);
    const zs = body.map((v) => v[2]);
    const span = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(Math.min(span(xs), span(ys))).toBeLessThan(0.01);
    expect(Math.max(span(xs), span(ys))).toBeCloseTo(2.54, 1);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeCloseTo(1.27, 2);
  });
});
