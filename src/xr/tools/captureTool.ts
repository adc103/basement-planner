import { dist, dot, norm, perp, sub, type Vec2 } from '../../core/geom2d.js';
import { captureWall } from '../../core/capture.js';
import { addWallBetween, findNodeNear } from '../../core/ops.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/**
 * Point-and-capture: point at a real wall near one end and pinch, then near the
 * other end. The headset's hit test finds the surface; the app adds it as an
 * existing wall that new walls can snap to.
 */
export class CaptureTool implements Tool {
  readonly name = 'Capture';
  private first: { p: Vec2; n: Vec2; z: number } | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {
    this.first = null;
  }
  deactivate(): void {
    this.first = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    return this.first ? 'Now point near the other end of that wall' : 'Point at a real wall the scan missed';
  }

  private usable(aim: AimHit): AimHit['surface'] {
    const s = aim.surface;
    if (!s) return null;
    return Math.hypot(s.n.x, s.n.y) > 0.7 ? s : null; // vertical-ish surfaces only
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim) return;
    const s = this.usable(aim);
    if (!s) {
      if (aim.floor) pv.showHint(aim.surface ? 'Not a wall: aim at a wall surface' : 'No surface found here', aim.floor, 20);
      return;
    }
    pv.showSurfaceCursor({ x: s.p.x, y: s.p.y, z: s.z }, s.n);
    if (this.first) {
      const d = perp(norm(this.first.n));
      const t = dot(sub(s.p, this.first.p), d);
      const end = { x: this.first.p.x + d.x * t, y: this.first.p.y + d.y * t };
      pv.showMeasureLine({ ...this.first.p, z: this.first.z }, { ...end, z: this.first.z }, formatLength(Math.abs(t), 8));
    }
  }

  commit(aim: AimHit): void {
    const s = this.usable(aim);
    if (!s) {
      this.ctx.toast(aim.surface ? 'Aim at a wall, not the floor or ceiling' : "Couldn't see a surface there. Get a bit closer.");
      return;
    }
    if (!this.first) {
      this.first = { p: s.p, n: s.n, z: s.z };
      this.ctx.refreshUi();
      return;
    }
    const st = this.ctx.store.plan.settings;
    const w = captureWall(this.first.p, this.first.n, s.p, s.n, st.captureThickness);
    this.first = null;
    if (!w) {
      this.ctx.toast('Those two points need to be on the same wall, at least 6" apart');
      return;
    }
    // Join to nearby corners so captured walls connect.
    const plan = this.ctx.store.plan;
    const snapEnd = (p: Vec2) => {
      const n = findNodeNear(plan, p, 6);
      return n && dist(n, p) < 6 ? { x: n.x, y: n.y } : p;
    };
    const id = this.ctx.store.edit('Capture wall', (d) =>
      addWallBetween(d, snapEnd(w.a), snapEnd(w.b), {
        height: st.wallHeight,
        thickness: st.captureThickness,
        kind: 'existing',
        source: 'capture',
      }),
    );
    this.ctx.toast(id ? `Captured a ${formatLength(dist(w.a, w.b))} wall` : 'That wall is already there');
    this.ctx.refreshUi();
  }

  undo(): boolean {
    if (!this.first) return false;
    this.first = null;
    return true;
  }
}
