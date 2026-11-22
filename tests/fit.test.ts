import { describe, expect, it } from 'vitest';
import { refineStructure } from '../src/core/fit';
import { checkPlan, dedupeWalls, fitWall, sameWall, SurfaceIndex, surfaceFromMeshes } from '../src/core/fit';
import { CommandBus } from '../src/core/commands';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { TsdfVolume } from '../src/core/tsdf';
import { basementScene, depthFramesFor } from './synthScan';

describe('fit and verify against the room mesh', () => {
  const vol = new TsdfVolume();
  for (const f of depthFramesFor(basementScene())) vol.integrate(f);
  const surf = surfaceFromMeshes(vol.meshDirty());
  const idx = new SurfaceIndex(surf);
  const base = { z0: 0, z1: 92 };

  it('pulls a misplaced partition onto its real faces and measures its thickness', () => {
    // Truth: faces at x = 200 and 204.5 (center 202.25, 4.5" thick). Proposal: 2" off, 6" thick.
    const f = fitWall(idx, { a: { x: 204.25, y: 0 }, b: { x: 204.25, y: 240 }, thickness: 6, ...base, openings: [] });
    expect(Math.abs(f.a.x - 202.25)).toBeLessThan(0.4);
    expect(Math.abs(f.thickness - 4.5)).toBeLessThan(0.5);
    expect(f.faces.left && f.faces.right).toBeTruthy();
    expect(f.coverage).toBeGreaterThan(0.4);
  });

  it('sets a foundation wall by the one face it can see', () => {
    // South foundation: room face at y = 0, wall behind it. Proposal 1.5" into the room.
    const f = fitWall(idx, { a: { x: 368, y: -2.5 }, b: { x: -8, y: -2.5 }, thickness: 8, ...base, openings: [] });
    const face = f.a.y + 4; // the room side of an 8" wall centered at f.a.y
    expect(Math.abs(face)).toBeLessThan(0.4);
    expect(f.evidence).toBe('measured');
  });

  it('finds the door jambs', () => {
    // Door y 30..62 (center 46, 32" wide, 80" high). Proposal: center 49, 36" wide.
    const f = fitWall(idx, { a: { x: 202.25, y: 0 }, b: { x: 202.25, y: 240 }, thickness: 4.5, ...base, openings: [{ offset: 49, width: 36, height: 80, sill: 0 }] });
    const o = f.openings[0];
    expect(Math.abs(o.offset - 46)).toBeLessThan(0.75);
    expect(Math.abs(o.width - 32)).toBeLessThan(1);
    expect(o.edges).toBe(2);
    expect(o.blocked).toBeLessThan(0.08);
    expect(o.evidence).toBe('measured');
  });

  it('flags a door drawn where the wall is solid', () => {
    const f = fitWall(idx, { a: { x: 202.25, y: 0 }, b: { x: 202.25, y: 240 }, thickness: 4.5, ...base, openings: [{ offset: 100, width: 32, height: 80, sill: 0 }] });
    expect(f.openings[0].blocked).toBeGreaterThan(0.25);
    expect(f.openings[0].evidence).toBe('inferred');
  });

  it('calls a wall with nothing behind it inferred', () => {
    const f = fitWall(idx, { a: { x: 80, y: 20 }, b: { x: 80, y: 100 }, thickness: 4.5, ...base, openings: [] });
    expect(f.evidence).toBe('inferred');
    expect(f.shift).toBe(0);
  });

  it('checks without moving when asked to', () => {
    const f = fitWall(idx, { a: { x: 204.25, y: 0 }, b: { x: 204.25, y: 240 }, thickness: 4.5, ...base, openings: [] }, { refine: false });
    expect(f.a.x).toBe(204.25);
    expect(f.deviation).toBeGreaterThan(1.5);
    expect(f.evidence).not.toBe('measured');
  });

  it('checks a drawn plan and finds the wall that is off', () => {
    const b = new CommandBus(new PlanStore(createEmptyPlan()));
    b.run('settings.set', { values: { wallHeight: 92 } });
    // South foundation drawn right (room face at y = 0), partition drawn 1.5" off.
    const south = b.run('wall.add', { a: { x: 0, y: -4 }, b: { x: 360, y: -4 }, kind: 'existing', thickness: 8 })!;
    const part = b.run('wall.add', { a: { x: 203.75, y: 0 }, b: { x: 203.75, y: 240 }, kind: 'existing', thickness: 4.5 })!;
    b.run('opening.add', { wallId: part, type: 'door', offset: 46, width: 32, height: 80 });
    const checks = checkPlan(b.store.plan, surf);
    expect(checks[0].wallId).toBe(part);
    expect(Math.abs(checks[0].check.deviation - 1.5)).toBeLessThan(0.4);
    expect(Math.abs(checks[0].fitted.a.x - 202.25)).toBeLessThan(0.4);
    const s = checks.find((c) => c.wallId === south)!;
    expect(s.check.deviation).toBeLessThan(0.4);
    expect(s.check.evidence).toBe('measured');
  });
});

