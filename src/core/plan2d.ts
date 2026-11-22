import { lockMarks } from './lockGeom.js';
import { add, norm, perp, scale, sub, type Vec2 } from './geom2d.js';
import { roomCeiling, wallEnds } from './ops.js';
import type { CeilingType, Finish, MarkerType, Plan, Room } from './plan.js';
import { centroid } from './poly.js';
import { findRoomFaces, resolveRooms } from './rooms.js';
import { formatLength } from './units.js';
import { computeFootprints, footprintPoly, wallPrisms } from './wallGeometry.js';

/**
 * Top-down plan drawing as an SVG string (no DOM needed): walls with door gaps and
 * swings, wall dimensions, rooms with area and finish, scanned objects, utility
 * pins and saved measurements. Plan y runs down the page.
 */

export const FINISH_COLORS: Record<Finish, string> = {
  none: '#eef2f7',
  carpet: '#e9dcc7',
  lvp: '#d9b98f',
  tile: '#dfe6ea',
  concrete: '#cfd2d6',
  epoxy: '#c8d8e8',
};

export const FINISH_NAMES: Record<Finish, string> = {
  none: 'No finish',
  carpet: 'Carpet',
  lvp: 'LVP',
  tile: 'Tile',
  concrete: 'Sealed concrete',
  epoxy: 'Epoxy',
};

export const MARKER_INFO: Record<MarkerType, { name: string; short: string; color: string }> = {
  outlet: { name: 'Outlet', short: 'O', color: '#e8a400' },
  switch: { name: 'Switch', short: 'S', color: '#e8a400' },
  light: { name: 'Light', short: 'L', color: '#f2c94c' },
  panel: { name: 'Electrical panel', short: 'P', color: '#d9534f' },
  'water-heater': { name: 'Water heater', short: 'WH', color: '#3d8bff' },
  furnace: { name: 'Furnace', short: 'F', color: '#e07b39' },
  drain: { name: 'Floor drain', short: 'D', color: '#2bb3a3' },
  pipe: { name: 'Pipe', short: 'Pi', color: '#2f86e6' },
  post: { name: 'Post', short: 'Po', color: '#7a7f87' },
};

export interface PlanSvgOptions {
  /** Pixels per inch for the output size (layout only; SVG scales freely). */
  pxPerInch?: number;
  showDimensions?: boolean;
  showFinishes?: boolean;
  title?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n: number) => +n.toFixed(2);
const pts = (poly: Vec2[]) => poly.map((p) => `${f(p.x)},${f(p.y)}`).join(' ');

export interface RoomSummary {
  name: string;
  areaSqFt: number;
  finish: Finish;
}

/** Named rooms with their current area (rooms whose walls no longer close are skipped). */
export function roomSummaries(plan: Plan): RoomSummary[] {
  return resolveRooms(plan)
    .filter((r) => r.face)
    .map((r) => ({ name: r.room.name, areaSqFt: r.face!.areaSqFt, finish: r.room.finish }));
}

