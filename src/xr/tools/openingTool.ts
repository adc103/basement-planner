import { add, norm, scale, sub, type Vec2 } from '../../core/geom2d.js';
import { clampOpeningOffset, locateOnWall, openingOverlaps, wallById, wallEnds } from '../../core/ops.js';
import type { Plan, Wall } from '../../core/plan.js';
import { formatLength } from '../../core/units.js';
import { widthText } from '../planView.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

interface Placement {
  wall: Wall;
  offset: number;
  ok: boolean;
  center: Vec2;
  dir: Vec2;
}

/** Point at a wall to place a door or plain opening. */
export class OpeningTool implements Tool {
  readonly name = 'Doors';
  private last: Placement | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {}
  deactivate(): void {
    this.ctx.view.setHighlight(null);
  }

  hint(): string {
    const p = this.ctx.openingPreset();
    return `${p.type === 'door' ? 'Door' : 'Opening'} ${widthText(p.width)}: point at a wall`;
  }

  /** Find the wall and center offset under the aim. */
  place(plan: Plan, aim: AimHit): Placement | null {
    const preset = this.ctx.openingPreset();
    let wall: Wall | undefined;
    let point: Vec2 | null = null;
    if (aim.wall) {
      wall = wallById(plan, aim.wall.wallId);
      point = aim.wall.point;
    }
    if (!wall && aim.floor) {
      // Fall back to the nearest wall within 18" of the floor point.
      let best = 18;
      wall = undefined;
      for (const w of plan.walls) {
        const loc = locateOnWall(plan, w, aim.floor);
        if (loc.along < 0 || loc.along > loc.length) continue;
        if (Math.abs(loc.across) < best) {
          best = Math.abs(loc.across);
          wall = w;
          point = aim.floor;
        }
      }
    }
    if (!wall || !point) return null;
    const loc = locateOnWall(plan, wall, point);
    let offset = Math.round(loc.along);
    if (Math.abs(offset - loc.length / 2) < 2) offset = loc.length / 2; // snap to center
    const clamped = clampOpeningOffset(loc.length, preset.width, offset);
    const ok = clamped !== null && !openingOverlaps(plan, wall.id, clamped, preset.width);
    const useOffset = clamped ?? loc.length / 2;
    const { a, b } = wallEnds(plan, wall);
    const dir = norm(sub(b, a));
    return { wall, offset: useOffset, ok, center: add(a, scale(dir, useOffset)), dir };
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    this.last = null;
    if (!aim) {
      this.ctx.view.setHighlight(null);
      return;
    }
    const plan = this.ctx.store.plan;
    const pl = this.place(plan, aim);
    this.last = pl;
    if (!pl) {
      this.ctx.view.setHighlight(null);
      if (aim.floor) pv.showCursor(aim.floor, 'free', aim.fine);
      return;
    }
    const preset = this.ctx.openingPreset();
    const h = Math.min(preset.height, pl.wall.height - 1);
    pv.showOpening(pl.center, pl.dir, preset.width, h, 0, pl.wall.thickness, pl.ok);
    const fromA = pl.offset - preset.width / 2;
    pv.showHint(`${formatLength(fromA)} from corner`, pl.center, h + 6);
  }

  commit(aim: AimHit): void {
    const pl = this.place(this.ctx.store.plan, aim) ?? this.last;
    if (!pl) {
      this.ctx.toast('Point at one of your new walls');
      return;
    }
    if (!pl.ok) {
      this.ctx.toast("Doesn't fit there");
      return;
    }
    const preset = this.ctx.openingPreset();
    const id = this.ctx.act('opening.add', {
      wallId: pl.wall.id,
      type: preset.type,
      offset: pl.offset,
      width: preset.width,
      height: preset.height,
    });
    this.ctx.toast(id ? `${preset.type === 'door' ? 'Door' : 'Opening'} added` : "Doesn't fit there");
  }
}
