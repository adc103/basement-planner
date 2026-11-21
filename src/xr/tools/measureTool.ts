import { type Vec2 } from '../../core/geom2d.js';
import { addMeasure } from '../../core/ops.js';
import { snap } from '../../core/snapping.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

type P3 = { x: number; y: number; z: number };

export function measureText(a: P3, b: P3): string {
  const d3 = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const flat = Math.hypot(a.x - b.x, a.y - b.y);
  const rise = Math.abs(a.z - b.z);
  if (rise > 1 && flat > 1) return `${formatLength(d3, 8)}  (${formatLength(flat, 8)} across, ${formatLength(rise, 8)} up)`;
  return formatLength(d3, 8);
}

/** Tape measure between any two points on the floor or on walls. */
export class MeasureTool implements Tool {
  readonly name = 'Measure';
  private a: P3 | null = null;
  last: string | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {
    this.a = null;
  }
  deactivate(): void {
    this.a = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    return this.a ? 'Point at the second spot' : 'Tape measure: pick the first spot';
  }

  private point(aim: AimHit): { p: P3; kind: Parameters<ToolContext['preview']['showCursor']>[1] } | null {
    if (aim.wall && (!aim.floor || aim.wall.distM < aim.floorDistM - 0.02)) {
      return { p: { x: aim.wall.point.x, y: aim.wall.point.y, z: Math.round(aim.wall.z * 4) / 4 }, kind: 'edge' };
    }
    if (aim.surface && (!aim.floor || aim.surface.distM < aim.floorDistM - 0.05)) {
      return { p: { x: aim.surface.p.x, y: aim.surface.p.y, z: aim.surface.z }, kind: 'free' };
    }
    if (!aim.floor) return null;
    const from: Vec2 | undefined = this.a ? { x: this.a.x, y: this.a.y } : undefined;
    const s = snap(this.ctx.store.plan, aim.floor, { ...this.ctx.snapOptions(aim, from), grid: 0.25 });
    return { p: { x: s.point.x, y: s.point.y, z: 0 }, kind: s.kind };
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim) return;
    const pt = this.point(aim);
    if (!pt) return;
    pv.showCursorAt(pt.p, pt.kind, aim.fine);
    if (this.a) pv.showMeasureLine(this.a, pt.p, measureText(this.a, pt.p));
  }

  commit(aim: AimHit): void {
    const pt = this.point(aim);
    if (!pt) return;
    if (!this.a) {
      this.a = pt.p;
      this.ctx.refreshUi();
      return;
    }
    const a = this.a;
    this.a = null;
    if (Math.hypot(a.x - pt.p.x, a.y - pt.p.y, a.z - pt.p.z) < 0.25) return;
    this.ctx.store.edit('Measure', (d) => addMeasure(d, a, pt.p));
    this.last = measureText(a, pt.p);
    this.ctx.toast(this.last);
    this.ctx.refreshUi();
  }

  undo(): boolean {
    if (!this.a) return false;
    this.a = null;
    return true;
  }
}
