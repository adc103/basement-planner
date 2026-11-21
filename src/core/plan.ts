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
});
export type Marker = z.infer<typeof MarkerSchema>;

export const FINISHES = ['none', 'carpet', 'lvp', 'tile', 'concrete', 'epoxy'] as const;
export type Finish = (typeof FINISHES)[number];

/** A named room. Its outline is the closed wall loop containing `seed`. */
export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  seed: PointSchema,
  finish: z.enum(FINISHES).default('none'),
});
export type Room = z.infer<typeof RoomSchema>;

/** A saved tape-measure line, plan inches (z = height). */
export const MeasureSchema = z.object({ id: z.string(), a: Point3Schema, b: Point3Schema });
export type Measure = z.infer<typeof MeasureSchema>;

export const PlanSchema = z.object({
  format: z.literal('basement-planner'),
  version: z.literal(1),
  name: z.string().default('Basement'),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: z.object({
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
  }),
  nodes: z.array(NodeSchema).default([]),
  walls: z.array(WallSchema).default([]),
  openings: z.array(OpeningSchema).default([]),
  obstacles: z.array(ObstacleSchema).default([]),
  markers: z.array(MarkerSchema).default([]),
  rooms: z.array(RoomSchema).default([]),
  measures: z.array(MeasureSchema).default([]),
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

export function createEmptyPlan(now = new Date()): Plan {
  const iso = now.toISOString();
  return PlanSchema.parse({
    format: 'basement-planner',
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    settings: {},
  });
}

/** Validate an unknown JSON value as a plan. Throws a readable error on failure. */
export function parsePlan(json: unknown): Plan {
  const result = PlanSchema.safeParse(json);
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
  for (const m of plan.markers) if (m.wallId && !wallIds.has(m.wallId)) m.wallId = null;
  return plan;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
