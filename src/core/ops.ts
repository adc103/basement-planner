import type { Draft } from 'immer';
import { add, dist, dot, norm, projectOnSegment, scale, sub, type Vec2 } from './geom2d.js';
import { FramingSchema, newId, type Marker, type Measure, type Obstacle, type Opening, type Plan, type PlanNode, type Room, type Wall } from './plan.js';

/** Things that read a plan work on both frozen plans and drafts. */
type AnyPlan = Plan | Draft<Plan>;

/** Points closer than this (inches) are the same node. */
export const NODE_MERGE_TOL = 0.05;

export function nodeById(plan: AnyPlan, id: string): PlanNode | undefined {
  return plan.nodes.find((n) => n.id === id);
}

export function wallById(plan: AnyPlan, id: string): Wall | undefined {
  return plan.walls.find((w) => w.id === id);
}

export function wallEnds(plan: AnyPlan, wall: Wall): { a: Vec2; b: Vec2 } {
  const a = nodeById(plan, wall.a);
  const b = nodeById(plan, wall.b);
  if (!a || !b) throw new Error(`wall ${wall.id} has missing nodes`);
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
}

export function wallLength(plan: AnyPlan, wall: Wall): number {
  const { a, b } = wallEnds(plan, wall);
  return dist(a, b);
}

export function wallsAtNode(plan: AnyPlan, nodeId: string): Wall[] {
  return plan.walls.filter((w) => w.a === nodeId || w.b === nodeId) as Wall[];
}

export function findNodeNear(plan: AnyPlan, p: Vec2, tol = NODE_MERGE_TOL): PlanNode | undefined {
  let best: PlanNode | undefined;
  let bestD = tol;
  for (const n of plan.nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= bestD) {
      bestD = d;
      best = n as PlanNode;
    }
  }
  return best;
}

/** A wall whose interior (not the end nodes) passes within `tol` of p. */
export function findWallThrough(
  plan: AnyPlan,
  p: Vec2,
  tol = NODE_MERGE_TOL,
): { wall: Wall; t: number } | undefined {
  for (const w of plan.walls) {
    const { a, b } = wallEnds(plan, w as Wall);
    const pr = projectOnSegment(p, a, b);
    const l = dist(a, b);
    if (pr.t * l > tol && (1 - pr.t) * l > tol && dist(pr.point, p) <= tol) {
      return { wall: w as Wall, t: pr.t };
    }
  }
  return undefined;
}

/**
 * Split a wall at parameter t (0..1). Openings move to whichever half holds
 * their center. Returns the new node id.
 */
export function splitWall(d: Draft<Plan>, wallId: string, t: number): string {
  const w = d.walls.find((x) => x.id === wallId);
  if (!w) throw new Error(`no wall ${wallId}`);
  const { a, b } = wallEnds(d, w as Wall);
  const p = add(a, scale(sub(b, a), t));
  const node = { id: newId('n'), x: p.x, y: p.y };
  d.nodes.push(node);
  const total = dist(a, b);
  const cut = total * t;
  const second = {
    ...JSON.parse(JSON.stringify(w)),
    id: newId('w'),
    a: node.id,
    b: w.b,
  } as Wall;
  w.b = node.id;
  d.walls.push(second);
  for (const o of d.openings) {
    if (o.wallId !== w.id) continue;
    if (o.offset > cut) {
      o.wallId = second.id;
      o.offset -= cut;
    }
  }
  return node.id;
}

/**
 * Return the node at p, reusing an existing node or splitting a wall the
 * point lies on. Creates a fresh node otherwise.
 */
export function ensureNode(d: Draft<Plan>, p: Vec2): string {
  const existing = findNodeNear(d, p);
  if (existing) return existing.id;
  const through = findWallThrough(d, p);
  if (through) return splitWall(d, through.wall.id, through.t);
  const node = { id: newId('n'), x: p.x, y: p.y };
  d.nodes.push(node);
  return node.id;
}

export interface NewWallProps {
  height: number;
  thickness: number;
  kind?: 'new' | 'existing';
  againstFoundation?: boolean;
  source?: 'draw' | 'scan' | 'capture';
}

/** Add a wall between two points. Returns the wall id, or null if degenerate/duplicate. */
export function addWallBetween(d: Draft<Plan>, p1: Vec2, p2: Vec2, props: NewWallProps): string | null {
  if (dist(p1, p2) < 0.5) return null;
  const aId = ensureNode(d, p1);
  const bId = ensureNode(d, p2);
  if (aId === bId) return null;
  const dup = d.walls.find((w) => (w.a === aId && w.b === bId) || (w.a === bId && w.b === aId));
  if (dup) return null;
  const wall: Wall = {
    id: newId('w'),
    a: aId,
    b: bId,
    height: props.height,
    thickness: props.thickness,
    kind: props.kind ?? 'new',
    source: props.source ?? (props.kind === 'existing' ? 'scan' : 'draw'),
    againstFoundation: props.againstFoundation ?? false,
    framing: JSON.parse(JSON.stringify(d.settings.framing ?? FramingSchema.parse({}))),
  };
  d.walls.push(wall);
  return wall.id;
}