export function renderPlanSvg(plan: Plan, opts: PlanSvgOptions = {}): string {
  const showDims = opts.showDimensions ?? true;
  const showFinish = opts.showFinishes ?? true;
  const fps = computeFootprints(plan);
  const faces = findRoomFaces(plan);
  const rooms = resolveRooms(plan, faces);

  // Bounds of everything drawn.
  const all: Vec2[] = [];
  for (const fp of fps.values()) all.push(fp.leftA, fp.leftB, fp.rightA, fp.rightB);
  for (const o of plan.obstacles) all.push(...o.poly);
  for (const m of plan.markers) all.push(m);
  for (const m of plan.measures) all.push(m.a, m.b);
  if (!all.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" class="plan-svg"><text x="200" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" fill="#8a96a3">Nothing drawn yet</text></svg>`;
  }
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxX = Math.max(...all.map((p) => p.x));
  const maxY = Math.max(...all.map((p) => p.y));
  const margin = 30;
  const vx = minX - margin;
  const vy = minY - margin - (opts.title ? 16 : 0);
  const vw = maxX - minX + margin * 2;
  const vh = maxY - minY + margin * 2 + (opts.title ? 16 : 0) + 18;
  const ppi = opts.pxPerInch ?? 3;
  const text = Math.max(6, Math.min(vw, vh) / 55); // font size in inches

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="plan-svg" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}" width="${f(vw * ppi)}" height="${f(vh * ppi)}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">`,
  );
  out.push(`<rect x="${f(vx)}" y="${f(vy)}" width="${f(vw)}" height="${f(vh)}" fill="#ffffff"/>`);
  if (opts.title) {
    out.push(`<text x="${f(vx + margin)}" y="${f(vy + 18)}" font-size="${f(text * 1.5)}" font-weight="700" fill="#1d2633">${esc(opts.title)}</text>`);
  }

  // Rooms (floor fill + label).
  const named = new Map<string, (typeof rooms)[number]>();
  for (const r of rooms) if (r.face) named.set(r.face.key, r);
  for (const face of faces) {
    const r = named.get(face.key);
    const fill = showFinish && r ? FINISH_COLORS[r.room.finish] : FINISH_COLORS.none;
    out.push(`<polygon points="${pts(face.inner)}" fill="${fill}" stroke="none"/>`);
  }
  // Built-ins: benches, counters, cabinets.
  for (const bx of plan.boxes) {
    out.push(`<polygon points="${pts(bx.poly)}" fill="#efe3cf" stroke="#8a6a3a" stroke-width="0.8"/>`);
    const c = centroid(bx.poly);
    out.push(`<text x="${f(c.x)}" y="${f(c.y)}" font-size="${f(text * 0.8)}" text-anchor="middle" dominant-baseline="middle" fill="#6b4f25">${esc(bx.label)}</text>`);
  }
  // Scanned objects.
  for (const o of plan.obstacles) {
    out.push(`<polygon points="${pts(o.poly)}" fill="#f3ece1" stroke="#a08a6a" stroke-width="0.8" stroke-dasharray="3 2"/>`);
    const c = centroid(o.poly);
    out.push(`<text x="${f(c.x)}" y="${f(c.y)}" font-size="${f(text * 0.8)}" text-anchor="middle" dominant-baseline="middle" fill="#7a6545">${esc(cap(o.label))}</text>`);
  }

  // Walls: base prisms only (z0 = 0) so door openings read as gaps; windows as thin lines.
  for (const w of plan.walls) {
    const fp = fps.get(w.id);
    if (!fp) continue;
    if (w.kind === 'existing') {
      // Standard demolition plan convention: dashed outline, no fill.
      for (const p of wallPrisms(fp, w, plan.openings)) {
        if (p.z0 > 0.01) continue;
        out.push(
          w.demolish
            ? `<polygon points="${pts(p.poly)}" fill="none" stroke="#c0392b" stroke-width="0.8" stroke-dasharray="4 3"/>`
            : `<polygon points="${pts(p.poly)}" fill="url(#hatch)" stroke="#6b7480" stroke-width="0.6"/>`,
        );
      }
      continue;
    }
    for (const p of wallPrisms(fp, w, plan.openings)) {
      if (p.z0 > 0.01) continue;
      out.push(`<polygon points="${pts(p.poly)}" fill="#2b3440" stroke="#2b3440" stroke-width="0.3"/>`);
    }
  }
  // Kept distances: a dimension line with ticks.
  for (const m of lockMarks(plan)) {
    if (!m.line) continue;
    const [p, q] = m.line;
    out.push(`<line x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}" stroke="#0e7490" stroke-width="0.8"/>`);
    out.push(`<text x="${f(m.at.x)}" y="${f(m.at.y)}" font-size="${f(text * 0.8)}" text-anchor="middle" dominant-baseline="middle" fill="#0e7490">${esc(m.text)}</text>`);
  }
  // Door swings and window marks.
  for (const o of plan.openings) {
    const w = plan.walls.find((x) => x.id === o.wallId);
    const fp = w && fps.get(w.id);
    if (!w || !fp) continue;
    const c = add(fp.a, scale(fp.dir, o.offset));
    const half = o.width / 2;
    const hingeSign = o.hinge === 'a' ? -1 : 1;
    const hinge = add(c, scale(fp.dir, hingeSign * half));
    const free = add(c, scale(fp.dir, -hingeSign * half));
    if (o.type === 'door') {
      const side = o.swing === 'left' ? 1 : -1;
      const n = scale(fp.normal, side);
      const open = add(hinge, scale(n, o.width));
      const sweep = (o.hinge === 'a') === (side === 1) ? 0 : 1;
      out.push(`<line x1="${f(hinge.x)}" y1="${f(hinge.y)}" x2="${f(open.x)}" y2="${f(open.y)}" stroke="#2b3440" stroke-width="0.8"/>`);
      out.push(
        `<path d="M ${f(open.x)} ${f(open.y)} A ${f(o.width)} ${f(o.width)} 0 0 ${sweep} ${f(free.x)} ${f(free.y)}" fill="none" stroke="#2b3440" stroke-width="0.5" stroke-dasharray="2 1.5"/>`,
      );
    } else if (o.sill > 0.01) {
      const a1 = add(hinge, scale(fp.normal, fp.half));
      const b1 = add(free, scale(fp.normal, fp.half));
      out.push(`<line x1="${f(a1.x)}" y1="${f(a1.y)}" x2="${f(b1.x)}" y2="${f(b1.y)}" stroke="#3d8bff" stroke-width="1"/>`);
    }
  }

  // Dimensions on new walls, outside the nearest room.
  if (showDims) {
    for (const w of plan.walls) {
      if (w.kind !== 'new') continue;
      const fp = fps.get(w.id);
      if (!fp) continue;
      const { a, b } = wallEnds(plan, w);
      const mid = scale(add(a, b), 0.5);
      // Put the label on the side away from the plan's center of mass.
      const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const side = (mid.x - center.x) * fp.normal.x + (mid.y - center.y) * fp.normal.y >= 0 ? 1 : -1;
      const off = fp.half + text * 1.4;
      const pa = add(a, scale(fp.normal, side * off));
      const pb = add(b, scale(fp.normal, side * off));
      const tick = scale(perp(norm(sub(b, a))), text * 0.35);
      out.push(`<line x1="${f(pa.x)}" y1="${f(pa.y)}" x2="${f(pb.x)}" y2="${f(pb.y)}" stroke="#8a96a3" stroke-width="0.4"/>`);
      for (const p of [pa, pb]) {
        out.push(`<line x1="${f(p.x - tick.x)}" y1="${f(p.y - tick.y)}" x2="${f(p.x + tick.x)}" y2="${f(p.y + tick.y)}" stroke="#8a96a3" stroke-width="0.4"/>`);
      }
      let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const tp = add(scale(add(pa, pb), 0.5), scale(fp.normal, side * text * 0.7));
      out.push(
        `<text x="${f(tp.x)}" y="${f(tp.y)}" font-size="${f(text)}" text-anchor="middle" dominant-baseline="middle" fill="#3b4656" transform="rotate(${f(ang)} ${f(tp.x)} ${f(tp.y)})">${esc(formatLength(fp.length, 8))}</text>`,
      );
    }
  }

  // Room labels.
  for (const face of faces) {
    const r = named.get(face.key);
    const lines = r
      ? [
          r.room.name,
          `${face.areaSqFt.toFixed(0)} sq ft`,
          ...(r.room.finish !== 'none' ? [FINISH_NAMES[r.room.finish]] : []),
          ...ceilingLine(plan, r.room),
        ]
      : [`${face.areaSqFt.toFixed(0)} sq ft`];
    lines.forEach((l, i) => {
      const y = face.center.y + (i - (lines.length - 1) / 2) * text * 1.25;
      out.push(
        `<text x="${f(face.center.x)}" y="${f(y)}" font-size="${f(i === 0 && r ? text * 1.15 : text * 0.9)}" font-weight="${i === 0 && r ? 700 : 500}" text-anchor="middle" dominant-baseline="middle" fill="${i === 0 && r ? '#1d2633' : '#55627a'}">${esc(l)}</text>`,
      );
    });
  }

  // Soffits (dashed: they are overhead).
  for (const sf of plan.soffits) {
    out.push(`<polygon points="${pts(sf.poly)}" fill="none" stroke="#6b5fd0" stroke-width="0.8" stroke-dasharray="5 3"/>`);
    const c = centroid(sf.poly);
    out.push(
      `<text x="${f(c.x)}" y="${f(c.y)}" font-size="${f(text * 0.8)}" text-anchor="middle" dominant-baseline="middle" fill="#5a4fc0">Soffit ${esc(formatLength(sf.bottom))}</text>`,
    );
  }

  // Measurements.
  for (const m of plan.measures) {
    const d = Math.hypot(m.a.x - m.b.x, m.a.y - m.b.y, m.a.z - m.b.z);
    out.push(`<line x1="${f(m.a.x)}" y1="${f(m.a.y)}" x2="${f(m.b.x)}" y2="${f(m.b.y)}" stroke="#c99a00" stroke-width="0.7" stroke-dasharray="4 2"/>`);
    out.push(
      `<text x="${f((m.a.x + m.b.x) / 2)}" y="${f((m.a.y + m.b.y) / 2 - text * 0.6)}" font-size="${f(text * 0.85)}" text-anchor="middle" fill="#8a6a00">${esc(formatLength(d, 8))}</text>`,
    );
  }

  // Utility pins.
  for (const m of plan.markers) {
    const info = MARKER_INFO[m.type];
    const r = text * 0.75;
    out.push(`<circle cx="${f(m.x)}" cy="${f(m.y)}" r="${f(r)}" fill="${info.color}" stroke="#ffffff" stroke-width="0.6"/>`);
    out.push(
      `<text x="${f(m.x)}" y="${f(m.y)}" font-size="${f(r * 0.95)}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="#ffffff">${info.short}</text>`,
    );
  }

  // Scale bar: 4 ft.
  const sbx = vx + margin;
  const sby = vy + vh - 10;
  out.push(`<rect x="${f(sbx)}" y="${f(sby - 2)}" width="24" height="3" fill="#2b3440"/><rect x="${f(sbx + 24)}" y="${f(sby - 2)}" width="24" height="3" fill="#ffffff" stroke="#2b3440" stroke-width="0.5"/>`);
  out.push(`<text x="${f(sbx + 52)}" y="${f(sby + 1)}" font-size="${f(text * 0.8)}" fill="#55627a">4 ft</text>`);

  out.push(
    `<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#d7dbe0"/><line x1="0" y1="0" x2="0" y2="4" stroke="#9aa3ae" stroke-width="1"/></pattern></defs>`,
  );
  out.push('</svg>');
  return out.join('');
}

function cap(s: string): string {
  const t = s.trim() || 'object';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const CEILING_NAMES: Record<CeilingType, string> = { drywall: 'Drywall ceiling', drop: 'Drop ceiling', open: 'Open joists' };

function ceilingLine(plan: Plan, room: Room): string[] {
  const c = roomCeiling(plan, room);
  const custom = room.ceilingHeight !== null || room.ceilingType !== null;
  return custom ? [`${CEILING_NAMES[c.type]} ${formatLength(c.height)}`] : [];
}
