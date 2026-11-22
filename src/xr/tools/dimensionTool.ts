import { wallById, wallEnds } from '../../core/ops.js';
import { wallGap } from '../../core/solver.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/**
 * Dimension: point at one wall, then another. Parallel walls show their gap,
 * which you can type and keep; walls at an angle can be made square or
 * parallel. Every lock re-solves as you keep editing.
 */
export class DimensionTool implements Tool {
  readonly name = 'Dimension';
  a: string | null = null;
  b: string | null = null;
  /** Distance mode for typing and keeping: face to face or centerlines. */
  mode: 'clear' | 'center' = 'clear';
  private hovered: string | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {
    this.reset();
  }
  deactivate(): void {
    this.ctx.view.setHighlight(null);
    this.ctx.view.setSelected(null);
    this.ctx.preview.clear();
  }

  reset(): void {
    this.a = this.b = null;
    this.ctx.view.setSelected(null);
    this.ctx.refreshUi();
  }

  /** Drop picks whose walls are gone (undo, delete). */
  validate(): void {
    const plan = this.ctx.store.plan;
    if (this.a && !wallById(plan, this.a)) this.a = null;
    if (this.b && !wallById(plan, this.b)) this.b = null;
  }

  hint(): string {
    if (!this.a) return 'Dimension: point at the first wall';
    if (!this.b) return 'Now point at the second wall';
    return this.describe();
  }

  /** The two picked walls' relationship, in words. */
  describe(): string {
    const g = this.gap();
    if (!g) return this.a ? 'Point at the second wall' : 'Point at the first wall';
    if (g.parallel) {
      const kept = this.lock('distance');
      return `${formatLength(round(g.clear))} clear, ${formatLength(round(g.center))} center to center${kept ? ` (keeping ${formatLength(kept.value ?? 0)} ${kept.mode})` : ''}`;
    }
    const deg = (g.angle * 180) / Math.PI;
    return `Walls at ${deg.toFixed(1)}°${this.lock('perpendicular') ? ' (kept square)' : this.lock('parallel') ? ' (kept parallel)' : ''}`;
  }

  gap(): { clear: number; center: number; angle: number; parallel: boolean } | null {
    if (!this.a || !this.b) return null;
    const g = wallGap(this.ctx.store.plan, this.a, this.b);
    return g ? { ...g, parallel: g.angle < (2 * Math.PI) / 180 } : null;
  }

  /** The lock of this type between the two picks, if any. */
  lock(type: 'distance' | 'parallel' | 'perpendicular' | 'collinear') {
    const { a, b } = this;
    return this.ctx.store.plan.constraints.find((c) => c.type === type && ((c.a === a && c.b === b) || (c.a === b && c.b === a))) ?? null;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    this.hovered = aim?.wall?.wallId ?? null;
    this.ctx.view.setHighlight(this.hovered, 'hover');
    const plan = this.ctx.store.plan;
    // Live: the gap between the first wall and the one under the ray.
    const other = this.b ?? (this.a && this.hovered !== this.a ? this.hovered : null);
    if (this.a && other) {
      const g = wallGap(plan, this.a, other);
      const A = wallById(plan, this.a);
      const B = wallById(plan, other);
      if (g && A && B && g.angle < 0.035) {
        const ea = wallEnds(plan, A);
        const eb = wallEnds(plan, B);
        const L = Math.hypot(ea.b.x - ea.a.x, ea.b.y - ea.a.y) || 1;
        const d = { x: (ea.b.x - ea.a.x) / L, y: (ea.b.y - ea.a.y) / L };
        const n = { x: -d.y, y: d.x };
        const mid = { x: (eb.a.x + eb.b.x) / 2, y: (eb.a.y + eb.b.y) / 2 };
        const t = Math.max(0, Math.min(L, (mid.x - ea.a.x) * d.x + (mid.y - ea.a.y) * d.y));
        const s = (mid.x - ea.a.x) * n.x + (mid.y - ea.a.y) * n.y;
        const sg = s >= 0 ? 1 : -1;
        const base = { x: ea.a.x + d.x * t, y: ea.a.y + d.y * t };
        const p0 = { x: base.x + n.x * sg * (A.thickness / 2), y: base.y + n.y * sg * (A.thickness / 2), z: 40 };
        const p1 = { x: base.x + n.x * sg * (Math.abs(s) - B.thickness / 2), y: base.y + n.y * sg * (Math.abs(s) - B.thickness / 2), z: 40 };
        pv.showMeasureLine(p0, p1, `${formatLength(round(g.clear))} clear`);
      }
    }
  }

  commit(aim: AimHit): void {
    const id = aim.wall?.wallId;
    if (!id) return;
    if (!this.a || (this.a && this.b)) {
      this.a = id;
      this.b = null;
    } else if (id !== this.a) {
      this.b = id;
    }
    this.ctx.view.setSelected(this.b ?? this.a);
    this.ctx.toast(this.hint(), 4);
    this.ctx.refreshUi();
  }

  /** Type the distance; wall 2 moves, wall 1 stays. */
  typeDistance(): void {
    const g = this.gap();
    if (!g || !g.parallel) return;
    const cur = this.mode === 'clear' ? g.clear : g.center;
    this.ctx.openKeypad(this.mode === 'clear' ? 'Clear distance' : 'Center to center', round(cur), (inches) => {
      if (this.ctx.act('dimension.set', { a: this.a!, b: this.b!, distance: inches, mode: this.mode })) this.ctx.toast(this.describe(), 4);
    });
  }

  toggleKeep(): void {
    const g = this.gap();
    if (!g) return;
    const k = this.lock('distance');
    if (k) {
      this.ctx.act('constraint.delete', { id: k.id });
      this.ctx.toast('Distance no longer kept');
    } else if (g.parallel) {
      const value = round(this.mode === 'clear' ? g.clear : g.center);
      if (this.ctx.act('constraint.add', { type: 'distance', a: this.a!, b: this.b!, value, mode: this.mode })) this.ctx.toast(`Keeping ${formatLength(value)} ${this.mode === 'clear' ? 'clear' : 'center to center'}`);
    }
  }

  /** Make (and keep) the two walls square or parallel. */
  toggleAngle(type: 'perpendicular' | 'parallel'): void {
    const k = this.lock(type);
    if (k) {
      this.ctx.act('constraint.delete', { id: k.id });
      this.ctx.toast(type === 'perpendicular' ? 'No longer kept square' : 'No longer kept parallel');
      return;
    }
    if (this.a && this.b && this.ctx.act('constraint.add', { type, a: this.a, b: this.b })) this.ctx.toast(type === 'perpendicular' ? 'Square, and kept square' : 'Parallel, and kept parallel');
  }

  toggleMode(): void {
    this.mode = this.mode === 'clear' ? 'center' : 'clear';
    this.ctx.refreshUi();
  }
}

const round = (v: number) => Math.round(v * 8) / 8;
