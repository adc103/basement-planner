import { produce, type Draft } from 'immer';
import { z } from 'zod';
import { dist } from './geom2d.js';
import {
  addMarker,
  addMeasure,
  addOpening,
  addSoffit,
  addWallBetween,
  deleteMarker,
  deleteMeasure,
  deleteOpening,
  deleteRoom,
  deleteSoffit,
  deleteWall,
  moveMarker,
  moveNode,
  moveOpening,
  moveWall,
  setSoffitBottom,
  setWallHeight,
  setWallKind,
  setWallLength,
  setWallThickness,
  splitWall,
  upsertRoom,
  wallLength,
  wallsAtNode,
} from './ops.js';
import { CEILING_TYPES, CONSTRAINT_TYPES, FINISHES, MARKER_TYPES, newId, SettingsSchema, type Constraint, type Plan, type Wall } from './plan.js';
import { solveConstraints, wallGap } from './solver.js';
import { formatLength } from './units.js';
import { applyRoomScan, applyScan, type RoomScanImport } from './scanApply.js';
import type { StructureResult } from './structure.js';
import type { PlanStore } from './store.js';

/**
 * The command layer. Every change to the plan, whether it comes from your
 * hands, the scanner or an assistant, is one of these named, typed commands.
 * Commands check their inputs and locks, run inside one undo step, and are
 * written to a journal. Their schemas double as tool definitions for an AI.
 */

export type Source = 'user' | 'scan' | 'assistant' | 'replay';

/** A command refused its input. Nothing was changed. */
export class CommandError extends Error {}

interface Ctx {
  source: Source;
}

interface Def<S extends z.ZodType, R> {
  title: string;
  description: string;
  params: S;
  /** Undo label; defaults to the title. */
  label?: (p: z.infer<S>) => string;
  run: (d: Draft<Plan>, p: z.infer<S>, ctx: Ctx) => R;
  /** Internal commands carry large machine payloads and aren't offered as AI tools. */
  internal?: boolean;
}

const def = <S extends z.ZodType, R>(d: Def<S, R>): Def<S, R> => d;

const Vec = z.object({ x: z.number(), y: z.number() });
const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
const Id = z.string().min(1).describe('Element id');
const Inches = (what: string) => z.number().positive().describe(`${what}, inches`);

// --- Lookups that refuse missing or locked elements ------------------------------

type Coll = 'walls' | 'openings' | 'markers' | 'soffits' | 'rooms' | 'obstacles' | 'measures';
const COLLS: Coll[] = ['walls', 'openings', 'markers', 'soffits', 'rooms', 'obstacles', 'measures'];
const NOUN: Record<Coll, string> = {
  walls: 'wall',
  openings: 'opening',
  markers: 'pin',
  soffits: 'soffit',
  rooms: 'room',
  obstacles: 'object',
  measures: 'measurement',
};

function find(d: Draft<Plan>, id: string): { coll: Coll; el: { id: string; locked?: boolean } } | null {
  for (const coll of COLLS) {
    const el = (d[coll] as Array<{ id: string; locked?: boolean }>).find((x) => x.id === id);
    if (el) return { coll, el };
  }
  return null;
}

function editable<C extends Coll>(d: Draft<Plan>, coll: C, id: string): Draft<Plan>[C][number] {
  const el = (d[coll] as Array<{ id: string; locked?: boolean }>).find((x) => x.id === id);
  if (!el) throw new CommandError(`No ${NOUN[coll]} ${id}`);
  if (el.locked) throw new CommandError(`That ${NOUN[coll]} is locked`);
  return el as Draft<Plan>[C][number];
}

function editableNode(d: Draft<Plan>, id: string): void {
  if (!d.nodes.some((n) => n.id === id)) throw new CommandError(`No corner ${id}`);
  if (wallsAtNode(d, id).some((w) => w.locked)) throw new CommandError('A wall at that corner is locked');
}

// --- The commands ------------------------------------------------------------------

