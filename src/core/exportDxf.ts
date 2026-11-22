import { add, scale, type Vec2 } from './geom2d.js';
import { lockMarks } from './lockGeom.js';
import type { Plan } from './plan.js';
import { findRoomFaces } from './rooms.js';
import { formatLength } from './units.js';
import { computeFootprints, wallPrisms } from './wallGeometry.js';

/**
 * The floor plan as a DXF drawing (AutoCAD 2000 text format) that AutoCAD,
 * DraftSight, LibreCAD, QCAD, SketchUp and Fusion open. Units are inches,
 * drawn 1:1, on layers per kind of thing. Plan y is flipped so north is up
 * the same as on the printed plan.
 */

const LAYERS: Array<{ name: string; color: number; ltype?: string }> = [
  { name: 'WALLS-NEW', color: 7 },
  { name: 'WALLS-EXISTING', color: 8 },
  { name: 'WALLS-DEMOLISH', color: 1, ltype: 'DASHED' },
  { name: 'DOORS', color: 4 },
  { name: 'WINDOWS', color: 5 },
  { name: 'ROOMS', color: 3 },
  { name: 'DIMENSIONS', color: 140 },
  { name: 'SOFFITS', color: 30, ltype: 'DASHED' },
  { name: 'OBJECTS', color: 9 },
];

