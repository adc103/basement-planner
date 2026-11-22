import { add, dot, len, norm, perp, scale, sub, type Vec2 } from './geom2d.js';

/**
 * Trace a real wall from two taps on its surface. The wall runs from the first tap
 * to the second (the taps set the direction, not the headset's surface normal,
 * which is too noisy on walls). The centerline sits half the thickness behind the
 * face, on the far side from where you stand. Returns null if the taps are closer
 * than 6" or you are standing in line with them.
 */
export function captureWall(
  p1: Vec2,
  p2: Vec2,
  eye: Vec2,
  thickness: number,
): { a: Vec2; b: Vec2; faceA: Vec2; faceB: Vec2 } | null {
  const along = sub(p2, p1);
  if (len(along) < 6) return null;
  const d = norm(along);
  let n = perp(d);
  const side = dot(sub(eye, scale(add(p1, p2), 0.5)), n);
  if (Math.abs(side) < 1) return null;
  if (side < 0) n = scale(n, -1); // n points out of the wall, toward you
  const back = scale(n, -thickness / 2);
  return { a: add(p1, back), b: add(p2, back), faceA: p1, faceB: p2 };
}