export const COMMANDS = {
  'settings.set': def({
    title: 'Change settings',
    description: `Change plan-wide settings and defaults. Keys: ${Object.keys(SettingsSchema.shape).join(', ')}.`,
    params: z.object({ values: z.record(z.string(), z.unknown()) }),
    run(d, p) {
      const shape = SettingsSchema.shape as Record<string, z.ZodType>;
      for (const [k, v] of Object.entries(p.values)) {
        const field = shape[k];
        if (!field) throw new CommandError(`Unknown setting ${k}`);
        const r = field.safeParse(v);
        if (!r.success) throw new CommandError(`Bad value for ${k}`);
        (d.settings as Record<string, unknown>)[k] = r.data;
      }
    },
  }),
  'plan.rename': def({
    title: 'Rename plan',
    description: 'Rename the plan.',
    params: z.object({ name: z.string().min(1).max(80) }),
    run(d, p) {
      d.name = p.name;
    },
  }),

  // Walls ------------------------------------------------------------------------
  'wall.add': def({
    title: 'Add wall',
    description: 'Add a straight wall between two floor points (plan inches). Ends join existing corners and walls they touch. Returns the new wall id.',
    params: z.object({
      a: Vec,
      b: Vec,
      height: Inches('Height').optional(),
      thickness: Inches('Finished thickness').optional(),
      kind: z.enum(['new', 'existing']).default('new').describe("'existing' = a real wall already there"),
      againstFoundation: z.boolean().default(false),
      source: z.enum(['draw', 'scan', 'capture']).optional(),
    }),
    run(d, p) {
      const id = addWallBetween(d, p.a, p.b, {
        height: p.height ?? d.settings.wallHeight,
        thickness: p.thickness ?? (p.source === 'capture' ? d.settings.captureThickness : d.settings.wallThickness),
        kind: p.kind,
        againstFoundation: p.againstFoundation,
        source: p.source,
      });
      if (!id) throw new CommandError(dist(p.a, p.b) < 0.5 ? 'Wall too short' : 'That wall is already there');
      return id;
    },
  }),
  'wall.setLength': def({
    title: 'Set length',
    description: 'Set a wall length by moving one end along the wall.',
    params: z.object({ id: Id, length: Inches('Length'), keep: z.enum(['a', 'b']).default('a').describe('End that stays put') }),
    run(d, p) {
      const w = editable(d, 'walls', p.id);
      editableNode(d, p.keep === 'a' ? w.b : w.a);
      // Typing a length on a kept wall changes what it keeps.
      for (const c of d.constraints) if (c.type === 'length' && c.a === p.id) c.value = p.length;
      if (!setWallLength(d, p.id, p.length, p.keep)) throw new CommandError("Can't set that length");
    },
  }),
  'wall.setHeight': def({
    title: 'Set height',
    description: 'Set a wall height.',
    params: z.object({ id: Id, height: Inches('Height') }),
    run(d, p) {
      editable(d, 'walls', p.id);
      setWallHeight(d, p.id, p.height);
    },
  }),
  'wall.setThickness': def({
    title: 'Set thickness',
    description: 'Set a wall finished thickness (4.5 = 2x4 with drywall, 6.5 = 2x6).',
    params: z.object({ id: Id, thickness: Inches('Thickness') }),
    run(d, p) {
      editable(d, 'walls', p.id);
      setWallThickness(d, p.id, p.thickness);
    },
  }),
  'wall.split': def({
    title: 'Split wall',
    description: 'Split a wall into two at a fraction of its length. Returns the new corner id.',
    params: z.object({ id: Id, t: z.number().gt(0).lt(1).default(0.5) }),
    run(d, p) {
      editable(d, 'walls', p.id);
      return splitWall(d, p.id, p.t);
    },
  }),
  'wall.setKind': def({
    title: 'Wall kind',
    label: (p) => (p.kind === 'new' ? 'Make planned wall' : 'Make real wall'),
    description: "Mark a wall as planned ('new') or real ('existing').",
    params: z.object({ id: Id, kind: z.enum(['new', 'existing']) }),
    run(d, p) {
      const w = editable(d, 'walls', p.id);
      setWallKind(d, p.id, p.kind);
      if (p.kind === 'new') w.demolish = false;
    },
  }),
  'wall.setDemolish': def({
    title: 'Demolish',
    label: (p) => (p.demolish ? 'Mark for demolition' : 'Keep wall'),
    description: 'Mark a real (existing) wall to be torn out, or keep it.',
    params: z.object({ id: Id, demolish: z.boolean() }),
    run(d, p) {
      const w = editable(d, 'walls', p.id);
      if (w.kind !== 'existing') throw new CommandError('Only real walls can be demolished; delete planned walls instead');
      w.demolish = p.demolish;
    },
  }),
  'wall.place': def({
    title: 'Move wall',
    description: 'Put a wall’s two ends at new floor points. Walls sharing those corners follow.',
    params: z.object({ id: Id, a: Vec, b: Vec }),
    run(d, p) {
      const w = editable(d, 'walls', p.id);
      editableNode(d, w.a);
      editableNode(d, w.b);
      if (dist(p.a, p.b) < 0.5) throw new CommandError('Wall too short');
      moveNode(d, w.a, p.a);
      moveNode(d, w.b, p.b);
    },
  }),
  'wall.move': def({
    title: 'Move wall',
    description: 'Shift a wall by an offset (inches). Walls sharing its corners follow.',
    params: z.object({ id: Id, dx: z.number(), dy: z.number() }),
    run(d, p) {
      const w = editable(d, 'walls', p.id);
      editableNode(d, w.a);
      editableNode(d, w.b);
      moveWall(d, p.id, { x: p.dx, y: p.dy });
    },
  }),
  'node.move': def({
    title: 'Move corner',
    description: 'Move a corner where walls meet.',
    params: z.object({ id: Id, x: z.number(), y: z.number() }),
    run(d, p) {
      editableNode(d, p.id);
      moveNode(d, p.id, p);
    },
  }),

  // Openings ---------------------------------------------------------------------
  'opening.add': def({
    title: 'Add opening',
    label: (p) => (p.type === 'door' ? 'Add door' : p.type === 'window' ? 'Add window' : 'Add opening'),
    description: 'Add a door, cased opening or window to a wall. offset = distance from the wall’s a end to the opening center. Returns the id.',
    params: z.object({
      wallId: Id,
      type: z.enum(['door', 'opening', 'window']),
      offset: z.number(),
      width: Inches('Width'),
      height: Inches('Height'),
      sill: z.number().min(0).default(0).describe('Bottom above the floor, inches (windows)'),
      hinge: z.enum(['a', 'b']).default('a'),
      swing: z.enum(['left', 'right']).default('left'),
      kind: z.enum(['new', 'existing']).optional().describe('Defaults to the wall’s kind'),
    }),
    run(d, p) {
      const w = editable(d, 'walls', p.wallId);
      const id = addOpening(d, { ...p, kind: p.kind ?? w.kind });
      if (!id) throw new CommandError("That opening doesn't fit there");
      return id;
    },
  }),
  'opening.update': def({
    title: 'Change opening',
    description: 'Change an opening’s type, size, position or swing. Refused if it would not fit.',
    params: z.object({
      id: Id,
      type: z.enum(['door', 'opening', 'window']).optional(),
      width: Inches('Width').optional(),
      height: Inches('Height').optional(),
      sill: z.number().min(0).optional(),
      offset: z.number().optional(),
      hinge: z.enum(['a', 'b']).optional(),
      swing: z.enum(['left', 'right']).optional(),
    }),
    run(d, p) {
      const o = editable(d, 'openings', p.id);
      const { id: _id, offset, ...rest } = p;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (o as Record<string, unknown>)[k] = v;
      const w = d.walls.find((x) => x.id === o.wallId);
      if (w && o.sill + o.height > w.height) throw new CommandError('Taller than the wall');
      if (!moveOpening(d, o.id, offset ?? o.offset)) throw new CommandError("That doesn't fit there");
    },
  }),

  // Pins, rooms, ceiling ---------------------------------------------------------
  'marker.add': def({
    title: 'Add pin',
    description: `Add a utility pin. Types: ${MARKER_TYPES.join(', ')}. z = height above the floor.`,
    params: z.object({ type: z.enum(MARKER_TYPES), x: z.number(), y: z.number(), z: z.number(), wallId: Id.nullable().default(null), note: z.string().default('') }),
    run(d, p) {
      return addMarker(d, p);
    },
  }),
  'marker.move': def({
    title: 'Move pin',
    description: 'Move a pin; wallId = the wall it sits on, or null on the floor.',
    params: z.object({ id: Id, x: z.number(), y: z.number(), z: z.number(), wallId: Id.nullable() }),
    run(d, p) {
      editable(d, 'markers', p.id);
      moveMarker(d, p.id, p, p.wallId);
    },
  }),
  'room.add': def({
    title: 'Add room',
    description: 'Name the walled area that contains a floor point. Returns the room id.',
    params: z.object({ seed: Vec, name: z.string().default('Room') }),
    run(d, p) {
      return upsertRoom(d, p.seed, { name: p.name });
    },
  }),
  'room.update': def({
    title: 'Change room',
    description: `Rename a room or set its floor finish (${FINISHES.join(', ')}) and ceiling overrides (null = plan default).`,
    params: z.object({
      id: Id,
      name: z.string().min(1).optional(),
      finish: z.enum(FINISHES).optional(),
      ceilingType: z.enum(CEILING_TYPES).nullable().optional(),
      ceilingHeight: Inches('Ceiling height').nullable().optional(),
    }),
    run(d, p) {
      const r = editable(d, 'rooms', p.id);
      const { id: _id, ...patch } = p;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as Record<string, unknown>)[k] = v;
    },
  }),
  'ceiling.set': def({
    title: 'Ceiling',
    description: 'Set the ceiling type and height for a room, or for the whole basement when roomId is null. Shows the ceiling.',
    params: z.object({ roomId: Id.nullable().default(null), type: z.enum(CEILING_TYPES).nullable().optional(), height: Inches('Height').nullable().optional() }),
    run(d, p) {
      d.settings.showCeiling = true;
      if (p.roomId) {
        const room = editable(d, 'rooms', p.roomId);
        if (p.type !== undefined) room.ceilingType = p.type;
        if (p.height !== undefined) room.ceilingHeight = p.height;
      } else {
        if (p.type) d.settings.ceilingType = p.type;
        if (p.height) d.settings.wallHeight = p.height;
      }
    },
  }),
  'soffit.add': def({
    title: 'Add soffit',
    description: 'Add a lowered ceiling box (around ducts or beams): floor polygon and underside height.',
    params: z.object({ poly: z.array(Vec).min(3), bottom: Inches('Underside height') }),
    run(d, p) {
      const id = addSoffit(d, p.poly, p.bottom);
      if (!id) throw new CommandError('Soffit needs three corners');
      return id;
    },
  }),
  'soffit.setBottom': def({
    title: 'Soffit height',
    description: 'Set a soffit’s underside height.',
    params: z.object({ id: Id, bottom: Inches('Underside height') }),
    run(d, p) {
      editable(d, 'soffits', p.id);
      setSoffitBottom(d, p.id, p.bottom);
    },
  }),
  'measure.add': def({
    title: 'Measure',
    description: 'Save a tape-measure line between two 3D points (plan inches, z up).',
    params: z.object({ a: Vec3, b: Vec3 }),
    run(d, p) {
      return addMeasure(d, p.a, p.b);
    },
  }),
  'measure.clear': def({
    title: 'Clear measurements',
    description: 'Remove every saved measurement.',
    params: z.object({}),
    run(d) {
      d.measures = [];
    },
  }),
  'reference.set': def({
    title: 'Set reference corners',
    description: 'Record (or clear, with null) the two real corners used to realign the plan.',
    params: z.object({ reference: z.object({ r1: Vec, r2: Vec }).nullable() }),
    label: (p) => (p.reference ? 'Set reference corners' : 'Reset reference corners'),
    run(d, p) {
      d.reference = p.reference;
    },
  }),

  // Locks between walls (CAD constraints) ------------------------------------------
  'constraint.add': def({
    title: 'Add lock',
    label: (p) => `Keep ${p.type === 'distance' ? 'distance' : p.type === 'length' ? 'length' : p.type === 'perpendicular' ? 'square' : p.type}`,
    description:
      "Keep a relationship true through every later edit. length: wall a stays `value` inches (default: its current length). distance: walls a and b stay parallel and `value` apart (mode 'clear' = face to face, 'center' = centerlines; default: the current gap). parallel, perpendicular (square), collinear (in line): between a and b. Returns the lock id.",
    params: z.object({ type: z.enum(CONSTRAINT_TYPES), a: Id, b: Id.nullable().default(null), value: z.number().nullable().default(null), mode: z.enum(['clear', 'center']).default('clear') }),
    run(d, p) {
      if (!d.walls.some((w) => w.id === p.a)) throw new CommandError(`No wall ${p.a}`);
      if (p.type !== 'length') {
        if (!p.b || !d.walls.some((w) => w.id === p.b)) throw new CommandError('Pick a second wall');
        if (p.b === p.a) throw new CommandError('Pick two different walls');
      }
      let value = p.value;
      if (p.type === 'length' && value === null) value = wallLength(d, d.walls.find((w) => w.id === p.a)! as Wall);
      if (p.type === 'distance') {
        const g = wallGap(d, p.a, p.b!)!;
        if (g.angle > 0.2) throw new CommandError('Those walls aren\u2019t parallel: a distance needs parallel walls');
        if (value === null) value = Math.round((p.mode === 'clear' ? g.clear : g.center) * 8) / 8;
        if (p.mode === 'clear' && value < 0) throw new CommandError('Walls would overlap');
      }
      if (p.type === 'length' && value !== null && value < 1) throw new CommandError('Too short');
      // One lock of a kind per wall pair: a new one replaces the old.
      const same = (c: Constraint) => c.type === p.type && ((c.a === p.a && c.b === p.b) || (c.a === p.b && c.b === p.a));
      d.constraints = d.constraints.filter((c) => !same(c));
      const id = newId('k');
      d.constraints.push({ id, type: p.type, a: p.a, b: p.type === 'length' ? null : p.b, value, mode: p.mode });
      return id;
    },
  }),
  'constraint.delete': def({
    title: 'Remove lock',
    description: 'Remove a lock between walls.',
    params: z.object({ id: Id }),
    run(d, p) {
      if (!d.constraints.some((c) => c.id === p.id)) throw new CommandError(`No lock ${p.id}`);
      d.constraints = d.constraints.filter((c) => c.id !== p.id);
    },
  }),
  'dimension.set': def({
    title: 'Set distance',
    description:
      "Move wall b (sideways, staying parallel) so it is `distance` inches from wall a: 'clear' = face to face (default), 'center' = centerlines. keep = also lock that distance. Walls joined to b follow.",
    params: z.object({ a: Id, b: Id, distance: z.number().min(0), mode: z.enum(['clear', 'center']).default('clear'), keep: z.boolean().default(false) }),
    run(d, p) {
      editable(d, 'walls', p.b);
      const g = wallGap(d, p.a, p.b);
      if (!g) throw new CommandError('Pick two walls');
      if (g.angle > 0.09) throw new CommandError('Those walls aren\u2019t parallel');
      const A = d.walls.find((w) => w.id === p.a)!;
      const B = d.walls.find((w) => w.id === p.b)!;
      editableNode(d, B.a);
      editableNode(d, B.b);
      const node = (id: string) => d.nodes.find((n) => n.id === id)!;
      const a0 = node(A.a);
      const a1 = node(A.b);
      const L = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
      const na = { x: -(a1.y - a0.y) / L, y: (a1.x - a0.x) / L };
      const b0 = node(B.a);
      const b1 = node(B.b);
      const s = ((b0.x + b1.x) / 2 - a0.x) * na.x + ((b0.y + b1.y) / 2 - a0.y) * na.y;
      const want = (s >= 0 ? 1 : -1) * (p.distance + (p.mode === 'clear' ? (A.thickness + B.thickness) / 2 : 0));
      if (p.mode === 'clear' && p.distance < 0.01) throw new CommandError('Walls would touch');
      moveWall(d, B.id, { x: na.x * (want - s), y: na.y * (want - s) });
      const existing = d.constraints.find((c) => c.type === 'distance' && ((c.a === p.a && c.b === p.b) || (c.a === p.b && c.b === p.a)));
      if (existing) {
        existing.value = p.distance;
        existing.mode = p.mode;
      } else if (p.keep) d.constraints.push({ id: newId('k'), type: 'distance', a: p.a, b: p.b, value: p.distance, mode: p.mode });
    },
  }),

  // Any element ------------------------------------------------------------------
  'element.delete': def({
    title: 'Delete',
    description: 'Delete a wall (with its openings), opening, pin, soffit, room, object or measurement.',
    params: z.object({ id: Id }),
    label: () => 'Delete',
    run(d, p) {
      const f = find(d, p.id);
      if (!f) throw new CommandError(`Nothing with id ${p.id}`);
      if (f.el.locked) throw new CommandError(`That ${NOUN[f.coll]} is locked`);
      if (f.coll === 'walls') {
        if (d.openings.some((o) => o.wallId === p.id && o.locked)) throw new CommandError('An opening in that wall is locked');
        deleteWall(d, p.id);
      } else if (f.coll === 'openings') deleteOpening(d, p.id);
      else if (f.coll === 'markers') deleteMarker(d, p.id);
      else if (f.coll === 'soffits') deleteSoffit(d, p.id);
      else if (f.coll === 'rooms') deleteRoom(d, p.id);
      else if (f.coll === 'measures') deleteMeasure(d, p.id);
      else d.obstacles = d.obstacles.filter((o) => o.id !== p.id);
      return f.coll;
    },
  }),
  'element.setLocked': def({
    title: 'Lock',
    label: (p) => (p.locked ? 'Lock' : 'Unlock'),
    description: 'Lock an element so nothing (you, the scanner or an assistant) can change it, or unlock it.',
    params: z.object({ id: Id, locked: z.boolean() }),
    run(d, p) {
      const f = find(d, p.id);
      if (!f) throw new CommandError(`Nothing with id ${p.id}`);
      f.el.locked = p.locked;
    },
  }),

  // Scanner ----------------------------------------------------------------------
  'scan.applyStructure': def({
    title: 'Add scanned structure',
    description: 'Add walls, openings, soffits, posts and floor area found by the depth scanner.',
    params: z.object({ result: z.custom<StructureResult>((v) => !!v && typeof v === 'object') }),
    internal: true,
    run(d, p) {
      applyScan(d, p.result);
    },
  }),
  'scan.setEvidence': def({
    title: 'Check against scan',
    description: 'Record how well walls and openings match the room mesh.',
    params: z.object({ items: z.array(z.object({ id: Id, evidence: z.enum(['measured', 'partial', 'inferred', 'manual']), confidence: z.number().min(0).max(1).nullable() })) }),
    internal: true,
    run(d, p) {
      for (const it of p.items) {
        const el = d.walls.find((w) => w.id === it.id) ?? d.openings.find((o) => o.id === it.id);
        if (!el || el.locked) continue;
        el.evidence = it.evidence;
        el.confidence = it.confidence;
      }
    },
  }),
  'scan.importRoom': def({
    title: 'Import room scan',
    description: 'Replace scanned real walls and objects with a fresh Quest Space Setup import.',
    params: z.object({ scan: z.custom<RoomScanImport>((v) => !!v && typeof v === 'object') }),
    internal: true,
    run(d, p) {
      applyRoomScan(d, p.scan);
    },
  }),
} as const;

