import { dist, type Vec2 } from '../../core/geom2d.js';
import { addWallBetween, findNodeNear, setWallHeight, setWallLength, wallById, wallEnds, wallLength, wallsAtNode } from '../../core/ops.js';
import { snap, type SnapResult } from '../../core/snapping.js';
import { formatLength } from '../../core/units.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/**
 * Click corners to chain walls. Ends the chain when you click the same spot
 * twice, close the loop, or join an existing corner.
 */
export class WallTool implements Tool {
  readonly name = 'Walls';
  /** Points placed in the current chain. */
  private chain: Vec2[] = [];
  /** Wall ids created by the chain, in order. */
  private chainWalls: string[] = [];
  /** Last wall created (for typed length/height), survives chain end. */
  lastWallId: string | null = null;
  private lastSnap: SnapResult | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {}

  deactivate(): void {
    this.endChain();
  }

  get drawing(): boolean {
    return this.chain.length > 0;
  }

  hint(): string {
    if (!this.chain.length) return 'Walls: pinch / trigger to place the first corner';
    return 'Next corner. Same spot twice = finish';
  }

  private current(aim: AimHit): SnapResult | null {
    if (!aim.floor) return null;
    const from = this.chain.at(-1);
    return snap(this.ctx.store.plan, aim.floor, this.ctx.snapOptions(aim, from));
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    pv.beginGuides();
    if (!aim) {
      pv.endGuides();
      return;
    }
    const s = this.current(aim);
    this.lastSnap = s;
    if (s) {
      pv.showCursor(s.point, s.kind, aim.fine);
      pv.showGuides(s.guides, s.point);
      const from = this.chain.at(-1);
      if (from) {
        const st = this.ctx.store.plan.settings;
        pv.showRubberWall(from, s.point, st.wallThickness, st.wallHeight, formatLength(dist(from, s.point), 8));
      }
    }
    pv.endGuides();
  }

  commit(aim: AimHit): void {
    const s = this.current(aim) ?? this.lastSnap;
    if (!s) return;
    const p = s.point;
    const from = this.chain.at(-1);
    if (!from) {
      this.chain = [p];
      this.chainWalls = [];
      this.ctx.refreshUi();
      return;
    }
    if (dist(from, p) < 0.75) {
      this.endChain();
      this.ctx.toast('Chain finished');
      return;
    }
    const st = this.ctx.store.plan.settings;
    const startNodeHadWalls = (() => {
      const n = findNodeNear(this.ctx.store.plan, p);
      return n ? wallsAtNode(this.ctx.store.plan, n.id).length > 0 : false;
    })();
    const id = this.ctx.store.edit('Add wall', (d) =>
      addWallBetween(d, from, p, {
        height: st.wallHeight,
        thickness: st.wallThickness,
        againstFoundation: s.kind === 'follow',
      }),
    );
    if (!id) {
      this.ctx.toast('That wall already exists');
      return;
    }
    this.chainWalls.push(id);
    this.lastWallId = id;
    this.chain.push(p);
    const closedLoop = dist(p, this.chain[0]) < 0.75 && this.chain.length > 2;
    if (closedLoop || (s.kind === 'endpoint' && startNodeHadWalls)) {
      this.endChain();
      this.ctx.toast(closedLoop ? 'Loop closed' : 'Joined existing corner');
    }
    this.ctx.refreshUi();
  }

  endChain(): void {
    this.chain = [];
    this.chainWalls = [];
    this.ctx.preview.clear();
    this.ctx.refreshUi();
  }

  /** Undo inside a chain steps back one corner. */
  undo(): boolean {
    if (!this.chain.length) return false;
    if (this.chainWalls.length) {
      this.ctx.store.undo();
      this.chainWalls.pop();
      this.chain.pop();
      this.lastWallId = this.chainWalls.at(-1) ?? null;
    } else {
      this.chain = [];
    }
    this.ctx.refreshUi();
    return true;
  }

  /** The last wall drawn that still exists (falls back to the newest new wall). */
  lastWall() {
    const plan = this.ctx.store.plan;
    const byId = this.lastWallId ? wallById(plan, this.lastWallId) : undefined;
    return byId ?? [...plan.walls].reverse().find((w) => w.kind === 'new');
  }

  /** Typed length for the last wall; keeps the chain going from its new end. */
  typeLength(): void {
    const plan = this.ctx.store.plan;
    const wall = this.lastWall();
    if (!wall) {
      this.ctx.toast('Draw a wall first, then type its length');
      return;
    }
    this.ctx.openKeypad('Length of last wall', wallLength(plan, wall), (inches) => {
      const ok = this.ctx.store.edit('Set length', (d) => setWallLength(d, wall.id, inches, 'a'));
      if (!ok) return;
      const w = wallById(this.ctx.store.plan, wall.id);
      if (w && this.chainWalls.at(-1) === wall.id) {
        const { b } = wallEnds(this.ctx.store.plan, w);
        this.chain[this.chain.length - 1] = b;
      }
      this.ctx.toast(`Wall set to ${formatLength(inches)}`);
    });
  }

  /** Typed height: sets the default for new walls and the walls of this chain. */
  typeHeight(): void {
    const st = this.ctx.store.plan.settings;
    this.ctx.openKeypad('Wall height', st.wallHeight, (inches) => this.applyHeight(inches));
  }

  applyHeight(inches: number): void {
    const last = this.lastWall();
    const ids = this.chainWalls.length ? [...this.chainWalls] : last ? [last.id] : [];
    this.ctx.store.edit('Set height', (d) => {
      d.settings.wallHeight = inches;
      for (const id of ids) setWallHeight(d, id, inches);
    });
    this.ctx.toast(`Wall height ${formatLength(inches)}`);
  }
}
