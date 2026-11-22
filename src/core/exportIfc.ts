import type { Vec2 } from './geom2d.js';
import { computeFootprints } from './wallGeometry.js';
import { findRoomFaces } from './rooms.js';
import type { Plan, Wall } from './plan.js';

/**
 * The building model as an IFC4 file (STEP text), the open BIM format Revit,
 * ArchiCAD, BlenderBIM and free viewers read. Walls carry their real corner
 * shapes and true openings; doors and windows fill them; rooms are spaces;
 * phase and scan evidence ride along as properties.
 *
 * IFC coordinates: meters, z up, x = plan x, y = -plan y (so the plan reads
 * the same way up as the printed one).
 */

const M = 0.0254;
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** A stable 22-character IFC GlobalId from any string (FNV-based, 128 bits). */
export function ifcGuid(seed: string): string {
  const words: number[] = [];
  let h = 0x811c9dc5;
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + k * 31;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    words.push(h >>> 0);
  }
  // 128 bits -> 22 base-64 digits (first digit carries 2 bits).
  let bits = '';
  for (const w of words) bits += w.toString(2).padStart(32, '0');
  bits = '0000' + bits; // 132 bits = 22 x 6
  let out = '';
  for (let i = 0; i < 132; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}

const num = (n: number) => {
  if (!Number.isFinite(n)) return '0.';
  const s = n.toFixed(6).replace(/0+$/, '');
  return s.endsWith('.') ? s : s.includes('.') ? s : s + '.';
};
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '')}'`;

