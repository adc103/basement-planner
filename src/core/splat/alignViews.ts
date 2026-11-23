import { PhotoAligner } from '../photoAlign.js';

/** A training photo at training size, with its lens for its original size (w0 x h0). */
export interface ViewToAlign {
  camToRoot: ArrayLike<number>;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  w0: number;
  h0: number;
  rgba: Uint8Array | Uint8ClampedArray;
  w: number;
  h: number;
}

/**
 * Line photos up with the scan and each other, one by one in capture order (each against
 * earlier neighbours that see the same surface). Works on half the training size: plenty
 * to line up by, and it keeps the aligner's memory small. Returns the corrected
 * camera -> root of each.
 */
export class TrainViewAligner {
  private aligner = new PhotoAligner(400, 8);
  constructor(private pts: Float32Array) {}

  add(v: ViewToAlign): Float32Array {
    const gw = v.w >> 1, gh = v.h >> 1;
    const sx = gw / v.w0, sy = gh / v.h0;
    const gray = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let acc = 0;
        for (let d = 0; d < 4; d++) {
          const k = ((2 * y + (d >> 1)) * v.w + 2 * x + (d & 1)) * 4;
          acc += 0.3 * v.rgba[k] + 0.59 * v.rgba[k + 1] + 0.11 * v.rgba[k + 2];
        }
        gray[y * gw + x] = acc / 4;
      }
    }
    const r = this.aligner.add({ camToRoot: Float32Array.from(v.camToRoot), fx: v.fx * sx, fy: v.fy * sy, cx: v.cx * sx, cy: v.cy * sy }, { g: gray, w: gw, h: gh }, this.pts);
    return Float32Array.from(r.cam.camToRoot);
  }
}

/** Every k-th point, at most n. */
export function thinPoints(pos: Float32Array, n: number): Float32Array {
  const count = pos.length / 3;
  const step = Math.max(1, Math.ceil(count / n));
  const out = new Float32Array(Math.ceil(count / step) * 3);
  for (let i = 0, j = 0; i < count; i += step, j++) out.set(pos.subarray(i * 3, i * 3 + 3), j * 3);
  return out;
}
