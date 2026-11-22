import type { Vec2 } from './geom2d.js';

/**
 * Push/pull (the SketchUp move): drag one face of a box and it moves along its
 * normal, the opposite face stays. Plan inches; z is height.
 */

export type Face = { side: number } | 'top' | 'bottom';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Outward normal of edge i (poly[i] -> poly[i+1]) of a polygon, either winding. */
export function edgeNormal(poly: Vec2[], i: number): Vec2 {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // Signed area tells winding: CCW -> outward is the right-hand normal.
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    area += p.x * q.y - q.x * p.y;
  }
  const s = area >= 0 ? 1 : -1;
  return { x: (s * (b.y - a.y)) / L, y: (s * -(b.x - a.x)) / L };
}

/** Which face a hit with this (plan-space) normal is on. */
export function faceFromNormal(poly: Vec2[], n: Vec3): Face {
  if (n.z > 0.7) return 'top';
  if (n.z < -0.7) return 'bottom';
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const e = edgeNormal(poly, i);
    const d = e.x * n.x + e.y * n.y;
    if (d > bestDot) [best, bestDot] = [i, d];
  }
  return { side: best };
}

/** Move side `i` out by `delta` inches (negative pulls it in). Null if the box would turn inside out. */
export function pushSide(poly: Vec2[], i: number, delta: number, minSize = 1): Vec2[] | null {
  const n = edgeNormal(poly, i);
  const out = poly.map((p) => ({ ...p }));
  const j = (i + 1) % poly.length;
  out[i] = { x: poly[i].x + n.x * delta, y: poly[i].y + n.y * delta };
  out[j] = { x: poly[j].x + n.x * delta, y: poly[j].y + n.y * delta };
  // Depth across the face must stay positive: distance from the moved edge to the far vertices.
  for (let k = 0; k < poly.length; k++) {
    if (k === i || k === j) continue;
    const dpt = (out[i].x - poly[k].x) * n.x + (out[i].y - poly[k].y) * n.y;
    if (dpt < minSize) return null;
  }
  return out;
}

/**
 * How far along a line (through p, direction u) the aim ray passes closest,
 * in the line's units. The drag reads this, so you can point anywhere.
 */
export function rayLineParam(o: Vec3, d: Vec3, p: Vec3, u: Vec3): number | null {
  // Closest points between o + t d and p + s u.
  const w = { x: o.x - p.x, y: o.y - p.y, z: o.z - p.z };
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  const b = d.x * u.x + d.y * u.y + d.z * u.z;
  const c = u.x * u.x + u.y * u.y + u.z * u.z;
  const dd = d.x * w.x + d.y * w.y + d.z * w.z;
  const e = u.x * w.x + u.y * w.y + u.z * w.z;
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9) return null; // pointing along the line
  return (a * e - b * dd) / den;
}

/** Width and depth of a rectangle footprint, inches. */
export function rectSize(poly: Vec2[]): { w: number; d: number } {
  const w = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y);
  const d = Math.hypot(poly[2].x - poly[1].x, poly[2].y - poly[1].y);
  return { w, d };
}

/** Which face a point on the box's surface is on (by position, so mesh winding doesn't matter). */
export function faceAt(poly: Vec2[], z0: number, z1: number, p: Vec3): Face {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2));
    const d = Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
    if (d < bestD) [best, bestD] = [i, d];
  }
  const dTop = Math.abs(p.z - z1);
  const dBot = Math.abs(p.z - z0);
  if (Math.min(dTop, dBot) < bestD) return dTop <= dBot ? 'top' : 'bottom';
  return { side: best };
}
