import type { Draft } from 'immer';
import { mergeFootprints } from './footprint.js';
import type { Vec2 } from './geom2d.js';
import { addOpening, addSoffit, addWallBetween, replaceExistingWalls, setObstacles, setWallHeight, splitAtNodes, type ObstacleInput } from './ops.js';
import { newId, ObstacleSchema, type Plan } from './plan.js';
import type { StructureResult } from './structure.js';

/**
 * Put reviewed scan results into the plan: real walls with their doors and
 * windows (joined into one connected wall graph), low areas, posts, the
 * ceiling height and the floor footprint.
 */
export function applyScan(d: Draft<Plan>, res: StructureResult): void {
  const off = res.floorOffset ?? 0;
  const ceiling = res.ceiling !== null ? res.ceiling - off : null;
  const goodCeiling = ceiling !== null && ceiling > 60 && ceiling < 180;
  const H = goodCeiling ? ceiling! : d.settings.wallHeight;
  if (goodCeiling) {
    const old = d.settings.wallHeight;
    d.settings.wallHeight = H;
    for (const w of d.walls) if (w.kind === 'new' && w.height === old) setWallHeight(d, w.id, H);
  }
  for (const w of res.walls) {
    const id = addWallBetween(d, w.a, w.b, { height: H, thickness: w.thickness, kind: 'existing', source: 'capture', againstFoundation: false, evidence: 'measured', confidence: Math.max(0, Math.min(1, w.confidence)) });
    if (!id) continue;
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    for (const o of w.openings) {
      const offset = ((o.center.x - w.a.x) * (w.b.x - w.a.x) + (o.center.y - w.a.y) * (w.b.y - w.a.y)) / len;
      addOpening(d, { wallId: id, type: o.type, offset, width: o.width, height: Math.min(o.height, H - o.sill), sill: o.sill, hinge: 'a', swing: 'left', kind: 'existing', evidence: 'measured' });
    }
  }
  splitAtNodes(d);
  for (const s of res.soffits) addSoffit(d, s.poly, Math.min(H - 1, s.bottom));
  for (const p of res.posts) d.obstacles.push(ObstacleSchema.parse({ id: newId('ob'), label: 'Post', poly: p.poly.map((q) => ({ ...q })), height: H, source: 'manual' }));
  if (res.footprint) d.footprint = mergeFootprints(res.footprint, d.footprint ?? null);
}

/** Quest Space Setup import: walls from the room planes, objects from its boxes. */
export interface RoomScanImport {
  walls: Array<{ a: Vec2; b: Vec2 }>;
  objects: ObstacleInput[];
  /** Floor-to-ceiling, inches, when trustworthy. */
  ceiling: number | null;
  signature: string;
}

export function applyRoomScan(d: Draft<Plan>, r: RoomScanImport): void {
  const good = r.ceiling !== null && r.ceiling > 60 && r.ceiling < 180;
  if (r.walls.length) replaceExistingWalls(d, r.walls, good ? r.ceiling! : d.settings.wallHeight);
  setObstacles(d, r.objects);
  if (good) {
    const old = d.settings.wallHeight;
    d.settings.wallHeight = r.ceiling!;
    // New walls still at the old default height follow the ceiling.
    for (const w of d.walls) if (w.kind === 'new' && w.height === old) setWallHeight(d, w.id, r.ceiling!);
  }
  d.settings.scanSignature = r.signature;
}
