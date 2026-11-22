import { planToWorld, solveTwoPoint, worldToPlan, type PlanTransform } from '../../core/alignment.js';
import { formatLength } from '../../core/units.js';
import type { Vec2 } from '../../core/geom2d.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

export interface AlignHost {
  getTransform(): PlanTransform;
  setTransform(t: PlanTransform): void;
  /** Lock the reference corners to the room with persistent anchors. */
  anchorReferences(): void;
}

/**
 * Two-point alignment.
 * First time: the two clicked floor corners are saved as Ref 1 / Ref 2.
 * Later: clicking the same two corners (same order) moves the plan back into place.
 */
export class AlignTool implements Tool {
  readonly name = 'Align';
  private picks: Array<{ x: number; z: number }> = [];
  private pickedPlan: Vec2[] = [];

  constructor(
    private ctx: ToolContext,
    private host: AlignHost,
  ) {}

  activate(): void {
    this.picks = [];
    this.pickedPlan = [];
    this.ctx.preview.setMarkers([]);
  }

  deactivate(): void {
    this.picks = [];
    this.pickedPlan = [];
    this.ctx.preview.setMarkers([]);
  }

  get settingReference(): boolean {
    return !this.ctx.store.plan.reference;
  }

  hint(): string {
    const n = this.picks.length + 1;
    return this.settingReference
      ? `Set Ref ${n}: point at a real floor corner (hold for fine)`
      : `Align: point at the real Ref ${n} corner`;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim?.floor) return;
    pv.showCursor(aim.floor, 'free', aim.fine);
    pv.showHint(this.settingReference ? `Ref ${this.picks.length + 1}` : `Real Ref ${this.picks.length + 1}?`, aim.floor, 8);
  }

  commit(aim: AimHit): void {
    if (!aim.floor) return;
    const T = this.host.getTransform();
    this.picks.push(planToWorld(T, aim.floor));
    this.pickedPlan.push(aim.floor);
    this.ctx.preview.setMarkers(this.pickedPlan);
    if (this.picks.length < 2) {
      this.ctx.refreshUi();
      return;
    }
    const [w1, w2] = this.picks;
    const ref = this.ctx.store.plan.reference;
    if (!ref) {
      const r1 = worldToPlan(T, w1);
      const r2 = worldToPlan(T, w2);
      if (Math.hypot(r1.x - r2.x, r1.y - r2.y) < 12) {
        this.ctx.toast('Pick corners at least a foot apart. Try again.');
      } else {
        this.ctx.act('reference.set', { reference: { r1, r2 } });
        this.host.anchorReferences();
        this.ctx.toast('Reference corners saved and anchored. The plan will relock itself next time.', 6);
      }
    } else {
      const sol = solveTwoPoint(ref.r1, ref.r2, w1, w2);
      if (!sol) {
        this.ctx.toast('Those clicks were too close together. Try again.');
      } else {
        this.host.setTransform(sol.transform);
        this.host.anchorReferences();
        const err = Math.abs(sol.spanError);
        const quality = err <= 0.5 ? 'great' : err <= 1.5 ? 'ok' : 'check the corners';
        this.ctx.toast(`Aligned (${quality}). Corner spacing off by ${formatLength(err, 8)}.`, 6);
      }
    }
    this.picks = [];
    this.pickedPlan = [];
    this.ctx.preview.setMarkers([]);
    this.ctx.refreshUi();
  }

  undo(): boolean {
    if (!this.picks.length) return false;
    this.picks.pop();
    this.pickedPlan.pop();
    this.ctx.preview.setMarkers(this.pickedPlan);
    this.ctx.refreshUi();
    return true;
  }
}
