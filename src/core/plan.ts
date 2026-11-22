import { z } from 'zod';

/**
 * The plan document. Everything is in inches, in "plan space" (a 2D floor
 * coordinate system). The XR layer maps plan space to the real room via the
 * alignment transform.
 */

export const FramingSchema = z.object({
  studSize: z.enum(['2x4', '2x6']).default('2x4'),
  /** On-center spacing, inches. */
  spacing: z.number().positive().default(16),
  /** Which end the stud layout starts from. */
  layoutFrom: z.enum(['a', 'b']).default('a'),
  topPlates: z.number().int().min(1).max(2).default(2),
  /** Bottom plate on concrete should be pressure treated. */
  pressureTreatedBottom: z.boolean().default(true),
  /** For walls framed against a foundation wall: style + gap to the concrete. */
  foundationStyle: z.enum(['stud-gap', 'furring']).default('stud-gap'),
  foundationGap: z.number().min(0).default(1),
});
export type Framing = z.infer<typeof FramingSchema>;

/** How sure we are about an element's geometry (scan-to-model provenance). */
export const EVIDENCE = ['measured', 'partial', 'inferred', 'manual'] as const;
export type Evidence = (typeof EVIDENCE)[number];

/** Fields every editable element shares. */
const elementFields = {
  /** Locked elements refuse edits from every source (you, the scanner, an assistant). */
  locked: z.boolean().default(false),
};
const provenanceFields = {
  /** measured = seen directly; partial = partly seen; inferred = filled in by rules; manual = drawn. */
  evidence: z.enum(EVIDENCE).default('manual'),
  /** Scanner confidence 0-1 when the element came from a scan. */
  confidence: z.number().min(0).max(1).nullable().default(null),
};

export const LevelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Floor elevation, inches, relative to the main floor. */
  elevation: z.number().default(0),
});
export type Level = z.infer<typeof LevelSchema>;
export const DEFAULT_LEVEL = 'L1';

export const NodeSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
});
export type PlanNode = z.infer<typeof NodeSchema>;

export const WallSchema = z.object({
  id: z.string(),
  a: z.string(),
  b: z.string(),
  /** Height in inches. */
  height: z.number().positive(),
  /** Finished thickness in inches (stud + drywall). */
  thickness: z.number().positive(),
  /** 'existing' = real foundation / pre-existing wall (from the room scan). Locked. */
  kind: z.enum(['new', 'existing']).default('new'),
  /** Where an existing wall came from: the Quest room scan or point-and-capture. */
  source: z.enum(['draw', 'scan', 'capture']).optional(),
  /** True when this new wall is framed against a foundation wall. */
  againstFoundation: z.boolean().default(false),
  framing: FramingSchema.default(FramingSchema.parse({})),
  /** An existing wall marked to be torn out (phase: demolish). Ignored for 'new' walls. */
  demolish: z.boolean().default(false),
  level: z.string().default(DEFAULT_LEVEL),
  ...elementFields,
  ...provenanceFields,
});
export type Wall = z.infer<typeof WallSchema>;

export const OpeningSchema = z.object({
  id: z.string(),
  wallId: z.string(),
  type: z.enum(['door', 'opening', 'window']),
  /** Distance from wall node `a` to the opening's center, inches. */
  offset: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Bottom of the opening above the floor (0 for doors). */
  sill: z.number().min(0).default(0),
  /** Door swing side, for later drawing. */
  hinge: z.enum(['a', 'b']).default('a'),
  swing: z.enum(['left', 'right']).default('left'),
  /** 'existing' = already there; 'new' = to be cut or framed. */
  kind: z.enum(['new', 'existing']).default('new'),
  ...elementFields,
  ...provenanceFields,
});
export type Opening = z.infer<typeof OpeningSchema>;

const PointSchema = z.object({ x: z.number(), y: z.number() });
const Point3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** A real-world object from the room scan (furnace, storage, stairs...). Footprint in plan inches. */
export const ObstacleSchema = z.object({
  id: z.string(),
  label: z.string(),
  poly: z.array(PointSchema),
  height: z.number().positive(),
  source: z.enum(['scan', 'manual']).default('scan'),
  ...elementFields,
});
export type Obstacle = z.infer<typeof ObstacleSchema>;