export type Commands = typeof COMMANDS;
export type CommandName = keyof Commands;
export type ParamsOf<N extends CommandName> = z.input<Commands[N]['params']>;
export type ResultOf<N extends CommandName> = ReturnType<Commands[N]['run']>;
export type CommandResult<R> = { ok: true; value: R } | { ok: false; error: string };

export interface JournalEntry {
  at: string;
  name: CommandName;
  params: unknown;
  source: Source;
  ok: boolean;
  error?: string;
}

/** A tool definition an AI (or WebMCP) can call. */
export interface ToolSpec {
  name: CommandName;
  title: string;
  description: string;
  inputSchema: unknown;
}

/** In words, for "that would break ..." messages. */
export function describeConstraint(c: Constraint): string {
  if (c.type === 'length') return `the kept ${formatLength(c.value ?? 0)} wall length`;
  if (c.type === 'distance') return `the kept ${formatLength(c.value ?? 0)} ${c.mode === 'clear' ? 'clear ' : ''}distance`;
  if (c.type === 'perpendicular') return 'a square corner lock';
  if (c.type === 'parallel') return 'a parallel lock';
  return 'an in-line lock';
}

/**
 * After a command changes the plan, re-solve the locks. Corners the command
 * moved on purpose stay where it put them; everything else gives way. If the
 * locks can't all hold, the command is refused and nothing changes.
 */
