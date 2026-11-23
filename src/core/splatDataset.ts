/**
 * A scan as a Gaussian-splat training set, in the Nerfstudio layout that splat trainers
 * (Brush, gsplat, nerfstudio) read: transforms.json with each photo's camera (lined up
 * with the scan) and lens, the photos, and the scan's colored points to start from.
 * Everything stays in the scan's own coordinates (meters, y up), so a splat trained from
 * it lands back on the room as it is.
 */

export interface TrainingView {
  /** JPEG bytes. */
  jpeg: Uint8Array;
  w: number;
  h: number;
  /** Camera -> root, column-major; camera looks down -z, y up (OpenGL, as Nerfstudio). */
  camToRoot: ArrayLike<number>;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface SeedPoints {
  /** xyz per point, meters. */
  pos: Float32Array;
  /** rgb per point, 0-255. */
  rgb: Uint8Array;
}

export interface DatasetFile {
  name: string;
  data: Uint8Array;
}

const enc = new TextEncoder();

/** Points as a binary PLY (x y z float, red green blue uchar). */
export function pointsPly(p: SeedPoints): Uint8Array {
  const n = p.pos.length / 3;
  const header = enc.encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`,
  );
  const out = new Uint8Array(header.length + n * 15);
  out.set(header, 0);
  const dv = new DataView(out.buffer);
  let o = header.length;
  for (let i = 0; i < n; i++) {
    dv.setFloat32(o, p.pos[i * 3], true);
    dv.setFloat32(o + 4, p.pos[i * 3 + 1], true);
    dv.setFloat32(o + 8, p.pos[i * 3 + 2], true);
    out[o + 12] = p.rgb[i * 3];
    out[o + 13] = p.rgb[i * 3 + 1];
    out[o + 14] = p.rgb[i * 3 + 2];
    o += 15;
  }
  return out;
}

/** The dataset's files: transforms.json, images/NNNN.jpg, points.ply. */
export function splatDataset(views: TrainingView[], seed: SeedPoints): DatasetFile[] {
  const files: DatasetFile[] = [];
  const frames = views.map((v, i) => {
    const name = `images/${String(i + 1).padStart(4, '0')}.jpg`;
    files.push({ name, data: v.jpeg });
    const M = v.camToRoot;
    // Row-major 4x4 camera-to-world.
    const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => +(+M[c * 4 + r]).toFixed(7)));
    return { file_path: name, transform_matrix: rows, fl_x: v.fx, fl_y: v.fy, cx: v.cx, cy: v.cy, w: v.w, h: v.h };
  });
  const transforms = { camera_model: 'PERSPECTIVE', ply_file_path: 'points.ply', frames };
  files.unshift({ name: 'transforms.json', data: enc.encode(JSON.stringify(transforms, null, 1)) });
  files.push({ name: 'points.ply', data: pointsPly(seed) });
  return files;
}

let crcTable: Uint32Array | null = null;
function crc32(d: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain (stored, uncompressed) zip: the photos are JPEGs already. */
export function zipStore(files: DatasetFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The scan's points as a plain (untrained) 3D Gaussian splat PLY: small round splats in
 * the points' colors. Readable by every splat viewer; a starting point, and a check
 * that a splat lands on the room.
 */
export function seedSplatPly(p: SeedPoints, size = 0.02): Uint8Array {
  const n = p.pos.length / 3;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = enc.encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((q) => `property float ${q}`).join('\n')}\nend_header\n`);
  const stride = props.length * 4;
  const out = new Uint8Array(header.length + n * stride);
  out.set(header, 0);
  const dv = new DataView(out.buffer);
  const C0 = 0.28209479177387814;
  const ls = Math.log(size);
  for (let i = 0; i < n; i++) {
    const o = header.length + i * stride;
    const v = [
      p.pos[i * 3],
      p.pos[i * 3 + 1],
      p.pos[i * 3 + 2],
      0,
      0,
      0,
      (p.rgb[i * 3] / 255 - 0.5) / C0,
      (p.rgb[i * 3 + 1] / 255 - 0.5) / C0,
      (p.rgb[i * 3 + 2] / 255 - 0.5) / C0,
      2.2,
      ls,
      ls,
      ls,
      1,
      0,
      0,
      0,
    ];
    for (let k = 0; k < v.length; k++) dv.setFloat32(o + k * 4, v[k], true);
  }
  return out;
}
