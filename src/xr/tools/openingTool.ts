import { add, norm, scale, sub, type Vec2 } from '../../core/geom2d.js';
import type { FoundOpening, OpeningWall } from '../../core/findOpening.js';
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
  /** Where along the wall and how high the aim crosses it. */
  along: number;
  z: number;
}

/** Real doors: the doorway under the aim, measured on the room mesh. */
export interface DoorMeasure {
  /** Measure real doorways (else place the chosen size). */
  active(): boolean;
  hasMesh(): boolean;
  find(wall: OpeningWall, at: number, atZ: number): Promise<FoundOpening | null>;
}

/** A measured doorway, and the aim it was measured for. */
interface Measured {
  wallId: string;
  along: number;
  z: number;
  found: FoundOpening | null;
}

/**
 * Point at a wall to place a door or plain opening. Measuring: point through a real
 * open doorway and it is added at its measured size and place.
 */
export class OpeningTool implements Tool {
  readonly name = 'Doors';
  private last: Placement | null = null;
  private measured: Measured | null = null;
  private inFlight = false;
  private busy = false;

  constructor(
    private ctx: ToolContext,
    private measure: DoorMeasure,
  ) {}

  activate(): void {
    this.measured = null;
  }
  deactivate(): void {
    this.ctx.view.setHighlight(null);
  }

  private measuring(): boolean {
    return this.measure.active() && this.measure.hasMesh();
  }

  hint(): string {
    if (this.measure.active()) return this.measure.hasMesh() ? 'Point through a real open doorway and tap' : 'Scan the room first to measure real doors';
    const p = this.ctx.openingPreset();
    return `${p.type === 'door' ? 'Door' : 'Opening'} ${widthText(p.width)}: point at a wall`;
  }

  /** Find the wall and center offset under the aim. */
  place(plan: Plan, aim: AimHit): Placement | null {
    const preset = this.ctx.openingPreset();
    let wall: Wall | undefined;
    let point: Vec2 | null = null;
    let z = 45;
    if (aim.wall) {
      wall = wallById(plan, aim.wall.wallId);
      point = aim.wall.point;
      z = aim.wall.z;
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
    return { wall, offset: useOffset, ok, center: add(a, scale(dir, useOffset)), dir, along: loc.along, z };
  }

  private wallGeom(w: Wall): OpeningWall {
    const { a, b } = wallEnds(this.ctx.store.plan, w);
    return { a, b, thickness: w.thickness, height: w.height };
  }

  /** One measurement in flight; ask again when the aim moved along the wall. */
  private request(pl: Placement): void {
    const m = this.measured;
    if (this.inFlight || (m && m.wallId === pl.wall.id && Math.abs(m.along - pl.along) < 3 && Math.abs(m.z - pl.z) < 6)) return;
    this.inFlight = true;
    const ask = { wallId: pl.wall.id, along: pl.along, z: pl.z };
    void this.measure.find(this.wallGeom(pl.wall), pl.along, pl.z).then((found) => {
      this.measured = { ...ask, found };
      this.inFlight = false;
    });
  }

  /** An opening already on the wall where the measured one is (to update, not duplicate). */
  private existingAt(wallId: string, f: FoundOpening) {
    return this.ctx.store.plan.openings.find((o) => o.wallId === wallId && Math.abs(o.offset - f.offset) < (o.width + f.width) / 2);
  }

  private label(f: FoundOpening): string {
    const what = f.type === 'window' ? 'Window' : 'Door';
    return `${what} ${formatLength(f.width)} × ${formatLength(f.height)}${f.headSeen ? '' : ' (top not seen)'}`;
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
      if (this.measuring() && aim.floor) pv.showHint('Trace the wall first (Real wall), then point at its doorway', aim.floor, 20);
      return;
    }
    if (this.measuring()) {
      this.request(pl);
      const m = this.measured;
      const f = m && m.wallId === pl.wall.id && Math.abs(m.along - pl.along) < 24 ? m.found : undefined;
      if (f) {
        const { a } = wallEnds(plan, pl.wall);
        const center = add(a, scale(pl.dir, f.offset));
        pv.showOpening(center, pl.dir, f.width, f.height, f.sill, pl.wall.thickness, true);
        const upd = this.existingAt(pl.wall.id, f) ? ': tap to correct it' : '';
        pv.showHint(`${this.label(f)}${upd}`, center, f.sill + f.height + 6);
      } else if (f === null) {
        pv.showHint('No open doorway found here: open the door, scan it, and point through it', pl.center, 50);
      }
      return;
    }
    const preset = this.ctx.openingPreset();
    const h = Math.min(preset.height, pl.wall.height - 1);
    pv.showOpening(pl.center, pl.dir, preset.width, h, 0, pl.wall.thickness, pl.ok);
    const fromA = pl.offset - preset.width / 2;
    pv.showHint(`${pl.wall.kind === 'existing' ? 'Cut here: ' : ''}${formatLength(fromA)} from corner`, pl.center, h + 6);
  }

  commit(aim: AimHit): void {
    const pl = this.place(this.ctx.store.plan, aim) ?? this.last;
    if (!pl) {
      this.ctx.toast(this.measuring() ? 'Point at the doorway in a wall you traced' : 'Point at one of your new walls');
      return;
    }
    if (this.measuring()) {
      if (this.busy) return;
      // Measure afresh at the tap, not from the preview.
      this.busy = true;
      void this.measure.find(this.wallGeom(pl.wall), pl.along, pl.z).then((f) => {
        this.busy = false;
        this.measured = { wallId: pl.wall.id, along: pl.along, z: pl.z, found: f };
        this.addMeasured(pl.wall, f);
      });
      return;
    }
    if (!pl.ok) {
      this.ctx.toast("Doesn't fit there");
      return;
    }
    const preset = this.ctx.openingPreset();
    // On a real wall a chosen size is a cut you plan (not one that's there): a virtual hole.
    const cut = pl.wall.kind === 'existing';
    const id = this.ctx.act('opening.add', {
      wallId: pl.wall.id,
      type: preset.type,
      offset: pl.offset,
      width: preset.width,
      height: preset.height,
      kind: 'new',
    });
    const what = preset.type === 'door' ? 'door' : 'opening';
    this.ctx.toast(id ? (cut ? `New ${what} cut into the real wall: you see through it` : `${what === 'door' ? 'Door' : 'Opening'} added`) : "Doesn't fit there", 3);
  }

  private addMeasured(wall: Wall, f: FoundOpening | null): void {
    if (!f) {
      this.ctx.toast('No open doorway found there. Open the door, scan the doorway, and point through it.', 4);
      return;
    }
    const old = this.existingAt(wall.id, f);
    const size = { offset: f.offset, width: f.width, height: f.height, sill: f.sill };
    let ok: unknown;
    if (old) {
      ok = this.ctx.cmd.group('Measure door', () => this.ctx.act('opening.update', { id: old.id, ...size, ...(old.type === 'window' || f.type === 'window' ? { type: f.type } : {}) }));
    } else {
      ok = this.ctx.cmd.group('Measure door', () => this.ctx.act('opening.add', { wallId: wall.id, type: f.type, kind: 'existing', ...size }));
    }
    if (ok === null) return; // act already said why
    this.ctx.toast(`${old ? 'Corrected' : 'Added'}: ${this.label(f)}${f.jambs < 2 ? '. One side not seen: check its width' : ''}`, 4);
    this.ctx.refreshUi();
  }
}
