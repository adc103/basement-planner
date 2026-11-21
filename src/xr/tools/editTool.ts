import { dist, type Vec2 } from '../../core/geom2d.js';
import {
  deleteMarker,
  deleteOpening,
  deleteWall,
  locateOnWall,
  moveMarker,
  moveNode,
  moveOpening,
  setWallHeight,
  setWallLength,
  setWallThickness,
  wallById,
  wallLength,
} from '../../core/ops.js';
import type { Wall } from '../../core/plan.js';
import { snap } from '../../core/snapping.js';
import { formatLength } from '../../core/units.js';
import { widthText } from '../planView.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string; wallId: string }
  | { kind: 'marker'; id: string };

interface Drag {
  target: Target;
  start: Vec2;
  moved: boolean;
}

/**
 * Select & drag: grab a corner to move it (with snapping), slide a door along its
 * wall, move a utility pin, or tap a wall to select it and edit it from the menu.
 */
export class EditTool implements Tool {
  readonly name = 'Edit';
  selection: Target | null = null;
  private hovered: Target | null = null;
  private dragging: Drag | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {}

  deactivate(): void {
    this.endDrag();
    this.selection = null;
    this.ctx.view.setHighlight(null);
    this.ctx.view.setSelected(null);
  }

  inputMode(): 'place' | 'drag' {
    return 'drag';
  }

  hint(): string {
    if (this.dragging?.moved) return 'Release to drop';
    const h = this.hovered;
    if (h?.kind === 'node') return 'Pinch and drag to move this corner';
    if (h?.kind === 'opening') return 'Drag to slide, tap to select';
    if (h?.kind === 'marker') return 'Drag to move this pin';
    if (h?.kind === 'wall') return 'Tap to select this wall';
    return this.selection ? 'Edit the selection in the menu' : 'Point at a corner, wall, door or pin';
  }

  /** What is under the aim, in priority order. */
  private pick(aim: AimHit): Target | null {
    const plan = this.ctx.store.plan;
    if (aim.floor) {
      const tol = Math.max(4, this.ctx.snapOptions(aim).tolerance * 1.5);
      let best: Target | null = null;
      let bestD = tol;
      for (const n of plan.nodes) {
        const d = Math.hypot(n.x - aim.floor.x, n.y - aim.floor.y);
        if (d < bestD) {
          bestD = d;
          best = { kind: 'node', id: n.id };
        }
      }
      if (best) return best;
    }
    if (aim.marker && (!aim.wall || aim.marker.distM <= aim.wall.distM + 0.05)) return { kind: 'marker', id: aim.marker.id };
    if (aim.wall) {
      const wall = wallById(plan, aim.wall.wallId);
      if (wall) {
        const loc = locateOnWall(plan, wall, aim.wall.point);
        const op = plan.openings.find(
          (o) => o.wallId === wall.id && Math.abs(o.offset - loc.along) <= o.width / 2 && aim.wall!.z <= o.sill + o.height,
        );
        if (op) return { kind: 'opening', id: op.id, wallId: wall.id };
        return { kind: 'wall', id: wall.id };
      }
    }
    return null;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    if (this.dragging) return; // drag() draws while pressed
    pv.clear();
    this.hovered = aim ? this.pick(aim) : null;
    const h = this.hovered;
    const plan = this.ctx.store.plan;
    this.ctx.view.setHighlight(h && h.kind !== 'node' && h.kind !== 'marker' ? (h.kind === 'opening' ? h.wallId : h.id) : null, 'hover');
    if (h?.kind === 'node') {
      const n = plan.nodes.find((x) => x.id === h.id);
      if (n) pv.showCursor({ x: n.x, y: n.y }, 'endpoint', false);
    } else if (aim?.floor && !h) {
      pv.showCursor(aim.floor, 'free', false);
    }
  }

  pressStart(aim: AimHit): void {
    const t = this.pick(aim);
    this.hovered = t;
    if (!t || t.kind === 'wall') return;
    const start = aim.floor ?? aim.wall?.point ?? { x: 0, y: 0 };
    this.dragging = { target: t, start, moved: false };
    this.ctx.store.begin(t.kind === 'node' ? 'Move corner' : t.kind === 'opening' ? 'Move door' : 'Move pin');
  }

  drag(aim: AimHit): void {
    const d = this.dragging;
    if (!d) return;
    const pv = this.ctx.preview;
    const plan = this.ctx.store.plan;
    pv.clear();
    pv.beginGuides();
    if (d.target.kind === 'node') {
      const id = d.target.id;
      if (aim.floor) {
        if (!d.moved && dist(aim.floor, d.start) < 1) {
          pv.endGuides();
          return;
        }
        d.moved = true;
        const s = snap(plan, aim.floor, { ...this.ctx.snapOptions(aim), excludeNodeId: id });
        this.ctx.acquire(s.kind === 'endpoint' || s.kind === 'midpoint' ? s.point : null);
        this.ctx.store.edit('Move corner', (dr) => moveNode(dr, id, s.point));
        pv.showCursor(s.point, s.kind, false);
        pv.showGuides(s.guides, s.point);
      }
    } else if (d.target.kind === 'opening') {
      const op = plan.openings.find((o) => o.id === (d.target as { id: string }).id);
      const wall = op && wallById(plan, op.wallId);
      const p = aim.wall?.wallId === op?.wallId ? aim.wall!.point : aim.floor;
      if (op && wall && p) {
        const loc = locateOnWall(plan, wall, p);
        if (d.moved || Math.abs(loc.along - op.offset) > 1) {
          d.moved = true;
          const off = Math.round(loc.along * 2) / 2;
          this.ctx.store.edit('Move door', (dr) => moveOpening(dr, op.id, off));
          pv.showHint(`${formatLength(op.offset - op.width / 2)} from corner`, p, op.height + 6);
        }
      }
    } else if (d.target.kind === 'marker') {
      const id = d.target.id;
      const m = plan.markers.find((x) => x.id === id);
      if (m) {
        let next: { x: number; y: number; z: number } | null = null;
        let wallId: string | null = null;
        if (m.wallId && aim.wall) {
          next = { x: aim.wall.point.x, y: aim.wall.point.y, z: Math.round(aim.wall.z) };
          wallId = aim.wall.wallId;
        } else if (!m.wallId && aim.floor) {
          next = { x: aim.floor.x, y: aim.floor.y, z: m.z };
        }
        if (next && (d.moved || dist(next, m) > 1)) {
          d.moved = true;
          this.ctx.store.edit('Move pin', (dr) => moveMarker(dr, id, next!, wallId));
        }
      }
    }
    pv.endGuides();
  }

