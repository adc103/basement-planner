import { describe, expect, it } from 'vitest';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { addWallBetween, wallNormalToward } from '../src/core/ops';
import { findRoomFaces, openArea } from '../src/core/rooms';

const P = { height: 96, thickness: 4.5 };

describe('open area (floor and ceiling outside rooms)', () => {
  it('covers an open basement with no closed rooms', () => {
    const s = new PlanStore(createEmptyPlan());
    s.edit('w', (d) => {
      addWallBetween(d, { x: 0, y: 0 }, { x: 360, y: 0 }, P);
      addWallBetween(d, { x: 360, y: 0 }, { x: 360, y: 240 }, P);
    });
    const a = openArea(s.plan)!;
    expect(a).toBeTruthy();
    expect(a.holes).toHaveLength(0);
    expect(a.areaSqFt).toBeCloseTo((360 * 240) / 2 / 144, 0);
  });

  it('cuts closed rooms out', () => {
    const s = new PlanStore(createEmptyPlan());
    s.edit('w', (d) => {
      const r = [{ x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 300 }, { x: 0, y: 300 }];
      // Basement corners (open walls along two sides) plus a closed 10'x10' room.
      addWallBetween(d, r[0], r[1], P);
      addWallBetween(d, r[1], r[2], P);
      addWallBetween(d, r[2], r[3], P);
      addWallBetween(d, { x: 0, y: 0 }, { x: 0, y: 120 }, P);
      addWallBetween(d, { x: 0, y: 120 }, { x: 120, y: 120 }, P);
      addWallBetween(d, { x: 120, y: 120 }, { x: 120, y: 0 }, P);
    });
    const faces = findRoomFaces(s.plan);
    expect(faces.length).toBe(1);
    const a = openArea(s.plan, faces)!;
    expect(a.holes).toHaveLength(1);
    expect(a.areaSqFt).toBeLessThan((480 * 300) / 144 - 90);
  });

  it('gives the wall normal facing the viewer', () => {
    const s = new PlanStore(createEmptyPlan());
    let id = '';
    s.edit('w', (d) => {
      id = addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, P)!;
    });
    expect(wallNormalToward(s.plan, id, { x: 50, y: 60 })).toEqual({ x: -0, y: 1 });
    expect(wallNormalToward(s.plan, id, { x: 50, y: -60 })!.y).toBe(-1);
  });
});
