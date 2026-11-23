import { describe, expect, it } from 'vitest';
import { pointsPly, splatDataset, zipStore } from '../src/core/splatDataset';

describe('splat training set', () => {
  const view = {
    jpeg: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]),
    w: 640,
    h: 480,
    camToRoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1.5, -3, 1],
    fx: 500,
    fy: 500,
    cx: 320,
    cy: 250,
  };
  const seed = { pos: new Float32Array([0, 1, 2, 3, 4, 5]), rgb: new Uint8Array([10, 20, 30, 40, 50, 60]) };

  it('writes cameras camera-to-world, row by row, with each lens', () => {
    const files = splatDataset([view, view], seed);
    expect(files.map((f) => f.name)).toEqual(['transforms.json', 'images/0001.jpg', 'images/0002.jpg', 'points.ply']);
    const t = JSON.parse(new TextDecoder().decode(files[0].data));
    expect(t.ply_file_path).toBe('points.ply');
    expect(t.frames[0].transform_matrix[0]).toEqual([1, 0, 0, 2]);
    expect(t.frames[0].transform_matrix[2]).toEqual([0, 0, 1, -3]);
    expect(t.frames[1].fl_x).toBe(500);
    expect(t.frames[1].cy).toBe(250);
  });

  it('writes points as a binary PLY', () => {
    const ply = pointsPly(seed);
    const head = new TextDecoder().decode(ply.slice(0, 200));
    expect(head).toContain('element vertex 2');
    const body = ply.slice(head.indexOf('end_header\n') + 11);
    expect(body.length).toBe(30);
    expect(new DataView(body.buffer, body.byteOffset).getFloat32(19, true)).toBeCloseTo(4);
    expect(body[27]).toBe(40);
  });

  it('packs files into a zip that lists them all', () => {
    const z = zipStore(splatDataset([view], seed));
    const dv = new DataView(z.buffer);
    const end = z.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(3);
    const cdOffset = dv.getUint32(end + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
  });
});