export function exportDxf(plan: Plan): string {
  const o: string[] = [];
  const g = (code: number, value: string | number) => o.push(String(code), typeof value === 'number' ? fmt(value) : value);
  const P = (p: Vec2) => ({ x: p.x, y: -p.y });
  let handle = 0x100;
  const h = () => (handle++).toString(16).toUpperCase();

  // Header: inches, R2000.
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1015');
  g(9, '$INSUNITS');
  g(70, 1);
  g(9, '$MEASUREMENT');
  g(70, 0);
  g(0, 'ENDSEC');

  // Tables: a dashed linetype and the layers.
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, 2);
  for (const lt of [
    { name: 'CONTINUOUS', text: 'Solid line', pat: [] as number[] },
    { name: 'DASHED', text: 'Dashed __ __ __', pat: [6, -3] },
  ]) {
    g(0, 'LTYPE');
    g(2, lt.name);
    g(70, 0);
    g(3, lt.text);
    g(72, 65);
    g(73, lt.pat.length);
    g(40, lt.pat.reduce((s, x) => s + Math.abs(x), 0));
    for (const d of lt.pat) g(49, d);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, LAYERS.length);
  for (const l of LAYERS) {
    g(0, 'LAYER');
    g(2, l.name);
    g(70, 0);
    g(62, l.color);
    g(6, l.ltype ?? 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  const poly = (layer: string, pts: Vec2[], closed = true) => {
    g(0, 'LWPOLYLINE');
    g(5, h());
    g(100, 'AcDbEntity');
    g(8, layer);
    g(100, 'AcDbPolyline');
    g(90, pts.length);
    g(70, closed ? 1 : 0);
    for (const p of pts.map(P)) {
      g(10, p.x);
      g(20, p.y);
    }
  };
  const line = (layer: string, a: Vec2, b: Vec2) => {
    const A = P(a);
    const B = P(b);
    g(0, 'LINE');
    g(5, h());
    g(100, 'AcDbEntity');
    g(8, layer);
    g(100, 'AcDbLine');
    g(10, A.x);
    g(20, A.y);
    g(30, 0);
    g(11, B.x);
    g(21, B.y);
    g(31, 0);
  };
  const text = (layer: string, at: Vec2, s: string, height: number) => {
    const p = P(at);
    g(0, 'TEXT');
    g(5, h());
    g(100, 'AcDbEntity');
    g(8, layer);
    g(100, 'AcDbText');
    g(10, p.x);
    g(20, p.y);
    g(30, 0);
    g(40, height);
    g(1, s.replace(/[^\x20-\x7e]/g, ''));
    g(72, 1); // center
    g(11, p.x);
    g(21, p.y);
    g(31, 0);
    g(100, 'AcDbText');
    g(73, 2); // middle
  };
  const arc = (layer: string, c: Vec2, r: number, a0: number, a1: number) => {
    const p = P(c);
    g(0, 'ARC');
    g(5, h());
    g(100, 'AcDbEntity');
    g(8, layer);
    g(100, 'AcDbCircle');
    g(10, p.x);
    g(20, p.y);
    g(30, 0);
    g(40, r);
    g(100, 'AcDbArc');
    g(50, a0);
    g(51, a1);
  };

  const fps = computeFootprints(plan);
  // Walls: footprints split around openings (base pieces only), per phase.
  for (const w of plan.walls) {
    const fp = fps.get(w.id);
    if (!fp) continue;
    const layer = w.kind === 'new' ? 'WALLS-NEW' : w.demolish ? 'WALLS-DEMOLISH' : 'WALLS-EXISTING';
    for (const pr of wallPrisms(fp, w, plan.openings)) if (pr.z0 < 0.01) poly(layer, pr.poly);
  }
  // Doors: leaf + swing arc; windows: three lines across the wall.
  for (const op of plan.openings) {
    const w = plan.walls.find((x) => x.id === op.wallId);
    const fp = w && fps.get(w.id);
    if (!w || !fp) continue;
    const c = add(fp.a, scale(fp.dir, op.offset));
    const half = op.width / 2;
    if (op.type === 'door') {
      const hs = op.hinge === 'a' ? -1 : 1;
      const side = op.swing === 'left' ? 1 : -1;
      const hinge = add(add(c, scale(fp.dir, hs * half)), scale(fp.normal, side * fp.half));
      const open = add(hinge, scale(fp.normal, side * op.width));
      line('DOORS', hinge, open);
      // Arc from the closed position (along the wall) to open (along the normal), in drawing angles.
      const toAng = (v: Vec2) => (Math.atan2(-v.y, v.x) * 180) / Math.PI;
      const closed = toAng(scale(fp.dir, -hs));
      const opened = toAng(scale(fp.normal, side));
      let a0 = closed;
      let a1 = opened;
      // Keep the 90 degree sweep counter-clockwise for DXF.
      if ((((a1 - a0) % 360) + 360) % 360 > 180) [a0, a1] = [a1, a0];
      arc('DOORS', hinge, op.width, a0, a1);
    } else if (op.type === 'window') {
      for (const s of [-1, 0, 1]) {
        const off = scale(fp.normal, s * fp.half * 0.6);
        line('WINDOWS', add(add(c, scale(fp.dir, -half)), off), add(add(c, scale(fp.dir, half)), off));
      }
    }
  }
  // Rooms: name and area at the center.
  const faces = findRoomFaces(plan);
  for (const r of plan.rooms) {
    const f = faces.find((x) => inPoly(r.seed, x.outline));
    if (!f) continue;
    const ctr = f.inner.reduce((s, p) => ({ x: s.x + p.x / f.inner.length, y: s.y + p.y / f.inner.length }), { x: 0, y: 0 });
    text('ROOMS', ctr, r.name, 6);
    text('ROOMS', { x: ctr.x, y: ctr.y + 9 }, `${Math.round(f.areaSqFt)} sq ft`, 4);
  }
  // Kept distances and every wall's length.
  for (const m of lockMarks(plan)) {
    if (!m.line) continue;
    line('DIMENSIONS', m.line[0], m.line[1]);
    text('DIMENSIONS', m.at, m.text, 3.5);
  }
  for (const w of plan.walls) {
    const fp = fps.get(w.id);
    if (!fp || w.demolish) continue;
    const mid = add(scale(add(fp.a, fp.b), 0.5), scale(fp.normal, fp.half + 6));
    text('DIMENSIONS', mid, formatLength(fp.length), 3.5);
  }
  for (const s of plan.soffits) {
    poly('SOFFITS', s.poly);
    const c = s.poly.reduce((q, p) => ({ x: q.x + p.x / s.poly.length, y: q.y + p.y / s.poly.length }), { x: 0, y: 0 });
    text('SOFFITS', c, `Soffit at ${formatLength(s.bottom)}`, 3);
  }
  for (const ob of plan.obstacles) {
    poly('OBJECTS', ob.poly);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return o.join('\r\n') + '\r\n';
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return (+n.toFixed(6)).toString();
}

function inPoly(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
