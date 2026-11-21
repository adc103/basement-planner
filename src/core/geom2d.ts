/** Small 2D vector helpers. Plan space: x/y in inches. */

export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
/** Left-hand perpendicular (rotate +90°). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (rad: number): Vec2 => ({ x: Math.cos(rad), y: Math.sin(rad) });
export const rotate = (a: Vec2, rad: number): Vec2 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/** Infinite line defined by a point and a unit direction. */
export interface Line {
  p: Vec2;
  d: Vec2;
}

/** Intersection of two infinite lines; null if (nearly) parallel. */
export function intersectLines(a: Line, b: Line): Vec2 | null {
  const den = cross(a.d, b.d);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(b.p, a.p), b.d) / den;
  return add(a.p, scale(a.d, t));
}

/** Closest point on an infinite line, plus signed parameter t along d. */
export function projectOnLine(pt: Vec2, line: Line): { point: Vec2; t: number } {
  const t = dot(sub(pt, line.p), line.d);
  return { point: add(line.p, scale(line.d, t)), t };
}

/** Closest point on segment ab, with t in [0,1]. */
export function projectOnSegment(pt: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return { point: { ...a }, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / l2));
  return { point: add(a, scale(ab, t)), t };
}

export function distToSegment(pt: Vec2, a: Vec2, b: Vec2): number {
  return dist(pt, projectOnSegment(pt, a, b).point);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Shoelace area (signed; positive = counter-clockwise). */
export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
