import { deleteOpening, deleteWall, locateOnWall, wallById } from '../../core/ops.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/** Point at a wall or opening and press to delete it. */
export class DeleteTool implements Tool {
  readonly name = 'Delete';
  constructor(private ctx: ToolContext) {}

  activate(): void {}
  deactivate(): void {
    this.ctx.view.setHighlight(null);
  }

  hint(): string {
    return 'Delete: point at a wall or door';
  }

  private target(aim: AimHit): { kind: 'wall' | 'opening'; id: string; wallId: string } | null {
    if (!aim.wall) return null;
    const plan = this.ctx.store.plan;
    const wall = wallById(plan, aim.wall.wallId);
    if (!wall) return null;
    const loc = locateOnWall(plan, wall, aim.wall.point);
    const op = plan.openings.find((o) => o.wallId === wall.id && Math.abs(o.offset - loc.along) <= o.width / 2 + 2);
    if (op) return { kind: 'opening', id: op.id, wallId: wall.id };
    return { kind: 'wall', id: wall.id, wallId: wall.id };
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const t = aim ? this.target(aim) : null;
    this.ctx.view.setHighlight(t?.wallId ?? null);
    if (t && aim?.wall) {
      const kind = wallById(this.ctx.store.plan, t.wallId)?.kind;
      pv.showHint(t.kind === 'opening' ? 'Delete opening' : kind === 'existing' ? 'Delete scanned wall' : 'Delete wall', aim.wall.point, 60);
    }
  }

  commit(aim: AimHit): void {
    const t = this.target(aim);
    if (!t) return;
    if (t.kind === 'opening') this.ctx.store.edit('Delete opening', (d) => deleteOpening(d, t.id));
    else this.ctx.store.edit('Delete wall', (d) => deleteWall(d, t.id));
    this.ctx.view.setHighlight(null);
    this.ctx.toast('Deleted. Undo brings it back.');
  }
}