export const MARKER_TYPES = [
  'outlet',
  'switch',
  'light',
  'panel',
  'water-heater',
  'furnace',
  'drain',
  'pipe',
  'post',
] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];

/** A utility pin. (x, y) in plan inches, z = height above the floor. */
export const MarkerSchema = z.object({
  id: z.string(),
  type: z.enum(MARKER_TYPES),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** Wall it is mounted on, if any. */
  wallId: z.string().nullable().default(null),
  note: z.string().default(''),
  ...elementFields,
});
export type Marker = z.infer<typeof MarkerSchema>;

export const FINISHES = ['none', 'carpet', 'lvp', 'tile', 'concrete', 'epoxy'] as const;
export type Finish = (typeof FINISHES)[number];

export const CEILING_TYPES = ['drywall', 'drop', 'open'] as const;
export type CeilingType = (typeof CEILING_TYPES)[number];

/** A named room. Its outline is the closed wall loop containing `seed`. */
export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  seed: PointSchema,
  finish: z.enum(FINISHES).default('none'),
  /** Overrides of the plan-wide ceiling (null = use the default). */
  ceilingType: z.enum(CEILING_TYPES).nullable().default(null),
  ceilingHeight: z.number().positive().nullable().default(null),
  ...elementFields,
});

/** A lowered box in the ceiling (around ducts, beams, pipes). Footprint in plan inches. */
export const SoffitSchema = z.object({
  id: z.string(),
  poly: z.array(PointSchema),
  /** Height of the soffit's underside above the floor, inches. */
  bottom: z.number().positive(),
  ...elementFields,
});
export type Soffit = z.infer<typeof SoffitSchema>;

/** A planned solid on the floor: bench, counter, cabinet run, closet, built-in. */
export const BoxSchema = z.object({
  id: z.string(),
  label: z.string().default('Box'),
  /** Footprint, plan inches (a rectangle from the box tool; push/pull keeps it one). */
  poly: z.array(PointSchema),
  /** Bottom and top above the floor, inches. */
  z0: z.number().min(0).default(0),
  z1: z.number().positive(),
  ...elementFields,
});
export type Box = z.infer<typeof BoxSchema>;
export type Room = z.infer<typeof RoomSchema>;

/**
 * A lock between walls that every edit keeps true (CAD-style constraints).
 * length: wall stays `value` long. distance: walls b and a stay parallel,
 * `value` apart (clear = face to face, center = centerline to centerline).
 * parallel / perpendicular / collinear: between walls a and b.
 */