/**
 * Set a wall's length by moving one end along the wall direction.
 * `keep` is the node that stays put.
 */
export function setWallLength(d: Draft<Plan>, wallId: string, length: number, keep: 'a' | 'b' = 'a'): boolean {
  const w = d.walls.find((x) => x.id === wallId);
  if (!w || length < 0.5) return false;
  const fixedId = keep === 'a' ? w.a : w.b;
  const movingId = keep === 'a' ? w.b : w.a;
  const fixed = d.nodes.find((n) => n.id === fixedId)!;
  const moving = d.nodes.find((n) => n.id === movingId)!;
  const dir = norm(sub(moving, fixed));
  const p = add(fixed, scale(dir, length));
  moving.x = p.x;
  moving.y = p.y;
  clampOpenings(d, wallId);
  return true;
}

export function setWallHeight(d: Draft<Plan>, wallId: string, height: number): void {
  const w = d.walls.find((x) => x.id === wallId);
  if (w && height > 0) w.height = height;
}

/** Delete a wall, its openings and any nodes that become orphaned. */
export function deleteWall(d: Draft<Plan>, wallId: string): void {
  const idx = d.walls.findIndex((w) => w.id === wallId);
  if (idx < 0) return;
  d.walls.splice(idx, 1);
  d.openings = d.openings.filter((o) => o.wallId !== wallId);
  for (const m of d.markers) if (m.wallId === wallId) m.wallId = null;
  pruneNodes(d);
}

export function pruneNodes(d: Draft<Plan>): void {
  const used = new Set<string>();
  for (const w of d.walls) {
    used.add(w.a);
    used.add(w.b);
  }
  d.nodes = d.nodes.filter((n) => used.has(n.id));
}

/** Edge clearance kept between an opening and a wall end, inches. */
export const OPENING_END_CLEARANCE = 1.5;

/**
 * Clamp an opening's center so it sits fully inside the wall.
 * Returns null if the wall is too short for this width.
 */
export function clampOpeningOffset(wallLen: number, width: number, offset: number): number | null {
  const min = width / 2 + OPENING_END_CLEARANCE;
  const max = wallLen - width / 2 - OPENING_END_CLEARANCE;
  if (max < min) return null;
  return Math.max(min, Math.min(max, offset));
}

function clampOpenings(d: Draft<Plan>, wallId: string): void {
  const w = d.walls.find((x) => x.id === wallId);
  if (!w) return;
  const l = wallLength(d, w as Wall);
  d.openings = d.openings.filter((o) => {
    if (o.wallId !== wallId) return true;
    const c = clampOpeningOffset(l, o.width, o.offset);
    if (c === null) return false;
    o.offset = c;
    return true;
  });
}

/** True if an opening [offset±width/2] overlaps another on the same wall. */
export function openingOverlaps(plan: AnyPlan, wallId: string, offset: number, width: number, ignoreId?: string): boolean {
  return plan.openings.some(
    (o) =>
      o.wallId === wallId &&
      o.id !== ignoreId &&
      Math.abs(o.offset - offset) < (o.width + width) / 2 + 1,
  );
}

export function addOpening(d: Draft<Plan>, o: Omit<Opening, 'id'>): string | null {
  const w = d.walls.find((x) => x.id === o.wallId);
  if (!w) return null;
  const l = wallLength(d, w as Wall);
  const offset = clampOpeningOffset(l, o.width, o.offset);
  if (offset === null) return null;
  if (openingOverlaps(d, o.wallId, offset, o.width)) return null;
  const height = Math.min(o.height, w.height - o.sill - 1);
  if (height <= 0) return null;
  const id = newId('o');
  d.openings.push({ ...o, id, offset, height });
  return id;
}

export function deleteOpening(d: Draft<Plan>, id: string): void {
  d.openings = d.openings.filter((o) => o.id !== id);
}

/** Replace all 'existing' walls (e.g. a fresh room-scan import). */
export function replaceExistingWalls(
  d: Draft<Plan>,
  segments: Array<{ a: Vec2; b: Vec2 }>,
  height: number,
): number {
  // Only scanned walls are replaced; captured walls and everything you drew stay.
  for (const w of [...d.walls]) if (w.kind === 'existing' && w.source !== 'capture') deleteWall(d, w.id);
  let count = 0;
  for (const s of segments) {
    const id = addWallBetween(d, s.a, s.b, {
      height,
      thickness: d.settings.foundationThickness,
      kind: 'existing',
      source: 'scan',
    });
    if (id) count++;
  }
  return count;
}

