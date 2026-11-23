/**
 * Head poses recorded every frame, and the pose at any moment between them. The camera
 * photo's capture time falls between frames; picking the nearest frame's pose is off by
 * up to half a frame (at 100 degrees/s, about 2 cm at 2 m), so interpolate: position
 * linearly, rotation along the shortest arc (slerp).
 */

export interface PoseSample {
  /** Seconds. */
  t: number;
  /** View -> root, column-major 4x4. */
  m: Float32Array | number[];
}

type Quat = [number, number, number, number];

function quatOf(m: Float32Array | number[]): Quat {
  const m00 = m[0], m11 = m[5], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[6] - m[9]) / s;
    y = (m[8] - m[2]) / s;
    z = (m[1] - m[4]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m[6] - m[9]) / s;
    x = 0.25 * s;
    y = (m[4] + m[1]) / s;
    z = (m[8] + m[2]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m[8] - m[2]) / s;
    x = (m[4] + m[1]) / s;
    y = 0.25 * s;
    z = (m[9] + m[6]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m[1] - m[4]) / s;
    x = (m[8] + m[2]) / s;
    y = (m[9] + m[6]) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const q: Quat = [0, 1, 2, 3].map((i) => a[i] + (bb[i] - a[i]) * t) as Quat;
    const l = Math.hypot(...q) || 1;
    return q.map((v) => v / l) as Quat;
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [0, 1, 2, 3].map((i) => a[i] * wa + bb[i] * wb) as Quat;
}

/** Angle between two rotations, degrees. */
function angleDeg(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

/**
 * The pose at time t (track sorted by time), and how fast the head was turning then
 * (degrees/s: photos taken while turning fast are blurred and land poorly). Null when
 * t is outside the track by more than 50 ms.
 */
export function poseAt(track: PoseSample[], t: number): { m: Float32Array; turnDegPerS: number } | null {
  if (!track.length) return null;
  let i = 0;
  while (i < track.length - 1 && track[i + 1].t < t) i++;
  const a = track[i];
  const b = track[Math.min(track.length - 1, i + 1)];
  if (t < a.t - 0.05 || t > b.t + 0.05) return null;
  const span = b.t - a.t;
  const k = span > 1e-6 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0;
  const qa = quatOf(a.m);
  const qb = quatOf(b.m);
  const [x, y, z, w] = slerp(qa, qb, k);
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  m[12] = a.m[12] + (b.m[12] - a.m[12]) * k;
  m[13] = a.m[13] + (b.m[13] - a.m[13]) * k;
  m[14] = a.m[14] + (b.m[14] - a.m[14]) * k;
  m[15] = 1;
  // Turn rate over about 50 ms around t.
  let j0 = i;
  let j1 = Math.min(track.length - 1, i + 1);
  while (j0 > 0 && t - track[j0].t < 0.025) j0--;
  while (j1 < track.length - 1 && track[j1].t - t < 0.025) j1++;
  const dt = track[j1].t - track[j0].t;
  const turnDegPerS = dt > 1e-3 ? angleDeg(quatOf(track[j0].m), quatOf(track[j1].m)) / dt : 0;
  return { m, turnDegPerS };
}
