import type { Draft } from 'immer';
import { replaceExistingWalls, setObstacles, setWallHeight, type ObstacleInput } from './ops.js';
import type { Plan } from './plan.js';
import type { ScanWall } from './roomScan.js';

/** Quest Space Setup import: walls from the room planes, objects from its boxes. */
export interface RoomScanImport {
  walls: ScanWall[];
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