/** Offset of point p along wall (distance from node a), and signed distance from centerline. */
export function locateOnWall(plan: AnyPlan, wall: Wall, p: Vec2): { along: number; across: number; length: number } {
  const { a, b } = wallEnds(plan, wall);
  const l = dist(a, b);
  const dir = norm(sub(b, a));
  const rel = sub(p, a);
  return { along: dot(rel, dir), across: dir.x * rel.y - dir.y * rel.x, length: l };
}

// --- Editing -----------------------------------------------------------------

/** Move a corner. Openings on the attached walls are re-clamped. */
export function moveNode(d: Draft<Plan>, nodeId: string, p: Vec2): void {
  const n = d.nodes.find((x) => x.id === nodeId);
  if (!n) return;
  n.x = p.x;
  n.y = p.y;
  for (const w of d.walls) if (w.a === nodeId || w.b === nodeId) clampOpenings(d, w.id);
}

/** Slide an opening along its wall. Returns false if it doesn't fit there. */
export function moveOpening(d: Draft<Plan>, openingId: string, offset: number): boolean {
  const o = d.openings.find((x) => x.id === openingId);
  if (!o) return false;
  const w = d.walls.find((x) => x.id === o.wallId);
  if (!w) return false;
  const c = clampOpeningOffset(wallLength(d, w as Wall), o.width, offset);
  if (c === null || openingOverlaps(d, o.wallId, c, o.width, o.id)) return false;
  o.offset = c;
  return true;
}

export function setWallThickness(d: Draft<Plan>, wallId: string, thickness: number): void {
  const w = d.walls.find((x) => x.id === wallId);
  if (!w || thickness <= 0) return;
  w.thickness = thickness;
  w.framing.studSize = thickness >= 6 ? '2x6' : '2x4';
}

// --- Markers, rooms, measures ---------------------------------------------------

export function addMarker(d: Draft<Plan>, m: Omit<Marker, 'id'>): string {
  const id = newId('m');
  d.markers.push({ ...m, id });
  return id;
}

export function deleteMarker(d: Draft<Plan>, id: string): void {
  d.markers = d.markers.filter((m) => m.id !== id);
}

export function moveMarker(d: Draft<Plan>, id: string, p: { x: number; y: number; z: number }, wallId: string | null): void {
  const m = d.markers.find((x) => x.id === id);
  if (!m) return;
  m.x = p.x;
  m.y = p.y;
  m.z = p.z;
  m.wallId = wallId;
}

export function upsertRoom(d: Draft<Plan>, seed: Vec2, patch: Partial<Omit<Room, 'id' | 'seed'>>, existingId?: string): string {
  const r = existingId ? d.rooms.find((x) => x.id === existingId) : undefined;
  if (r) {
    Object.assign(r, patch);
    return r.id;
  }
  const id = newId('r');
  d.rooms.push({
    id,
    seed: { ...seed },
    name: patch.name ?? 'Room',
    finish: patch.finish ?? 'none',
    ceilingType: patch.ceilingType ?? null,
    ceilingHeight: patch.ceilingHeight ?? null,
  });
  return id;
}

export function deleteRoom(d: Draft<Plan>, id: string): void {
  d.rooms = d.rooms.filter((r) => r.id !== id);
}

export function addMeasure(d: Draft<Plan>, a: Measure['a'], b: Measure['b']): string {
  const id = newId('ms');
  d.measures.push({ id, a: { ...a }, b: { ...b } });
  return id;
}

export function deleteMeasure(d: Draft<Plan>, id: string): void {
  d.measures = d.measures.filter((m) => m.id !== id);
}

export function setObstacles(d: Draft<Plan>, obstacles: Array<Omit<Obstacle, 'id'>>): void {
  d.obstacles = d.obstacles.filter((o) => o.source === 'manual');
  for (const o of obstacles) d.obstacles.push({ ...o, id: newId('ob'), poly: o.poly.map((p) => ({ ...p })) });
}

// --- Ceiling ----------------------------------------------------------------------

export function addSoffit(d: Draft<Plan>, poly: Vec2[], bottom: number): string | null {
  if (poly.length < 3) return null;
  const id = newId('sf');
  d.soffits.push({ id, poly: poly.map((p) => ({ x: p.x, y: p.y })), bottom });
  return id;
}

export function deleteSoffit(d: Draft<Plan>, id: string): void {
  d.soffits = d.soffits.filter((s) => s.id !== id);
}

export function setSoffitBottom(d: Draft<Plan>, id: string, bottom: number): void {
  const s = d.soffits.find((x) => x.id === id);
  if (s && bottom > 0) s.bottom = bottom;
}

/** Ceiling height and type for a room (its overrides or the plan default). */
export function roomCeiling(plan: AnyPlan, room?: Room | null): { height: number; type: Plan['settings']['ceilingType'] } {
  return {
    height: room?.ceilingHeight ?? plan.settings.wallHeight,
    type: room?.ceilingType ?? plan.settings.ceilingType,
  };
}
