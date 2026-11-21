import type { ScanSession } from '../scanSession.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/** After a scan: point at a found wall, low area or post and click to skip or keep it. */
export class ScanReviewTool implements Tool {
  readonly name = 'Review scan';

  constructor(
    private ctx: ToolContext,
    private scan: ScanSession,
  ) {}

  activate(): void {}

  deactivate(): void {
    this.scan.hover(null);
  }

  hint(): string {
    return 'Click a found item to skip or keep it';
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const id = aim?.floor ? this.scan.pick(aim.floor) : null;
    this.scan.hover(id);
    if (aim?.floor) pv.showCursor(aim.floor, 'free', false);
  }

  commit(aim: AimHit): void {
    if (!aim.floor) return;
    const id = this.scan.pick(aim.floor);
    if (!id) return;
    this.scan.toggle(id);
    this.ctx.refreshUi();
  }
}