export function exportIfc(plan: Plan, opts: { now?: Date } = {}): string {
  const lines: string[] = [];
  let n = 0;
  const e = (body: string) => {
    lines.push(`#${++n}=${body};`);
    return `#${n}`;
  };
  const now = opts.now ?? new Date(plan.updatedAt);
  const P2 = (x: number, y: number) => e(`IFCCARTESIANPOINT((${num(x)},${num(y)}))`);
  const P3 = (x: number, y: number, z: number) => e(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const D3 = (x: number, y: number, z: number) => e(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`);
  const toIfc = (p: Vec2) => ({ x: p.x * M, y: -p.y * M });

  // Context ------------------------------------------------------------------
  const person = e(`IFCPERSON($,$,'',$,$,$,$,$)`);
  const org = e(`IFCORGANIZATION($,'Basement Planner',$,$,$)`);
  const po = e(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
  const app = e(`IFCAPPLICATION(${org},'1','Basement Planner','basement-planner')`);
  const oh = e(`IFCOWNERHISTORY(${po},${app},$,.ADDED.,$,$,$,${Math.floor(now.getTime() / 1000)})`);
  const units = e(
    `IFCUNITASSIGNMENT((${e(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`)},${e(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`)},${e(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`)},${e(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`)}))`,
  );
  const origin = P3(0, 0, 0);
  const Z = D3(0, 0, 1);
  const X = D3(1, 0, 0);
  const world = e(`IFCAXIS2PLACEMENT3D(${origin},${Z},${X})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const project = e(`IFCPROJECT('${ifcGuid('project')}',${oh},${str(plan.name)},$,$,$,$,(${ctx}),${units})`);
  const sitePl = e(`IFCLOCALPLACEMENT($,${world})`);
  const site = e(`IFCSITE('${ifcGuid('site')}',${oh},'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = e(`IFCLOCALPLACEMENT(${sitePl},${world})`);
  const building = e(`IFCBUILDING('${ifcGuid('building')}',${oh},'Building',$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const level = plan.levels[0] ?? { id: 'L1', name: 'Basement', elevation: 0 };
  const stPl = e(`IFCLOCALPLACEMENT(${bldPl},${world})`);
  const storey = e(`IFCBUILDINGSTOREY('${ifcGuid('storey:' + level.id)}',${oh},${str(level.name)},$,$,${stPl},$,$,.ELEMENT.,${num(level.elevation * M)})`);
  e(`IFCRELAGGREGATES('${ifcGuid('agg:project')}',${oh},$,$,${project},(${site}))`);
  e(`IFCRELAGGREGATES('${ifcGuid('agg:site')}',${oh},$,$,${site},(${building}))`);
  e(`IFCRELAGGREGATES('${ifcGuid('agg:building')}',${oh},$,$,${building},(${storey}))`);

  /** A placement at plan point p, x axis along plan direction d, z up. */
  const placeAt = (rel: string, p: Vec2, z: number, d: Vec2 = { x: 1, y: 0 }) => {
    const q = toIfc(p);
    return e(`IFCLOCALPLACEMENT(${rel},${e(`IFCAXIS2PLACEMENT3D(${P3(q.x, q.y, z * M)},${Z},${D3(d.x, -d.y, 0)})`)})`);
  };
  /** Plan polygon -> profile in a local frame at `at` with x along `d` (plan). */
  const profile = (poly: Vec2[], at: Vec2, d: Vec2) => {
    const o = toIfc(at);
    const dx = { x: d.x, y: -d.y };
    const dy = { x: -dx.y, y: dx.x }; // Z x X
    const pts = poly.map((p) => {
      const q = toIfc(p);
      const v = { x: q.x - o.x, y: q.y - o.y };
      return P2(v.x * dx.x + v.y * dx.y, v.x * dy.x + v.y * dy.y);
    });
    return e(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${e(`IFCPOLYLINE((${[...pts, pts[0]].join(',')}))`)})`);
  };
  const extrude = (prof: string, z0: number, h: number) =>
    e(`IFCEXTRUDEDAREASOLID(${prof},${e(`IFCAXIS2PLACEMENT3D(${P3(0, 0, z0 * M)},$,$)`)},${Z},${num(h * M)})`);
  const shape = (solids: string[]) => e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${e(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solids.join(',')}))`)}))`);
  const rect = (w: number, d: number, cx: number, cy: number) =>
    e(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${e(`IFCAXIS2PLACEMENT2D(${P2(cx * M, cy * M)},$)`)},${num(w * M)},${num(d * M)})`);

  const contained: string[] = [];
  const props: Array<{ obj: string; set: string; values: Record<string, string | boolean | number> }> = [];
  const fps = computeFootprints(plan);
  const node = new Map(plan.nodes.map((x) => [x.id, x]));
  const phase = (w: Wall) => (w.kind === 'new' ? 'new' : w.demolish ? 'demolish' : 'existing');

  // Walls, their openings, doors and windows ------------------------------------
  for (const w of plan.walls) {
    const fp = fps.get(w.id);
    const a = node.get(w.a);
    if (!fp || !a) continue;
    const pl = placeAt(stPl, a, 0, fp.dir);
    const foot = [fp.leftA, fp.leftB, fp.rightB, fp.rightA];
    const solid = extrude(profile(foot, a, fp.dir), 0, w.height);
    const concrete = w.kind === 'existing' && w.thickness >= 7;
    const label = w.kind === 'new' ? 'Planned wall' : concrete ? 'Foundation wall' : 'Existing wall';
    const wall = e(`IFCWALL('${ifcGuid('wall:' + w.id)}',${oh},${str(label)},$,${str(concrete ? 'Concrete' : `2x${w.thickness >= 6 ? 6 : 4} stud`)},${pl},${shape([solid])},${str(w.id)},.STANDARD.)`);
    contained.push(wall);
    props.push({ obj: wall, set: 'Pset_WallCommon', values: { IsExternal: concrete, LoadBearing: concrete } });
    props.push({ obj: wall, set: 'BasementPlanner', values: { Phase: phase(w), Evidence: w.evidence, Thickness_in: w.thickness, Length_in: Math.round(fp.length * 100) / 100 } });
    for (const o of plan.openings.filter((x) => x.wallId === w.id)) {
      const s0 = o.offset - o.width / 2;
      const opPl = e(`IFCLOCALPLACEMENT(${pl},${e(`IFCAXIS2PLACEMENT3D(${P3(s0 * M, 0, o.sill * M)},$,$)`)})`);
      const cut = extrude(rect(o.width, w.thickness * 3, o.width / 2, 0), 0, o.height);
      const opening = e(`IFCOPENINGELEMENT('${ifcGuid('open:' + o.id)}',${oh},'Opening',$,$,${opPl},${shape([cut])},$,.OPENING.)`);
      e(`IFCRELVOIDSELEMENT('${ifcGuid('void:' + o.id)}',${oh},$,$,${wall},${opening})`);
      if (o.type === 'opening') continue;
      const leaf = o.type === 'door' ? 1.75 : 0.75;
      const fill = extrude(rect(o.width, leaf, o.width / 2, 0), 0, o.height);
      const elPl = e(`IFCLOCALPLACEMENT(${opPl},${e(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)})`);
      const el =
        o.type === 'door'
          ? e(`IFCDOOR('${ifcGuid('door:' + o.id)}',${oh},'Door',$,$,${elPl},${shape([fill])},${str(o.id)},${num(o.height * M)},${num(o.width * M)},.DOOR.,${o.swing === 'left' ? '.SINGLE_SWING_LEFT.' : '.SINGLE_SWING_RIGHT.'},$)`)
          : e(`IFCWINDOW('${ifcGuid('win:' + o.id)}',${oh},'Window',$,$,${elPl},${shape([fill])},${str(o.id)},${num(o.height * M)},${num(o.width * M)},.WINDOW.,.SINGLE_PANEL.,$)`);
      e(`IFCRELFILLSELEMENT('${ifcGuid('fill:' + o.id)}',${oh},$,$,${opening},${el})`);
      contained.push(el);
      props.push({ obj: el, set: 'BasementPlanner', values: { Phase: o.kind, Evidence: o.evidence } });
    }
  }

  // Soffits, posts and scanned objects ------------------------------------------
  const H = plan.settings.wallHeight;
  for (const s of plan.soffits) {
    if (s.poly.length < 3 || s.bottom >= H) continue;
    const pl = placeAt(stPl, s.poly[0], 0);
    const el = e(`IFCBUILDINGELEMENTPROXY('${ifcGuid('soffit:' + s.id)}',${oh},'Soffit',$,'Soffit',${pl},${shape([extrude(profile(s.poly, s.poly[0], { x: 1, y: 0 }), s.bottom, H - s.bottom)])},${str(s.id)},.NOTDEFINED.)`);
    contained.push(el);
  }
  for (const o of plan.obstacles) {
    if (o.poly.length < 3) continue;
    const pl = placeAt(stPl, o.poly[0], 0);
    const solid = extrude(profile(o.poly, o.poly[0], { x: 1, y: 0 }), 0, o.height);
    const post = /post|column/i.test(o.label);
    const el = post
      ? e(`IFCCOLUMN('${ifcGuid('ob:' + o.id)}',${oh},${str(o.label)},$,$,${pl},${shape([solid])},${str(o.id)},.COLUMN.)`)
      : e(`IFCBUILDINGELEMENTPROXY('${ifcGuid('ob:' + o.id)}',${oh},${str(o.label || 'Object')},$,$,${pl},${shape([solid])},${str(o.id)},.NOTDEFINED.)`);
    contained.push(el);
  }

  // Rooms as spaces ---------------------------------------------------------------
  const spaces: string[] = [];
  const faces = findRoomFaces(plan);
  for (const r of plan.rooms) {
    const f = faces.find((x) => pointIn(r.seed, x.outline));
    if (!f || f.inner.length < 3) continue;
    const h = r.ceilingHeight ?? H;
    const pl = placeAt(stPl, f.inner[0], 0);
    const sp = e(`IFCSPACE('${ifcGuid('space:' + r.id)}',${oh},${str(r.name)},$,$,${pl},${shape([extrude(profile(f.inner, f.inner[0], { x: 1, y: 0 }), 0, h)])},${str(r.name)},.ELEMENT.,.INTERNAL.,$)`);
    spaces.push(sp);
    props.push({ obj: sp, set: 'BasementPlanner', values: { FloorFinish: r.finish, Area_sqft: Math.round(f.areaSqFt * 10) / 10 } });
  }
  if (spaces.length) e(`IFCRELAGGREGATES('${ifcGuid('agg:spaces')}',${oh},$,$,${storey},(${spaces.join(',')}))`);
  if (contained.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid('contain')}',${oh},$,$,(${contained.join(',')}),${storey})`);

  // Properties --------------------------------------------------------------------
  props.forEach((p, i) => {
    const vals = Object.entries(p.values).map(([k, v]) =>
      e(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${typeof v === 'boolean' ? `IFCBOOLEAN(.${v ? 'T' : 'F'}.)` : typeof v === 'number' ? `IFCREAL(${num(v)})` : `IFCLABEL(${str(String(v))})`},$)`),
    );
    const set = e(`IFCPROPERTYSET('${ifcGuid(`pset:${i}:${p.obj}`)}',${oh},${str(p.set)},$,(${vals.join(',')}))`);
    e(`IFCRELDEFINESBYPROPERTIES('${ifcGuid(`defs:${i}:${p.obj}`)}',${oh},$,$,(${p.obj}),${set})`);
  });

  const stamp = now.toISOString().slice(0, 19);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${str(plan.name + '.ifc')},'${stamp}',(''),('Basement Planner'),'basement-planner','basement-planner','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

function pointIn(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