function settle(d: Draft<Plan>, before: Map<string, number>): void {
  if (!d.constraints.length) return;
  const pinned = new Set<string>();
  for (const n of d.nodes) {
    const b = before.get(n.id);
    if (b !== undefined && b !== n.x * 1e6 + n.y) pinned.add(n.id);
  }
  const r = solveConstraints(d as unknown as Plan, pinned);
  if (!r.ok) {
    const c = d.constraints.find((x) => x.id === r.worstId);
    throw new CommandError(`That would break ${c ? describeConstraint(c as Constraint) : 'a lock'} (off by ${formatLength(Math.round(r.worst * 8) / 8)}). Remove the lock to do this.`);
  }
}

function parse<N extends CommandName>(name: N, params: unknown): z.infer<Commands[N]['params']> {
  const c = COMMANDS[name];
  if (!c) throw new CommandError(`Unknown command ${String(name)}`);
  const r = c.params.safeParse(params ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new CommandError(`${String(name)}: ${i?.path.join('.') || 'input'} ${i?.message ?? 'is invalid'}`);
  }
  return r.data as z.infer<Commands[N]['params']>;
}

/** Runs commands against a store. One per app. */
export class CommandBus {
  readonly journal: JournalEntry[] = [];
  readonly maxJournal = 500;
  private listeners = new Set<(e: JournalEntry) => void>();

