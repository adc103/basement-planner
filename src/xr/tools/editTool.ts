import { dist, type Vec2 } from '../../core/geom2d.js';
import { locateOnWall, wallEnds, wallById, wallLength } from '../../core/ops.js';
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
  /** Wall drags: the wall's normal and the corners' starting positions. */
  normal?: Vec2;
  orig?: Array<{ id: string; x: number; y: number }>;
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
    if (h?.kind === 'wall') return 'Tap to select, drag to slide this wall';
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
    if (!t) return;
    if (this.isLocked(t)) {
      this.select(t.kind === 'node' ? null : t);
      this.ctx.toast('Locked. Unlock it in the Edit tab to change it.', 3);
      return;
    }
    const start = aim.floor ?? aim.wall?.point ?? { x: 0, y: 0 };
    this.dragging = { target: t, start, moved: false };
    if (t.kind === 'wall') {
      const plan = this.ctx.store.plan;
      const w = wallById(plan, t.id);
      if (!w || !aim.floor) {
        this.dragging = null;
        return;
      }
      const { a, b } = wallEnds(plan, w);
      const L = dist(a, b) || 1;
      this.dragging.normal = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
      this.dragging.orig = [w.a, w.b].map((id) => {
        const n = plan.nodes.find((x) => x.id === id)!;
        return { id, x: n.x, y: n.y };
      });
      this.dragging.start = aim.floor;
    }
    this.ctx.store.begin(t.kind === 'node' ? 'Move corner' : t.kind === 'opening' ? 'Move door' : t.kind === 'wall' ? 'Slide wall' : 'Move pin');
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
        this.ctx.cmd.run('node.move', { id, x: s.point.x, y: s.point.y });
        pv.showCursor(s.point, s.kind, false);
        pv.showGuides(s.guides, s.point);
      }
    } else if (d.target.kind === 'wall' && d.normal && d.orig && aim.floor) {
      // Slide along the wall's normal, in whole inches (fine mode: 1/4").
      const raw = (aim.floor.x - d.start.x) * d.normal.x + (aim.floor.y - d.start.y) * d.normal.y;
      if (d.moved || Math.abs(raw) > 1.5) {
        d.moved = true;
        let off = Math.round(raw);
        // Snap: line up with other corners (so the wall lands square on another wall's end).
        const wallId = d.target.id;
        const others = plan.nodes.filter((n) => !d.orig!.some((o) => o.id === n.id));
        const o0 = d.orig[0];
        for (const n of others) {
          const want = (n.x - o0.x) * d.normal.x + (n.y - o0.y) * d.normal.y;
          if (Math.abs(want - raw) < 3) {
            off = want;
            break;
          }
        }
        const [oa, ob] = d.orig;
        const nrm = d.normal;
        this.ctx.cmd.run('wall.place', {
          id: wallId,
          a: { x: oa.x + nrm.x * off, y: oa.y + nrm.y * off },
          b: { x: ob.x + nrm.x * off, y: ob.y + nrm.y * off },
        });
        const w = wallById(plan, wallId);
        if (w) {
          const { a, b } = wallEnds(this.ctx.store.plan, w);
          pv.showHint(`${off >= 0 ? 'Moved' : 'Moved'} ${formatLength(Math.abs(off))}`, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 60);
        }
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
          this.ctx.cmd.run('opening.update', { id: op.id, offset: off });
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
          this.ctx.cmd.run('marker.move', { id, ...next, wallId });
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
      const kind = w.kind === 'existing' ? (w.demolish ? 'Wall to demolish' : 'Real wall') : 'Planned wall';
      const tags = [w.locked ? 'locked' : '', w.kind === 'existing' && w.evidence === 'inferred' ? 'guessed' : ''].filter(Boolean);
      return `${kind}${tags.length ? ` (${tags.join(', ')})` : ''}: ${formatLength(wallLength(plan, w))} long, ${formatLength(w.height)} high, ${w.thickness}" thick`;
    }
    if (s.kind === 'opening') {
      const o = plan.openings.find((x) => x.id === s.id);
      return o
        ? `${o.type === 'door' ? 'Door' : o.type === 'window' ? 'Window' : 'Opening'}${o.locked ? ' (locked)' : ''}: ${widthText(o.width)} x ${formatLength(o.height)}${o.sill > 0 ? `, sill ${formatLength(o.sill)}` : ''}`
        : '';
    }
    if (s.kind === 'marker') {
      const m = plan.markers.find((x) => x.id === s.id);
      return m ? `Pin${m.locked ? ' (locked)' : ''}: ${m.type.replace('-', ' ')} at ${formatLength(m.z)}` : '';
    }
    return '';
  }

  typeLength(): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.openKeypad('Wall length', wallLength(this.ctx.store.plan, w), (inches) => {
      if (this.ctx.act('wall.setLength', { id: w.id, length: inches, keep: 'a' })) this.ctx.toast(`Wall set to ${formatLength(inches)}`);
    });
  }

  typeHeight(): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.openKeypad('Wall height', w.height, (inches) => {
      this.ctx.act('wall.setHeight', { id: w.id, height: inches });
      this.ctx.refreshUi();
    });
  }

  typeThickness(): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.openKeypad('Wall thickness', w.thickness, (inches) => {
      this.ctx.act('wall.setThickness', { id: w.id, thickness: inches });
    });
  }

  /** Split the selected wall in the middle; drag the new corner where you need it. */
  split(): void {
    const w = this.selectedWall();
    if (!w) return;
    if (!this.ctx.act('wall.split', { id: w.id, t: 0.5 })) return;
    this.select(null);
    this.ctx.toast('Split. Drag the new corner to place it.');
  }

  toggleKind(): void {
    const w = this.selectedWall();
    if (!w) return;
    const next = w.kind === 'existing' ? 'new' : 'existing';
    if (!this.ctx.act('wall.setKind', { id: w.id, kind: next })) return;
    this.ctx.toast(next === 'new' ? 'Now a planned (new) wall' : 'Now a real (existing) wall');
  }

  /** Is this target (or, for a corner, a wall meeting there) locked? */
  isLocked(t: Target): boolean {
    const plan = this.ctx.store.plan;
    if (t.kind === 'node') return plan.walls.some((w) => (w.a === t.id || w.b === t.id) && w.locked);
    const coll = t.kind === 'wall' ? plan.walls : t.kind === 'opening' ? plan.openings : plan.markers;
    return !!coll.find((x) => x.id === t.id)?.locked;
  }

  /** Lock or unlock the selection. */
  toggleLock(): void {
    const s = this.selection;
    if (!s || s.kind === 'node') return;
    const next = !this.isLocked(s);
    if (this.ctx.act('element.setLocked', { id: s.id, locked: next })) this.ctx.toast(next ? 'Locked: nothing can change it until you unlock it' : 'Unlocked');
  }

  /** Keep the selected wall's length through later edits (or stop). */
  toggleKeepLength(): void {
    const w = this.selectedWall();
    if (!w) return;
    const k = this.ctx.store.plan.constraints.find((c) => c.type === 'length' && c.a === w.id);
    if (k) {
      if (this.ctx.act('constraint.delete', { id: k.id })) this.ctx.toast('Length no longer kept');
    } else if (this.ctx.act('constraint.add', { type: 'length', a: w.id })) this.ctx.toast(`Keeping ${formatLength(wallLength(this.ctx.store.plan, w))}`);
  }

  /** Mark the selected real wall for demolition, or keep it. */
  toggleDemolish(): void {
    const w = this.selectedWall();
    if (!w) return;
    if (w.kind !== 'existing') {
      this.ctx.toast('Only real walls can be demolished. Delete a planned wall instead.', 3);
      return;
    }
    const next = !w.demolish;
    if (this.ctx.act('wall.setDemolish', { id: w.id, demolish: next })) this.ctx.toast(next ? 'Marked for demolition' : 'Keeping this wall');
  }

  selectedOpening() {
    const s = this.selection;
    return s?.kind === 'opening' ? this.ctx.store.plan.openings.find((o) => o.id === s.id) : undefined;
  }

  typeOpeningHeight(): void {
    const o = this.selectedOpening();
    if (!o) return;
    this.ctx.openKeypad('Opening height', o.height, (h) => this.ctx.act('opening.update', { id: o.id, height: h }));
  }

  /** Door -> opening -> window. */
  cycleOpeningType(): void {
    const o = this.selectedOpening();
    if (!o) return;
    const next = o.type === 'door' ? 'opening' : o.type === 'opening' ? 'window' : 'door';
    const toWindow = next === 'window' && o.sill <= 0;
    this.ctx.act('opening.update', {
      id: o.id,
      type: next,
      sill: next === 'window' ? (toWindow ? 48 : o.sill) : 0,
      height: toWindow ? Math.min(o.height, 36) : o.height,
    });
  }

  /** Swap the door's hinge side, then its swing. */
  flipDoor(): void {
    const o = this.selectedOpening();
    if (!o) return;
    // Hinge side first, then swing direction.
    this.ctx.act('opening.update', o.hinge === 'a' ? { id: o.id, hinge: 'b' } : { id: o.id, hinge: 'a', swing: o.swing === 'left' ? 'right' : 'left' });
  }

  setStud(size: '2x4' | '2x6'): void {
    const w = this.selectedWall();
    if (!w) return;
    this.ctx.act('wall.setThickness', { id: w.id, thickness: size === '2x6' ? 6.5 : 4.5 });
  }

  typeWidth(): void {
    const s = this.selection;
    if (s?.kind !== 'opening') return;
    const o = this.ctx.store.plan.openings.find((x) => x.id === s.id);
    if (!o) return;
    this.ctx.openKeypad('Opening width', o.width, (w) => {
      this.ctx.act('opening.update', { id: s.id, width: w });
    });
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'node' || !this.ctx.act('element.delete', { id: s.id })) return;
    this.select(null);
    this.ctx.toast('Deleted. Undo brings it back.');
  }
}
