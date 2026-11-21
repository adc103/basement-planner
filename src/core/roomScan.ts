import { add, dist, intersectLines, norm, scale, sub, type Vec2 } from './geom2d.js';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface ScanPlane {
  /** Semantic label from the headset's room setup ('wall', 'floor', 'ceiling', ...). */
  label: string;
  /** Polygon points (any 3D space; `toPlan` maps them). */
  points: P3[];
}

export interface ScanResult {
  /** Existing wall centerlines, plan inches. */
  walls: Array<{ a: Vec2; b: Vec2 }>;
  /** Floor and ceiling heights in the plan root's local meters, if seen. */
  floorY: number | null;
  ceilingY: number | null;
}

/** Corners closer than this (inches) are joined at their line intersection. */
const JOIN = 18;

/**
 * Turn detected room planes into existing-wall centerlines.
 * `toPlan` maps a point to plan inches plus its height (meters) in the plan root.
 */
export function wallsFromScan(
  planes: ScanPlane[],
  toPlan: (w: P3) => { p: Vec2; y: number },
  foundationThickness: number,
): ScanResult {
  let floorY: number | null = null;
  let ceilingY: number | null = null;
  const faces: Array<{ a: Vec2; b: Vec2 }> = [];

  for (const pl of planes) {
    const label = pl.label.toLowerCase();
    const pts = pl.points.map(toPlan);
    if (!pts.length) continue;
    const meanY = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    if (label === 'floor') {
      floorY = floorY === null ? meanY : Math.min(floorY, meanY);
    } else if (label === 'ceiling') {
      ceilingY = ceilingY === null ? meanY : Math.max(ceilingY, meanY);
    } else if (label === 'wall') {
      // Horizontal extent of the wall: the furthest pair of points in plan.
      let best = 0;
      let a = pts[0].p;
      let b = pts[0].p;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const d = dist(pts[i].p, pts[j].p);
          if (d > best) {
            best = d;
            a = pts[i].p;
            b = pts[j].p;
          }
        }
      if (best >= 12) faces.push({ a, b });
    }
  }

  if (!faces.length) return { walls: [], floorY, ceilingY };

  // Push each face back by half the foundation thickness, away from the room center,
  // so the wall's inside face stays where the headset saw the real wall.
  const center = faces.reduce((acc, f) => add(acc, scale(add(f.a, f.b), 0.5 / faces.length)), { x: 0, y: 0 });
  const half = foundationThickness / 2;
  const lines = faces.map((f) => {
    const d = norm(sub(f.b, f.a));
    let n = { x: -d.y, y: d.x };
    const mid = scale(add(f.a, f.b), 0.5);
    if ((center.x - mid.x) * n.x + (center.y - mid.y) * n.y > 0) n = scale(n, -1);
    return { a: add(f.a, scale(n, half)), b: add(f.b, scale(n, half)), d };
  });

  // Join neighbouring walls at their true corner (line intersection).
  for (let i = 0; i < lines.length; i++) {
    for (const endI of ['a', 'b'] as const) {
      for (let j = i + 1; j < lines.length; j++) {
        for (const endJ of ['a', 'b'] as const) {
          const pi = lines[i][endI];
          const pj = lines[j][endJ];
          if (dist(pi, pj) > JOIN) continue;
          const x = intersectLines({ p: lines[i].a, d: lines[i].d }, { p: lines[j].a, d: lines[j].d });
          if (x && dist(x, pi) < JOIN * 1.5 && dist(x, pj) < JOIN * 1.5) {
            lines[i][endI] = x;
            lines[j][endJ] = x;
          } else if (!x) {
            const m = scale(add(pi, pj), 0.5);
            lines[i][endI] = m;
            lines[j][endJ] = m;
          }
        }
      }
    }
  }
  return { walls: lines.map((l) => ({ a: l.a, b: l.b })), floorY, ceilingY };
}