export const CONSTRAINT_TYPES = ['length', 'distance', 'parallel', 'perpendicular', 'collinear'] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];
export const ConstraintSchema = z.object({
  id: z.string(),
  type: z.enum(CONSTRAINT_TYPES),
  a: z.string(),
  b: z.string().nullable().default(null),
  value: z.number().nullable().default(null),
  mode: z.enum(['clear', 'center']).default('clear'),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** A saved tape-measure line, plan inches (z = height). */
export const MeasureSchema = z.object({
  id: z.string(),
  a: Point3Schema,
  b: Point3Schema,
  /** What a real tape measure says for this distance (for checking accuracy), inches. */
  truth: z.number().positive().nullable().default(null),
});
export type Measure = z.infer<typeof MeasureSchema>;

/** Plan-wide settings and defaults. */
export const SettingsSchema = z.object({
  /** Default height for new walls (floor to ceiling), inches. */
  wallHeight: z.number().positive().default(96),
  /** Default finished thickness for new interior walls, inches. */
  wallThickness: z.number().positive().default(4.5),
  /** Assumed thickness of an existing foundation wall, inches. */
  foundationThickness: z.number().positive().default(8),
  /** Default framing for new walls. */
  framing: FramingSchema.default(FramingSchema.parse({})),
  /** Thickness given to walls captured by pointing at them (existing partitions). */
  captureThickness: z.number().positive().default(4.5),
  /** Fingerprint of the last room scan imported, so unchanged scans aren't re-imported. */
  scanSignature: z.string().nullable().default(null),
  autoImportScan: z.boolean().default(true),
  ceilingType: z.enum(CEILING_TYPES).default('drywall'),
  showCeiling: z.boolean().default(false),
  /** How real (existing) walls are drawn: like planned walls, as outlines, or not at all. */
  realWalls: z.enum(['shown', 'outline', 'hidden']).default('shown'),
  /** Floor finish for the area outside named rooms. */
  floorFinish: z.enum(FINISHES).default('none'),
  /** Default underside height for new soffits, inches. */
  soffitBottom: z.number().positive().default(84),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const PlanSchema = z.object({
  format: z.literal('basement-planner'),
  /** 1 = first release; 2 = building model (phases, locks, evidence, levels). */
  version: z.literal(2),
  name: z.string().default('Basement'),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: SettingsSchema,
  levels: z.array(LevelSchema).default([{ id: DEFAULT_LEVEL, name: 'Basement', elevation: 0 }]),
  nodes: z.array(NodeSchema).default([]),
  walls: z.array(WallSchema).default([]),
  openings: z.array(OpeningSchema).default([]),
  obstacles: z.array(ObstacleSchema).default([]),
  markers: z.array(MarkerSchema).default([]),
  rooms: z.array(RoomSchema).default([]),
  measures: z.array(MeasureSchema).default([]),
  soffits: z.array(SoffitSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
  boxes: z.array(BoxSchema).default([]),
  /** Scanned floor area, cells in the room's axis frame (see core/footprint.ts). */
  footprint: z
    .object({ axis: z.number(), cell: z.number().positive(), rows: z.array(z.tuple([z.number(), z.number(), z.number()])) })
    .nullable()
    .default(null),
  /**
   * Two reference points (plan space) recorded on real-world corners.
   * Re-clicking the same two physical corners realigns the plan.
   */
  reference: z
    .object({ r1: PointSchema, r2: PointSchema })
    .nullable()
    .default(null),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PLAN_VERSION = 2;

/** Bring an older plan file up to the current version (works on raw JSON). */
export function migratePlan(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const raw = { ...(json as Record<string, unknown>) };
  if (raw.version === 1) {
    // Openings in real walls were real openings.
    const walls = Array.isArray(raw.walls) ? (raw.walls as Array<{ id?: string; kind?: string; source?: string }>) : [];
    const kindOf = new Map(walls.map((w) => [w.id, w.kind ?? 'new']));
    if (Array.isArray(raw.openings))
      raw.openings = (raw.openings as Array<Record<string, unknown>>).map((o) => ({ kind: kindOf.get(o.wallId as string) ?? 'new', ...o }));
    // Scanned walls were measured, captured ones partly so.
    raw.walls = walls.map((w) => ({
      evidence: w.source === 'scan' ? 'measured' : w.source === 'capture' ? 'partial' : 'manual',
      ...w,
    }));
    raw.version = 2;
  }
  return raw;
}

export function createEmptyPlan(now = new Date()): Plan {
  const iso = now.toISOString();
  return PlanSchema.parse({
    format: 'basement-planner',
    version: PLAN_VERSION,
    createdAt: iso,
    updatedAt: iso,
    settings: {},
  });
}

/** Validate an unknown JSON value as a plan. Throws a readable error on failure. */
export function parsePlan(json: unknown): Plan {
  const result = PlanSchema.safeParse(migratePlan(json));
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `Not a valid plan file: ${first?.path.join('.') || '(root)'} ${first?.message ?? ''}`.trim(),
    );
  }
  const plan = result.data;
  // Referential integrity: drop dangling walls/openings rather than crash.
  const nodeIds = new Set(plan.nodes.map((n) => n.id));
  plan.walls = plan.walls.filter((w) => nodeIds.has(w.a) && nodeIds.has(w.b) && w.a !== w.b);
  const wallIds = new Set(plan.walls.map((w) => w.id));
  plan.openings = plan.openings.filter((o) => wallIds.has(o.wallId));
  plan.constraints = plan.constraints.filter((c) => wallIds.has(c.a) && (c.b === null || wallIds.has(c.b)));
  for (const m of plan.markers) if (m.wallId && !wallIds.has(m.wallId)) m.wallId = null;
  if (!plan.levels.length) plan.levels.push({ id: DEFAULT_LEVEL, name: 'Basement', elevation: 0 });
  return plan;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
