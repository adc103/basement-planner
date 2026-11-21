import type { Draft } from 'immer';
import { mergeFootprints } from './footprint.js';
import { addOpening, addSoffit, addWallBetween, setWallHeight, splitAtNodes } from './ops.js';
import { newId, type Plan } from './plan.js';
import type { StructureResult } from './structure.js';

/**
 * Put reviewed scan results into the plan: real walls with their doors and
 * windows (joined into one connected wall graph), low areas, posts, the
 * ceiling height and the floor footprint.
 */
export function applyScan(d: Draft<Plan>, res: StructureResult): void {
  const off = res.floorOffset ?? 0;
  const ceiling = res.ceiling !== null ? res.ceiling - off : null;
  const goodCeiling = ceiling !== null && ceiling > 60 && ceiling < 180;
  const H = goodCeiling ? ceiling! : d.settings.wallHeight;
  if (goodCeiling) {
    const old = d.settings.wallHeight;
    d.settings.wallHeight = H;
    for (const w of d.walls) if (w.kind === 'new' && w.height === old) setWallHeight(d, w.id, H);
  }
  for (const w of res.walls) {
    const id = addWallBetween(d, w.a, w.b, { height: H, thickness: w.thickness, kind: 'existing', source: 'capture', againstFoundation: false });
    if (!id) continue;
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    for (const o of w.openings) {
      const offset = ((o.center.x - w.a.x) * (w.b.x - w.a.x) + (o.center.y - w.a.y) * (w.b.y - w.a.y)) / len;
      addOpening(d, { wallId: id, type: o.type, offset, width: o.width, height: Math.min(o.height, H - o.sill), sill: o.sill, hinge: 'a', swing: 'left' });
    }
  }
  splitAtNodes(d);
  for (const s of res.soffits) addSoffit(d, s.poly, Math.min(H - 1, s.bottom));
  for (const p of res.posts) d.obstacles.push({ id: newId('ob'), label: 'Post', poly: p.poly.map((q) => ({ ...q })), height: H, source: 'manual' });
  if (res.footprint) d.footprint = mergeFootprints(res.footprint, d.footprint ?? null);
}
