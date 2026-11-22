import { describe, expect, it } from 'vitest';
import { checkPlan, fitWall, SurfaceIndex, surfaceFromMeshes } from '../src/core/fit';
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