  commit(aim: AimHit): void {
    const d = this.dragging;
    this.endDrag();
    if (d?.moved) {
      this.ctx.refreshUi();
      return;
    }
    const t = d?.target ?? this.pick(aim);
    this.select(t && t.kind !== 'node' ? t : null);
  }

  private endDrag(): void {
    if (this.dragging) this.ctx.store.end();
    this.dragging = null;
  }

  select(t: Target | null): void {
    this.selection = t;
    const wallId = t?.kind === 'wall' ? t.id : t?.kind === 'opening' ? t.wallId : null;
    this.ctx.view.setSelected(wallId);
    this.ctx.refreshUi();
  }

  /** Drop the selection if its object is gone (after undo/delete). */
  validate(): void {
    const s = this.selection;
    if (!s) return;
    const plan = this.ctx.store.plan;
    const exists =
      s.kind === 'wall'
        ? !!wallById(plan, s.id)
        : s.kind === 'opening'
          ? plan.openings.some((o) => o.id === s.id)
          : s.kind === 'marker'
            ? plan.markers.some((m) => m.id === s.id)
            : false;
    if (!exists) this.select(null);
    else if (s.kind === 'wall' || s.kind === 'opening') this.ctx.view.setSelected(s.kind === 'wall' ? s.id : s.wallId);
  }

  // --- Actions for the menu -----------------------------------------------------

  selectedWall(): Wall | undefined {
    const s = this.selection;
    return s?.kind === 'wall' ? wallById(this.ctx.store.plan, s.id) : undefined;
  }

  describe(): string {
    const s = this.selection;
    const plan = this.ctx.store.plan;
    if (!s) return '';
    if (s.kind === 'wall') {
      const w = wallById(plan, s.id);
      if (!w) return '';
      const kind = w.kind === 'existing' ? (w.source === 'capture' ? 'Captured wall' : 'Scanned wall') : 'Wall';
      return `${kind}: ${formatLength(wallLength(plan, w))} long, ${formatLength(w.height)} high, ${w.framing.studSize}`;
    }
    if (s.kind === 'opening') {
      const o = plan.openings.find((x) => x.id === s.id);
      return o ? `${o.type === 'door' ? 'Door' : 'Opening'}: ${widthText(o.width)} x ${formatLength(o.height)}` : '';
    }
    if (s.kind === 'marker') {
      const m = plan.markers.find((x) => x.id === s.id);
      return m ? `Pin: ${m.type.replace('-', ' ')} at ${formatLength(m.z)}` : '';
    }
    return '';
  }

  typeLength(): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.openKeypad('Wall length', wallLength(this.ctx.store.plan, w), (inches) => {
      this.ctx.store.edit('Set length', (d) => setWallLength(d, w.id, inches, 'a'));
      this.ctx.toast(`Wall set to ${formatLength(inches)}`);
    });
  }

  typeHeight(): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.openKeypad('Wall height', w.height, (inches) => {
      this.ctx.store.edit('Set height', (d) => setWallHeight(d, w.id, inches));
      this.ctx.refreshUi();
    });
  }

  setStud(size: '2x4' | '2x6'): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.store.edit(`Make ${size}`, (d) => setWallThickness(d, w.id, size === '2x6' ? 6.5 : 4.5));
  }

  typeWidth(): void {
    const s = this.selection;
    if (s?.kind !== 'opening') return;
    const o = this.ctx.store.plan.openings.find((x) => x.id === s.id);
    if (!o) return;
    this.ctx.openKeypad('Opening width', o.width, (w) => {
      const ok = this.ctx.store.edit('Set width', (d) => {
        const op = d.openings.find((x) => x.id === s.id);
        if (!op) return false;
        const old = op.width;
        op.width = w;
        if (!moveOpening(d, op.id, op.offset)) {
          op.width = old;
          return false;
        }
        return true;
      });
      if (!ok) this.ctx.toast("That width doesn't fit there");
    });
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    this.ctx.store.edit('Delete', (d) => {
      if (s.kind === 'wall') deleteWall(d, s.id);
      else if (s.kind === 'opening') deleteOpening(d, s.id);
      else if (s.kind === 'marker') deleteMarker(d, s.id);
    });
    this.select(null);
    this.ctx.toast('Deleted. Undo brings it back.');
  }
}