  constructor(readonly store: PlanStore) {}

  /** Run a command as one undo step. Never throws for bad input: check `ok`. */
  exec<N extends CommandName>(name: N, params: ParamsOf<N>, source: Source = 'user'): CommandResult<ResultOf<N>> {
    let out: CommandResult<ResultOf<N>>;
    try {
      const p = parse(name, params);
      const c = COMMANDS[name] as unknown as Def<z.ZodType, ResultOf<N>>;
      const label = c.label?.(p) ?? c.title;
      const value = this.store.edit(label, (d) => {
        const before = new Map(d.nodes.map((n) => [n.id, n.x * 1e6 + n.y]));
        const v = c.run(d, p, { source });
        settle(d, before);
        return v;
      });
      out = { ok: true, value };
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      out = { ok: false, error: e.message };
    }
    const entry: JournalEntry = { at: new Date().toISOString(), name, params, source, ok: out.ok, ...(out.ok ? {} : { error: out.error }) };
    this.journal.push(entry);
    if (this.journal.length > this.maxJournal) this.journal.shift();
    for (const l of this.listeners) l(entry);
    return out;
  }

  /** Run several commands as one undo step. */
  group<T>(label: string, fn: () => T): T {
    this.store.begin(label);
    try {
      return fn();
    } finally {
      this.store.end();
    }
  }

