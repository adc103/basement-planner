import type { Vec2 } from '../../core/geom2d.js';
import { formatLength } from '../../core/units.js';
import { SoffitTool } from './soffitTool.js';
import type { AimHit, ToolContext } from './tool.js';

export interface BoxPreset {
  label: string;
  height: number;
}

export const BOX_PRESETS: BoxPreset[] = [
  { label: 'Bench', height: 18 },
  { label: 'Desk', height: 30 },
  { label: 'Counter', height: 36 },
  { label: 'Tall cabinet', height: 84 },
];

/**
 * Box: drag a rectangle on the floor (squared to the room) and it stands up as
 * a bench, desk, counter or cabinet run at the chosen height. Push/pull its
 * faces with Select to size it.
 */
export class BoxTool extends SoffitTool {
  override readonly name = 'Box';

  constructor(
    ctx: ToolContext,
    axisAngle: () => number,
    private preset: () => BoxPreset,
  ) {
    super(ctx, axisAngle);
  }

  override hint(): string {
    return `${this.preset().label} (${formatLength(this.preset().height)}): pinch a floor corner and drag`;
  }

  override hover(aim: AimHit | null): void {
    const pv = this.c.preview;
    pv.clear();
    const p = aim ? this.pointOf(aim) : null;
    if (p) pv.showCursor(p, 'grid', false);
  }

  protected override finish(r: Vec2[], w: number, h: number): void {
    const pr = this.preset();
    if (!this.c.act('box.add', { poly: r, z1: pr.height, label: pr.label })) return;
    this.c.toast(`${pr.label} ${formatLength(Math.round(w * 8) / 8)} x ${formatLength(Math.round(h * 8) / 8)}, ${formatLength(pr.height)} tall. Select it to push/pull its faces.`, 5);
  }

  protected override tapped(_p: Vec2): void {
    this.c.toast('Drag from corner to corner to make a box', 3);
  }
}

