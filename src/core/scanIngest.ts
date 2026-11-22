import type { FreeGrid } from './freeSpace.js';
import { unprojectDepth, type ScanMap } from './scanMap.js';

/**
 * One depth reading, in the plan root's frame (meters, y up), with everything
 * needed to turn it into points. The headset builds these live; a recording is
 * a list of them, so a saved scan replays through exactly the same code.
 */
export interface DepthFrame {
  /** Seconds since the scan started. */
  t: number;
  w: number;
  h: number;
  /** Depth per pixel in millimeters, row 0 = bottom. 0 = no reading. */
  depthMM: Uint16Array;
  /** The view's projection matrix (column-major). */
  proj: Float32Array;
  /** View space -> plan-root meters (column-major). */
  viewToRoot: Float32Array;
  /** Head and controller/hand positions, plan-root meters. */
  head: [number, number, number];
  handL: [number, number, number];
  handR: [number, number, number];
}

export const DEPTH_MIN_M = 0.35;
export const DEPTH_MAX_M = 4.5;
const INCH_M = 0.0254;

/** Your arm: segment from just below the head to the hand, ~9" around it. */
function nearArm(x: number, y: number, z: number, hd: readonly number[], h: readonly number[]): boolean {
  const sx = hd[0];
  const sy = hd[1] - 0.25;
  const sz = hd[2];
  const dx = h[0] - sx;
  const dy = h[1] - sy;
  const dz = h[2] - sz;
  const L2 = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - sx) * dx + (y - sy) * dy + (z - sz) * dz) / L2));
  const ex = x - (sx + dx * t);
  const ey = y - (sy + dy * t);
  const ez = z - (sz + dz * t);
  return ex * ex + ey * ey + ez * ez < 0.22 * 0.22;
}

/**
 * Pixels that see your own body or arms (1 = drop). Your torso and legs are
 * the column under your head; an arm is the line from shoulder to hand.
 */
export function bodyMask(f: DepthFrame): Uint8Array {
  const M = f.viewToRoot;
  const hd = f.head;
  const mask = new Uint8Array(f.w * f.h);
  for (let j = 0; j < f.h; j++) {
    for (let i = 0; i < f.w; i++) {
      const m = f.depthMM[j * f.w + i] / 1000;
      if (m < DEPTH_MIN_M || m > DEPTH_MAX_M) continue;
      const p = unprojectDepth((i + 0.5) / f.w, (j + 0.5) / f.h, m, f.proj);
      const x = M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12];
      const y = M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13];
      const z = M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14];
      const bx = x - hd[0];
      const bz = z - hd[2];
      if ((bx * bx + bz * bz < 0.45 * 0.45 && y < hd[1] + 0.2) || nearArm(x, y, z, hd, f.handL) || nearArm(x, y, z, hd, f.handR)) mask[j * f.w + i] = 1;
    }
  }
  return mask;
}

/**
 * Add one depth frame to the point map and free-space grid (plan inches).
 * Drops points on your own body and arms. Returns points added.
 */
export function ingestFrame(f: DepthFrame, map: ScanMap, free: FreeGrid | null, stride = 1): number {
  const M = f.viewToRoot;
  const hd = f.head;
  const ex = hd[0] / INCH_M;
  const ey = hd[2] / INCH_M;
  const ez = hd[1] / INCH_M;
  let n = 0;
  let k = 0;
  for (let j = 0; j < f.h; j += stride) {
    for (let i = 0; i < f.w; i += stride) {
      const m = f.depthMM[j * f.w + i] / 1000;
      if (m < DEPTH_MIN_M || m > DEPTH_MAX_M) continue;
      const p = unprojectDepth((i + 0.5) / f.w, (j + 0.5) / f.h, m, f.proj);
      const x = M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12];
      const y = M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13];
      const z = M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14];
      const bx = x - hd[0];
      const bz = z - hd[2];
      if (bx * bx + bz * bz < 0.45 * 0.45 && y < hd[1] + 0.2) continue; // torso and legs
      if (nearArm(x, y, z, hd, f.handL) || nearArm(x, y, z, hd, f.handR)) continue;
      const px = x / INCH_M;
      const py = z / INCH_M;
      const pz = y / INCH_M;
      map.add(px, py, pz);
      if (free && (k++ & 1) === 0) free.carve(ex, ey, ez, px, py, pz);
      n++;
    }
  }
  return n;
}

// --- Recording file format ---------------------------------------------------
// [u32 header length][header JSON][pad to 4][frames], each frame:
// 42 float32 (t, proj 16, viewToRoot 16, head 3, handL 3, handR 3) then w*h uint16.

const MAGIC = 'basement-planner-scan';
const FLOATS = 42;

export interface RecordingHeader {
  format: typeof MAGIC;
  version: 1;
  w: number;
  h: number;
  frames: number;
  createdAt: string;
  userAgent?: string;
}

export function encodeRecording(frames: DepthFrame[], meta: { userAgent?: string } = {}): Uint8Array {
  const w = frames[0]?.w ?? 0;
  const h = frames[0]?.h ?? 0;
  const header: RecordingHeader = { format: MAGIC, version: 1, w, h, frames: frames.length, createdAt: new Date().toISOString(), ...meta };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const hPad = Math.ceil((4 + hb.length) / 4) * 4;
  const per = FLOATS * 4 + w * h * 2;
  const out = new Uint8Array(hPad + per * frames.length);
  new DataView(out.buffer).setUint32(0, hb.length, true);
  out.set(hb, 4);
  let o = hPad;
  const fl = new Float32Array(FLOATS);
  for (const f of frames) {
    if (f.w !== w || f.h !== h) throw new Error('frames must share one size');
    fl[0] = f.t;
    fl.set(f.proj, 1);
    fl.set(f.viewToRoot, 17);
    fl.set(f.head, 33);
    fl.set(f.handL, 36);
    fl.set(f.handR, 39);
    out.set(new Uint8Array(fl.buffer), o);
    o += FLOATS * 4;
    out.set(new Uint8Array(f.depthMM.buffer, f.depthMM.byteOffset, w * h * 2), o);
    o += w * h * 2;
  }
  return out;
}

export function decodeRecording(bytes: Uint8Array): { header: RecordingHeader; frames: DepthFrame[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl))) as RecordingHeader;
  if (header.format !== MAGIC || header.version !== 1) throw new Error('Not a basement scan recording');
  const { w, h } = header;
  let o = Math.ceil((4 + hl) / 4) * 4;
  const frames: DepthFrame[] = [];
  for (let i = 0; i < header.frames; i++) {
    // Copy so every array is aligned and independent of the file buffer.
    const fl = new Float32Array(bytes.slice(o, o + FLOATS * 4).buffer);
    o += FLOATS * 4;
    const depthMM = new Uint16Array(bytes.slice(o, o + w * h * 2).buffer);
    o += w * h * 2;
    frames.push({
      t: fl[0],
      w,
      h,
      depthMM,
      proj: fl.slice(1, 17),
      viewToRoot: fl.slice(17, 33),
      head: [fl[33], fl[34], fl[35]],
      handL: [fl[36], fl[37], fl[38]],
      handR: [fl[39], fl[40], fl[41]],
    });
  }
  return { header, frames };
}
