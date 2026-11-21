import { addMarker, wallNormalToward } from '../../core/ops.js';
import type { MarkerType } from '../../core/plan.js';
import { MARKER_INFO } from '../../core/plan2d.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

export type PinPlace = 'wall' | 'ceiling' | 'floor';

export const PIN_PLACE: Record<MarkerType, PinPlace> = {
  outlet: 'wall',
  switch: 'wall',
  panel: 'wall',
  light: 'ceiling',
  'water-heater': 'floor',
  furnace: 'floor',
  drain: 'floor',
  pipe: 'floor',
  post: 'floor',
};

/** Standard mounting heights (inches) the pin snaps to when close. */
const STANDARD_Z: Partial<Record<MarkerType, number>> = { outlet: 12, switch: 48, panel: 54 };

export function snapPinHeight(type: MarkerType, z: number): number {
  const std = STANDARD_Z[type];
  if (std !== undefined && Math.abs(z - std) <= 5) return std;
  return Math.round(z);
}

/** Drop utility pins: outlets/switches/panel on walls, lights on the ceiling, the rest on the floor. */
export class PinsTool implements Tool {
  readonly name = 'Pins';
  type: MarkerType = 'outlet';

  constructor(private ctx: ToolContext) {}

  activate(): void {}
  deactivate(): void {
    this.ctx.preview.clear();
  }

  hint(): string {
    const where = PIN_PLACE[this.type];
    return `${MARKER_INFO[this.type].name}: point at ${where === 'wall' ? 'a wall' : where === 'ceiling' ? 'the ceiling' : 'the floor'}`;
  }

  private spot(aim: AimHit): { x: number; y: number; z: number; wallId: string | null } | null {
    const where = PIN_PLACE[this.type];
    if (where === 'wall') {
      if (aim.wall) {
        return { x: aim.wall.point.x, y: aim.wall.point.y, z: snapPinHeight(this.type, aim.wall.z), wallId: aim.wall.wallId };
      }
      const s = aim.surface;
      if (s && Math.hypot(s.n.x, s.n.y) > 0.7) return { x: s.p.x, y: s.p.y, z: snapPinHeight(this.type, s.z), wallId: null };
      return null;
    }
    if (where === 'ceiling') {
      if (!aim.ceiling) return null;
      return { x: Math.round(aim.ceiling.x), y: Math.round(aim.ceiling.y), z: this.ctx.store.plan.settings.wallHeight, wallId: null };
    }
    if (!aim.floor) return null;
    return { x: aim.floor.x, y: aim.floor.y, z: 0, wallId: null };
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim) return;
    const p = this.spot(aim);
    if (!p) {
      if (aim.floor) pv.showHint(this.hint(), aim.floor, 20);
      return;
    }
    const where = PIN_PLACE[this.type];
    const facing =
      where === 'ceiling' ? 'down' : where !== 'wall' ? undefined : p.wallId ? wallNormalToward(this.ctx.store.plan, p.wallId, aim.eye) : aim.surface?.n;
    pv.showCursorAt(p, 'free', aim.fine, facing);
    pv.showHint(`${MARKER_INFO[this.type].name}${p.z > 0 && PIN_PLACE[this.type] === 'wall' ? ` at ${formatLength(p.z)}` : ''}`, p, p.z + 8);
  }

  commit(aim: AimHit): void {
    const p = this.spot(aim);
    if (!p) {
      this.ctx.toast(this.hint());
      return;
    }
    this.ctx.store.edit(`Add ${MARKER_INFO[this.type].name.toLowerCase()}`, (d) =>
      addMarker(d, { type: this.type, x: p.x, y: p.y, z: p.z, wallId: p.wallId, note: '' }),
    );
  }
}
