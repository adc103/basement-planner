import { add, dot, len, norm, perp, scale, sub, type Vec2 } from './geom2d.js';

/**
 * Point-and-capture: two hits on a real wall surface -> an existing wall centerline.
 * p1/p2 are surface points in plan inches; n1/n2 the horizontal surface normals
 * (pointing out of the wall, toward you). Returns null if the hits are unusable.
 */
export function captureWall(
  p1: Vec2,
  n1: Vec2,
  p2: Vec2,
  n2: Vec2 | null,
  thickness: number,
): { a: Vec2; b: Vec2; faceA: Vec2; faceB: Vec2 } | null {
  if (len(n1) < 0.2) return null; // hit a floor/ceiling, not a wall
  let n = norm(n1);
  if (n2 && len(n2) > 0.2) {
    const m = norm(n2);
    if (dot(n, m) > 0.8) n = norm(add(n, m)); // same wall: average the normals
  }
  const d = perp(n);
  const t2 = dot(sub(p2, p1), d);
  if (Math.abs(t2) < 6) return null; // need at least 6" between the two points
  const faceA = p1;
  const faceB = add(p1, scale(d, t2));
  const back = scale(n, -thickness / 2);
  return { a: add(faceA, back), b: add(faceB, back), faceA, faceB };
}
