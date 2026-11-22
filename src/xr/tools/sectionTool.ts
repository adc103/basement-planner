import { dist, type Vec2 } from '../../core/geom2d.js';
import { snap } from '../../core/snapping.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

export interface SectionCut {
  a: Vec2;
  b: Vec2;
  /** Which side of a->b stays: +1 = left of a->b, -1 = right. */
  keep: 1 | -1;
}

/**
 * Section: point at two floor spots to slice the plan along that line. The
 * half on your side is hidden, so you see into walls, framing and soffits
 * where the cut passes through them.
 */
export class SectionTool implements Tool {
  readonly name = 'Section';
  private first: Vec2 | null = null;

  constructor(
    private ctx: ToolContext,
    private host: { get(): SectionCut | null; set(cut: SectionCut | null): void },
  ) {}

  activate(): void {
    this.first = null;
  }
  deactivate(): void {
    this.first = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    return this.first ? 'Section: point at the second floor spot of the cut line' : this.host.get() ? 'Section set. Point at the floor to draw a new cut line' : 'Section: point at the floor where the cut line starts';
  }

  private point(aim: AimHit): Vec2 | null {
    if (!aim.floor) return null;
    return snap(this.ctx.store.plan, aim.floor, this.ctx.snapOptions(aim, this.first ?? undefined)).point;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const p = aim ? this.point(aim) : null;
    if (!p) return;
    pv.showCursor(p, 'free', false);
    if (this.first) {
      pv.beginGuides();
      pv.addDashedLine(this.first, p, 0xff5a5a);
      pv.endGuides();
      pv.showHint(`Cut line ${formatLength(Math.round(dist(this.first, p)))}`, p, 20);
    }
  }

  commit(aim: AimHit): void {
    const p = this.point(aim);
    if (!p) return;
    if (!this.first) {
      this.first = p;
      return;
    }
    const a = this.first;
    this.first = null;
    if (dist(a, p) < 6) {
      this.ctx.toast('Make the cut line at least 6" long');
      return;
    }
    // Hide the half you're standing in, so you look at the cut.
    const n = { x: -(p.y - a.y), y: p.x - a.x };
    const eyeSide = (aim.eye.x - a.x) * n.x + (aim.eye.y - a.y) * n.y;
    this.host.set({ a, b: p, keep: eyeSide > 0 ? -1 : 1 });
    this.ctx.toast('Section set. Flip shows the other side; Clear removes it.', 4);
    this.ctx.refreshUi();
  }
}
