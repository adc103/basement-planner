import { add, rotate, scale, sub, type Vec2 } from '../../core/geom2d.js';
import { addSoffit, deleteSoffit } from '../../core/ops.js';
import { pointInPolygon } from '../../core/poly.js';
import { snap } from '../../core/snapping.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/**
 * Soffits: drag a rectangle on the floor under the duct/beam (corner to corner,
 * squared to the room). It becomes a box hanging from the ceiling down to the
 * soffit height. Tap an existing soffit's footprint to delete it.
 */
export class SoffitTool implements Tool {
  readonly name = 'Soffit';
  private start: Vec2 | null = null;
  private moved = false;

  constructor(
    private ctx: ToolContext,
    private axisAngle: () => number,
  ) {}

  activate(): void {}
  deactivate(): void {
    this.start = null;
    this.ctx.preview.clear();
  }

  inputMode(): 'place' | 'drag' {
    return 'drag';
  }

  hint(): string {
    return this.start ? 'Drag to the opposite corner, then let go' : 'Pinch a corner on the floor under the duct and drag';
  }

  /** Rectangle from two opposite corners, squared to the room axis. */
  rect(a: Vec2, b: Vec2): Vec2[] {
    const ang = this.axisAngle();
    const d = rotate(sub(b, a), -ang);
    const corners = [
      { x: 0, y: 0 },
      { x: d.x, y: 0 },
      { x: d.x, y: d.y },
      { x: 0, y: d.y },
    ];
    return corners.map((c) => add(a, rotate(c, ang)));
  }

  private point(aim: AimHit): Vec2 | null {
    if (!aim.floor) return null;
    return snap(this.ctx.store.plan, aim.floor, this.ctx.snapOptions(aim)).point;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const p = aim ? this.point(aim) : null;
    if (!p) return;
    pv.showCursor(p, 'grid', false);
    const over = this.ctx.store.plan.soffits.find((s) => pointInPolygon(p, s.poly));
    if (over) pv.showHint(`Soffit at ${formatLength(over.bottom)}: tap to delete`, p, 20);
  }

  pressStart(aim: AimHit): void {
    this.start = this.point(aim);
    this.moved = false;
  }

  drag(aim: AimHit): void {
    const pv = this.ctx.preview;
    pv.clear();
    const p = this.point(aim);
    if (!this.start || !p) return;
    const r = this.rect(this.start, p);
    if (Math.abs(p.x - this.start.x) + Math.abs(p.y - this.start.y) > 3) this.moved = true;
    pv.showFloorPoly(r);
    const w = Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
    const h = Math.hypot(r[3].x - r[0].x, r[3].y - r[0].y);
    pv.showHint(`${formatLength(w)} x ${formatLength(h)}`, scale(add(r[0], r[2]), 0.5), 10);
  }

  commit(aim: AimHit): void {
    const start = this.start;
    this.start = null;
    const p = this.point(aim);
    if (!start || !p) return;
    if (!this.moved) {
      const over = this.ctx.store.plan.soffits.find((s) => pointInPolygon(p, s.poly));
      if (over) {
        this.ctx.store.edit('Delete soffit', (d) => deleteSoffit(d, over.id));
        this.ctx.toast('Soffit deleted');
      }
      return;
    }
    const r = this.rect(start, p);
    const w = Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
    const h = Math.hypot(r[3].x - r[0].x, r[3].y - r[0].y);
    if (w < 3 || h < 3) {
      this.ctx.toast('Drag a bigger rectangle (at least 3" each way)');
      return;
    }
    const bottom = this.ctx.store.plan.settings.soffitBottom;
    this.ctx.store.edit('Add soffit', (d) => addSoffit(d, r, bottom));
    this.ctx.toast(`Soffit ${formatLength(w)} x ${formatLength(h)}, bottom at ${formatLength(bottom)}`);
  }
}