describe('one proposal per real wall', () => {
  const W = (ax: number, ay: number, bx: number, by: number, confidence = 0.8, evidence: 'measured' | 'partial' | 'inferred' = 'measured', thickness = 4.5) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness, confidence, evidence });

  it('keeps the best of walls stacked in the same spot', () => {
    const walls = [W(109, -62, 109, 88, 0.89, 'measured', 8), W(110, -62, 110, 104, 0.83, 'measured', 8), W(114, -62, 114, 108, 0.89, 'partial', 8), W(119, -62, 119, 144, 0.66, 'inferred')];
    const kept = dedupeWalls(walls);
    expect(kept).toHaveLength(1);
    expect(kept[0].a.x).toBe(110); // measured and the longest of the measured ones
  });

  it('keeps real neighbours: back-to-back rooms and a hallway', () => {
    // Two walls 36" apart (a hallway) and a perpendicular one: all different walls.
    const kept = dedupeWalls([W(0, 0, 200, 0), W(0, 40.5, 200, 40.5), W(100, 0, 100, -120)]);
    expect(kept).toHaveLength(3);
  });

  it('does not propose walls the plan already has', () => {
    const known = [{ a: { x: 0, y: 0 }, b: { x: 240, y: 0 }, thickness: 8 }];
    expect(dedupeWalls([W(10, 3, 200, 3, 1, 'measured', 8), W(0, 60, 240, 60)], known)).toHaveLength(1);
  });

  it('sees parallel walls that only touch end to end as different walls', () => {
    expect(sameWall(W(0, 0, 100, 0), W(100, 0, 200, 0))).toBe(false);
    expect(sameWall(W(0, 0, 100, 0), W(0, 3, 100, 3))).toBe(true);
  });
});

describe('walls the mesh never saw', () => {
  it('keep their point-map evidence instead of being called guessed', () => {
    const vol = new TsdfVolume();
    for (const f of depthFramesFor(basementScene()).slice(0, 12)) vol.integrate(f);
    const surf = surfaceFromMeshes(vol.meshDirty());
    // A wall 50 ft away from anything meshed.
    const res = refineStructure(
      { floorOffset: 0, ceiling: 92, axis: 0, walls: [{ face: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, n: { x: 0, y: 1 }, rms: 0, support: 80 }, a: { x: 600, y: 600 }, b: { x: 800, y: 600 }, thickness: 4.5, foundation: false, confidence: 0.8, openings: [] }], soffits: [], posts: [], footprint: null },
      surf,
    );
    expect(res.walls).toHaveLength(1);
    expect(res.walls[0].evidence).toBe('partial');
    expect(res.walls[0].a).toEqual({ x: 600, y: 600 });
  });
});
