import { captureWall } from '../../core/capture.js';
import { dist, type Vec2 } from '../../core/geom2d.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

type Surface = NonNullable<AimHit['surface']>;

/**
 * Trace a real wall: point at the wall near one end and tap, then near the
 * other end and tap. You decide what is a wall; the headset's hit test gives
 * the surface, and the room mesh (when scanned) sets its exact position and
 * thickness.
 */
export class TraceTool implements Tool {
  readonly name = 'Real wall';
  private first: { p: Vec2; n: Vec2; z: number } | null = null;

  constructor(
    private ctx: ToolContext,
    /** Move a just-traced wall onto the room mesh; returns a short note for the toast, or null. */
    private snap: (wallId: string) => string | null,
  ) {}

  activate(): void {
    this.first = null;
  }

  deactivate(): void {
    this.first = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    return this.first ? 'Now tap the same wall near its other end' : 'Point at a real wall near one end and tap';
  }

  undo(): boolean {
    if (!this.first) return false;
    this.first = null;
    this.ctx.preview.clear();
    return true;
  }

  /** Vertical surfaces only (the hit-test normal is smoothed). */
  private wallHit(aim: AimHit): Surface | null {
    const s = aim.surface;
    return s && Math.hypot(s.n.x, s.n.y) > 0.5 ? s : null;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim) return;
    const s = this.wallHit(aim);
    if (!s) {
      if (aim.floor) pv.showHint('Point at a real wall', aim.floor, 20);
      return;
    }
    pv.showSurfaceCursor({ x: s.p.x, y: s.p.y, z: s.z }, s.n);
    if (this.first) {
      const st = this.ctx.store.plan.settings;
      const w = captureWall(this.first.p, this.first.n, s.p, s.n, st.captureThickness);
      if (w) pv.showRubberWall(w.a, w.b, st.captureThickness, st.wallHeight, formatLength(Math.round(dist(w.faceA, w.faceB))));
    }
  }

  commit(aim: AimHit): void {
    const s = this.wallHit(aim);
    if (!s) {
      this.ctx.toast(aim.surface ? 'That looks like the floor or ceiling: aim at the wall itself' : 'Point at a real wall', 3);
      return;
    }
    if (!this.first) {
      this.first = { p: { ...s.p }, n: { ...s.n }, z: s.z };
      this.ctx.refreshUi();
      return;
    }
    const st = this.ctx.store.plan.settings;
    const w = captureWall(this.first.p, this.first.n, s.p, s.n, st.captureThickness);
    if (!w) {
      this.ctx.toast('Tap two spots on the same wall, at least 6" apart', 3);
      return;
    }
    let note: string | null = null;
    this.ctx.cmd.group('Trace real wall', () => {
      const id = this.ctx.act('wall.add', { a: w.a, b: w.b, kind: 'existing', source: 'capture', thickness: st.captureThickness });
      if (id) note = this.snap(id);
    });
    this.first = null;
    this.ctx.preview.clear();
    this.ctx.toast(note ?? 'Real wall added', 4);
    this.ctx.refreshUi();
  }
}
