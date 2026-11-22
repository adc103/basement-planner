import { dist, type Vec2 } from '../../core/geom2d.js';
import { findNodeNear } from '../../core/ops.js';
import { formatLength } from '../../core/units.js';
import { centerlineFromFace, detectWallFromMesh, faceFromSweep, type DetectedFace, type PP } from '../../core/wallDetect.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

export interface CaptureContext extends ToolContext {
  /** Room-mesh vertices near a point (plan inches), or null if the headset has no room mesh. */
  roomMeshPoints(center: Vec2, radius: number): PP[] | null;
}

/**
 * Capture real walls the room scan missed.
 * - Tap a wall: the room mesh is searched for that wall's full extent and offered
 *   as a proposal; tap it again (or Add in the menu) to keep it.
 * - Hold and sweep along a wall: the swept hits are fitted to a line and added.
 */
export class CaptureTool implements Tool {
  readonly name = 'Capture';
  private sweep: PP[] | null = null;
  private eye: Vec2 = { x: 0, y: 0 };
  proposal: { face: DetectedFace; a: Vec2; b: Vec2 } | null = null;

  constructor(private ctx: CaptureContext) {}

  activate(): void {
    this.sweep = null;
  }
  deactivate(): void {
    this.sweep = null;
    this.proposal = null;
    this.ctx.preview.clear();
  }

  inputMode(): 'place' | 'drag' {
    return 'drag';
  }

  hint(): string {
    if (this.sweep && this.sweep.length > 1) return 'Keep sweeping along the wall, then let go';
    if (this.proposal) return 'Tap that wall again to add it';
    return 'Tap a real wall, or hold and sweep along it';
  }

  private usable(aim: AimHit): AimHit['surface'] {
    const s = aim.surface;
    return s && Math.hypot(s.n.x, s.n.y) > 0.5 ? s : null; // vertical-ish surfaces only (normal is smoothed)
  }

  private showProposal(): void {
    const p = this.proposal;
    if (!p) return;
    const st = this.ctx.store.plan.settings;
    this.ctx.preview.showRubberWall(p.a, p.b, st.captureThickness, st.wallHeight, formatLength(dist(p.face.a, p.face.b), 8));
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    this.showProposal();
    if (!aim) return;
    this.eye = aim.eye;
    const s = this.usable(aim);
    if (s) pv.showSurfaceCursor({ x: s.p.x, y: s.p.y, z: s.z }, s.n);
    else if (aim.floor) pv.showHint(aim.surface ? 'Aim at a wall, not the floor' : 'Point at a real wall', aim.floor, 20);
  }

  pressStart(aim: AimHit): void {
    this.sweep = [];
    this.eye = aim.eye;
    this.addSample(aim);
  }

  private addSample(aim: AimHit): void {
    const s = this.usable(aim);
    if (!s || !this.sweep) return;
    const last = this.sweep.at(-1);
    if (!last || Math.hypot(last.x - s.p.x, last.y - s.p.y) > 0.75) this.sweep.push({ x: s.p.x, y: s.p.y, z: s.z });
  }

  private travel(): number {
    const sw = this.sweep;
    if (!sw || sw.length < 2) return 0;
    let m = 0;
    for (const p of sw) m = Math.max(m, Math.hypot(p.x - sw[0].x, p.y - sw[0].y));
    return m;
  }

  drag(aim: AimHit): void {
    this.addSample(aim);
    const pv = this.ctx.preview;
    pv.clear();
    const s = this.usable(aim);
    if (s) pv.showSurfaceCursor({ x: s.p.x, y: s.p.y, z: s.z }, s.n);
    if (this.travel() >= 6) {
      const f = faceFromSweep(this.sweep!, this.eye);
      if (f) {
        const z = this.sweep![0].z;
        pv.showMeasureLine({ ...f.a, z }, { ...f.b, z }, formatLength(dist(f.a, f.b), 8));
      }
    } else {
      this.showProposal();
    }
  }

  commit(aim: AimHit): void {
    const sweep = this.sweep;
    this.sweep = null;
    if (sweep && this.travel2(sweep) >= 12) {
      const f = faceFromSweep(sweep, aim.eye);
      if (f) this.add(f);
      else this.ctx.toast("Couldn't fit a wall to that sweep. Try a slower, straight pass.");
      return;
    }
    // A tap.
    const s = this.usable(aim);
    if (!s) {
      this.ctx.toast(aim.surface ? 'Aim at a wall, not the floor or ceiling' : "Couldn't see a surface there. Get a bit closer.");
      return;
    }
    if (this.proposal && this.onProposal(s.p)) {
      this.acceptProposal();
      return;
    }
    const pts = this.ctx.roomMeshPoints(s.p, 30 * 12);
    if (!pts) {
      this.proposal = null;
      this.ctx.toast('No room mesh on this headset. Hold the pinch and sweep along the wall instead.', 5);
      return;
    }
    const face = detectWallFromMesh(pts, { x: s.p.x, y: s.p.y, z: s.z }, aim.eye, {
      ceiling: this.ctx.store.plan.settings.wallHeight,
    });
    if (!face) {
      this.proposal = null;
      this.ctx.toast("Couldn't find that wall's edges. Hold the pinch and sweep along it instead.", 5);
      return;
    }
    const c = centerlineFromFace(face, this.ctx.store.plan.settings.captureThickness);
    this.proposal = { face, a: c.a, b: c.b };
    this.ctx.toast(`Found a ${formatLength(dist(face.a, face.b))} wall. Tap it again to add it.`, 4);
    this.ctx.refreshUi();
  }

  private travel2(sw: PP[]): number {
    let m = 0;
    for (const p of sw) m = Math.max(m, Math.hypot(p.x - sw[0].x, p.y - sw[0].y));
    return m;
  }

  private onProposal(p: Vec2): boolean {
    const f = this.proposal!.face;
    const len = dist(f.a, f.b);
    const dx = (f.b.x - f.a.x) / len;
    const dy = (f.b.y - f.a.y) / len;
    const t = (p.x - f.a.x) * dx + (p.y - f.a.y) * dy;
    const off = Math.abs(-(p.x - f.a.x) * dy + (p.y - f.a.y) * dx);
    return off < 8 && t > -12 && t < len + 12;
  }

  acceptProposal(): void {
    if (!this.proposal) return;
    const f = this.proposal.face;
    this.proposal = null;
    this.add(f);
  }

  cancelProposal(): void {
    this.proposal = null;
    this.ctx.preview.clear();
    this.ctx.refreshUi();
  }

  private add(face: DetectedFace): void {
    const st = this.ctx.store.plan.settings;
    const c = centerlineFromFace(face, st.captureThickness);
    // Join to nearby corners so captured walls connect.
    const plan = this.ctx.store.plan;
    const snapEnd = (p: Vec2) => {
      const n = findNodeNear(plan, p, 6);
      return n ? { x: n.x, y: n.y } : p;
    };
    const id = this.ctx.cmd.run('wall.add', { a: snapEnd(c.a), b: snapEnd(c.b), height: st.wallHeight, thickness: st.captureThickness, kind: 'existing', source: 'capture' });
    this.ctx.toast(id ? `Captured a ${formatLength(dist(face.a, face.b))} wall` : 'That wall is already there');
    this.ctx.refreshUi();
  }

  undo(): boolean {
    if (!this.proposal) return false;
    this.cancelProposal();
    return true;
  }
}