  /** Same as exec, but returns the value or null (bad input is logged, not thrown). */
  run<N extends CommandName>(name: N, params: ParamsOf<N>, source: Source = 'user'): ResultOf<N> | null {
    const r = this.exec(name, params, source);
    return r.ok ? r.value : null;
  }

  /** Try a command on a copy of the plan: what would it do? Nothing is changed. */
  preview<N extends CommandName>(name: N, params: ParamsOf<N>): { ok: true; plan: Plan; value: ResultOf<N> } | { ok: false; error: string } {
    try {
      const p = parse(name, params);
      const c = COMMANDS[name] as unknown as Def<z.ZodType, ResultOf<N>>;
      let value!: ResultOf<N>;
      const plan = produce(this.store.plan, (d) => {
        const before = new Map(d.nodes.map((n) => [n.id, n.x * 1e6 + n.y]));
        value = c.run(d, p, { source: 'assistant' });
        settle(d, before);
      });
      return { ok: true, plan, value };
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      return { ok: false, error: e.message };
    }
  }

  onRun(fn: (e: JournalEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Command definitions as tool specs (JSON Schema inputs), for an assistant or WebMCP. */
export function toolSpecs(): ToolSpec[] {
  return (Object.keys(COMMANDS) as CommandName[])
    .filter((n) => !(COMMANDS[n] as { internal?: boolean }).internal)
    .map((name) => {
      const c = COMMANDS[name];
      return { name, title: c.title, description: c.description, inputSchema: z.toJSONSchema(c.params, { io: 'input', unrepresentable: 'any' }) };
    });
}

/** A compact, model-friendly description of the plan (what an assistant reads first). */
export function describePlan(plan: Plan): unknown {
  const r = (n: number) => Math.round(n * 4) / 4;
  const node = new Map(plan.nodes.map((n) => [n.id, n]));
  const wallOut = (w: Wall) => {
    const a = node.get(w.a)!;
    const b = node.get(w.b)!;
    return {
      id: w.id,
      a: { x: r(a.x), y: r(a.y) },
      b: { x: r(b.x), y: r(b.y) },
      length: r(wallLength(plan, w)),
      height: w.height,
      thickness: w.thickness,
      phase: w.kind === 'new' ? 'new' : w.demolish ? 'demolish' : 'existing',
      evidence: w.evidence,
      ...(w.locked ? { locked: true } : {}),
      openings: plan.openings
        .filter((o) => o.wallId === w.id)
        .map((o) => ({ id: o.id, type: o.type, offset: r(o.offset), width: o.width, height: o.height, sill: o.sill, phase: o.kind, ...(o.locked ? { locked: true } : {}) })),
    };
  };
  return {
    units: 'inches; x/y on the floor, z up',
    name: plan.name,
    settings: { wallHeight: plan.settings.wallHeight, wallThickness: plan.settings.wallThickness, ceilingType: plan.settings.ceilingType, floorFinish: plan.settings.floorFinish },
    walls: plan.walls.map(wallOut),
    rooms: plan.rooms.map((x) => ({ id: x.id, name: x.name, seed: x.seed, finish: x.finish })),
    pins: plan.markers.map((m) => ({ id: m.id, type: m.type, x: r(m.x), y: r(m.y), z: r(m.z), wallId: m.wallId })),
    soffits: plan.soffits.map((s) => ({ id: s.id, bottom: s.bottom, poly: s.poly.map((q) => ({ x: r(q.x), y: r(q.y) })) })),
    objects: plan.obstacles.map((o) => ({ id: o.id, label: o.label, height: o.height })),
    locks: plan.constraints.map((c) => ({ id: c.id, type: c.type, a: c.a, ...(c.b ? { b: c.b } : {}), ...(c.value !== null ? { value: c.value } : {}), ...(c.type === 'distance' ? { mode: c.mode } : {}) })),
  };
}
