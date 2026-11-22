import { captureWall } from '../../core/capture.js';
import { dist, type Vec2 } from '../../core/geom2d.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

type Surface = NonNullable<AimHit['surface']>;

/**
 * Trace a real wall: point at the wall near one end and tap, then near the
 * other end and tap. The wall runs between the two taps; the room mesh (when
 * scanned) then sets its exact position and thickness.
 */
export class TraceTool implements Tool {
  readonly name = 'Real wall';
  private first: { p: Vec2; z: number; n: Vec2 } | null = null;

  constructor(
    private ctx: ToolContext,
    /** Move a just-traced wall onto the room mesh; returns a short note for the toast. */
    private snap: (wallId: string) => string,
  ) {}

  activate(): void {
    this.first = null;
  }

  deactivate(): void {
    this.first = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    return this.first ? 'First end set. Tap the same wall near its other end (B to cancel)' : 'Point at a real wall near one end and tap';
  }

  undo(): boolean {
    if (!this.first) return false;
    this.first = null;
    this.ctx.preview.clear();
    this.ctx.refreshUi();
    return true;
  }

  /** The real surface under the ray, or the floor (for a tap at the base of a wall). */
  private point(aim: AimHit): { p: Vec2; z: number; n: Vec2 } | null {
    const s: Surface | null = aim.surface;
    if (s) return { p: s.p, z: s.z, n: s.n };
    return aim.floor ? { p: aim.floor, z: 0, n: { x: 0, y: 0 } } : null;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const f = this.first;
    if (f) pv.showCursorAt({ x: f.p.x, y: f.p.y, z: f.z }, 'endpoint', false, f.n);
    if (!aim) return;
    const q = this.point(aim);
    if (!q) return;
    if (aim.surface) pv.showSurfaceCursor({ x: q.p.x, y: q.p.y, z: q.z }, q.n);
    if (!f) return;
    const st = this.ctx.store.plan.settings;
    const label = formatLength(Math.round(dist(f.p, q.p)));
    pv.showMeasureLine({ x: f.p.x, y: f.p.y, z: f.z }, { x: q.p.x, y: q.p.y, z: f.z }, label);
    const w = captureWall(f.p, q.p, aim.eye, st.captureThickness);
    if (w) pv.showRubberWall(w.a, w.b, st.captureThickness, st.wallHeight, label);
  }

  commit(aim: AimHit): void {
    const q = this.point(aim);
    if (!q) {
      this.ctx.toast('Point at a real wall', 3);
      return;
    }
    if (!this.first) {
      this.first = { p: { ...q.p }, z: q.z, n: { ...q.n } };
      this.ctx.toast('First end set. Now tap near the other end of the same wall', 3);
      this.ctx.refreshUi();
      return;
    }
    const st = this.ctx.store.plan.settings;
    const w = captureWall(this.first.p, q.p, aim.eye, st.captureThickness);
    if (!w) {
      this.ctx.toast('Tap two spots at least 6" apart along the wall', 3);
      return;
    }
    let note = 'Real wall added';
    this.ctx.cmd.group('Trace real wall', () => {
      const id = this.ctx.act('wall.add', { a: w.a, b: w.b, kind: 'existing', source: 'capture', thickness: st.captureThickness });
      if (id) note = this.snap(id);
    });
    this.first = null;
    this.ctx.preview.clear();
    this.ctx.toast(note, 4);
    this.ctx.refreshUi();
  }
}
