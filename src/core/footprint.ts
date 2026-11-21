import { rotate, type Vec2 } from './geom2d.js';
import { convexHull, pointInPolygon } from './poly.js';

/**
 * The basement's floor area as a set of square cells in the room's axis frame,
 * stored run-length per row. Comes from the scanned floor (holes under
 * furniture filled) and is merged with the area the walls enclose.
 */
export interface Footprint {
  axis: number;
  cell: number;
  /** [row j, first column i0, last column i1] (inclusive). */
  rows: Array<[number, number, number]>;
}

export type CellSet = Set<string>;

const key = (i: number, j: number) => `${i},${j}`;

export function cellsOf(f: Footprint): CellSet {
  const s: CellSet = new Set();
  for (const [j, i0, i1] of f.rows) for (let i = i0; i <= i1; i++) s.add(key(i, j));
  return s;
}

export function fromCells(cells: CellSet, axis: number, cell: number): Footprint {
  const byRow = new Map<number, number[]>();
  for (const k of cells) {
    const [i, j] = k.split(',').map(Number);
    let r = byRow.get(j);
    if (!r) byRow.set(j, (r = []));
    r.push(i);
  }
  const rows: Footprint['rows'] = [];
  for (const [j, is] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    is.sort((a, b) => a - b);
    let s = is[0];
    let p = is[0];
    for (const i of is.slice(1)) {
      if (i !== p + 1) {
        rows.push([j, s, p]);
        s = i;
      }
      p = i;
    }
    rows.push([j, s, p]);
  }
  return { axis, cell, rows };
}

/** Cell center in plan coordinates. */
export function cellCenter(f: { axis: number; cell: number }, i: number, j: number): Vec2 {
  return rotate({ x: (i + 0.5) * f.cell, y: (j + 0.5) * f.cell }, f.axis);
}

export function cellAt(f: { axis: number; cell: number }, p: Vec2): [number, number] {
  const l = rotate(p, -f.axis);
  return [Math.floor(l.x / f.cell), Math.floor(l.y / f.cell)];
}

/**
 * Floor footprint from scanned floor points: close small gaps, then fill
 * enclosed holes (the floor under furniture is never seen).
 */
export function footprintFromFloor(floorPts: Vec2[], axis: number, cell = 4): Footprint | null {
  if (floorPts.length < 50) return null;
  const s: CellSet = new Set();
  let iMin = Infinity;
  let iMax = -Infinity;
  let jMin = Infinity;
  let jMax = -Infinity;
  for (const p of floorPts) {
    const [i, j] = cellAt({ axis, cell }, p);
    s.add(key(i, j));
  }
  // Closing: dilate then erode by r cells.
  const r = 3;
  const dil: CellSet = new Set();
  for (const k of s) {
    const [i, j] = k.split(',').map(Number);
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) if (di * di + dj * dj <= r * r) dil.add(key(i + di, j + dj));
  }
  const closed: CellSet = new Set();
  for (const k of dil) {
    const [i, j] = k.split(',').map(Number);
    let all = true;
    for (let di = -r; di <= r && all; di++) for (let dj = -r; dj <= r && all; dj++) if (di * di + dj * dj <= r * r && !dil.has(key(i + di, j + dj))) all = false;
    if (all) {
      closed.add(k);
      iMin = Math.min(iMin, i);
      iMax = Math.max(iMax, i);
      jMin = Math.min(jMin, j);
      jMax = Math.max(jMax, j);
    }
  }
  if (!closed.size) return null;
  // Fill holes: anything not reachable from outside the bounding box.
  const outside: CellSet = new Set();
  const stack: Array<[number, number]> = [[iMin - 1, jMin - 1]];
  outside.add(key(iMin - 1, jMin - 1));
  while (stack.length) {
    const [i, j] = stack.pop()!;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < iMin - 1 || ni > iMax + 1 || nj < jMin - 1 || nj > jMax + 1) continue;
      const k = key(ni, nj);
      if (outside.has(k) || closed.has(k)) continue;
      outside.add(k);
      stack.push([ni, nj]);
    }
  }
  const filled: CellSet = new Set();
  for (let i = iMin; i <= iMax; i++) for (let j = jMin; j <= jMax; j++) if (!outside.has(key(i, j))) filled.add(key(i, j));
  return fromCells(filled, axis, cell);
}

/** Union of a footprint and polygons (e.g. the area inside the walls), in the footprint's frame. */
export function unionArea(base: Footprint | null, polys: Vec2[][], axis: number, cell = 4): Footprint | null {
  const frame = base ?? { axis, cell, rows: [] };
  const cells = base ? cellsOf(base) : new Set<string>();
  for (const poly of polys) {
    if (poly.length < 3) continue;
    let iMin = Infinity;
    let iMax = -Infinity;
    let jMin = Infinity;
    let jMax = -Infinity;
    for (const p of poly) {
      const [i, j] = cellAt(frame, p);
      iMin = Math.min(iMin, i);
      iMax = Math.max(iMax, i);
      jMin = Math.min(jMin, j);
      jMax = Math.max(jMax, j);
    }
    for (let i = iMin; i <= iMax; i++) for (let j = jMin; j <= jMax; j++) if (pointInPolygon(cellCenter(frame, i, j), poly)) cells.add(key(i, j));
  }
  return cells.size ? fromCells(cells, frame.axis, frame.cell) : null;
}

/** Merge an old footprint into a new one (re-sampled into the new frame). */
export function mergeFootprints(next: Footprint, old: Footprint | null): Footprint {
  if (!old) return next;
  const cells = cellsOf(next);
  for (const [j, i0, i1] of old.rows) {
    for (let i = i0; i <= i1; i++) {
      const [ni, nj] = cellAt(next, cellCenter(old, i, j));
      cells.add(key(ni, nj));
    }
  }
  return fromCells(cells, next.axis, next.cell);
}

export function hullOf(points: Vec2[]): Vec2[] {
  return points.length >= 3 ? convexHull(points) : [];
}

/**
 * The open floor/ceiling area outside closed rooms, as rectangles (plan
 * polygons): the scanned footprint plus the area the walls span, minus rooms.
 * `rooms` are the room outlines (wall centerlines).
 */
export function openFloorRects(
  footprint: Footprint | null,
  wallPoints: Vec2[],
  rooms: Vec2[][],
  axis: number,
): { rects: Vec2[][]; areaSqFt: number } {
  const hull = hullOf(wallPoints);
  const area = unionArea(footprint, hull.length >= 3 ? [hull] : [], footprint?.axis ?? axis);
  if (!area) return { rects: [], areaSqFt: 0 };
  const rects: Vec2[][] = [];
  let cells = 0;
  const c = area.cell;
  for (const [j, i0, i1] of area.rows) {
    let s = -1;
    for (let i = i0; i <= i1 + 1; i++) {
      const free = i <= i1 && !rooms.some((r) => pointInPolygon(cellCenter(area, i, j), r));
      if (free && s < 0) s = i;
      if (!free && s >= 0) {
        cells += i - s;
        rects.push(
          [
            { x: s * c, y: j * c },
            { x: i * c, y: j * c },
            { x: i * c, y: (j + 1) * c },
            { x: s * c, y: (j + 1) * c },
          ].map((p) => rotate(p, area.axis)),
        );
        s = -1;
      }
    }
  }
  return { rects, areaSqFt: (cells * c * c) / 144 };
}
