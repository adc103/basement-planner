import { describe, expect, it } from 'vitest';
import { findWalls, type FoundWall } from '../src/core/wallFinder';
import { basementScene, scanScene } from './synthScan';

const scene = basementScene();
const { map, free } = scanScene(scene);
const pts = map.points(2);
const opts = { z0: 0, H: 92, axis: 0, partitionThickness: 4.5, foundationThickness: 8 };
const walls = findWalls(pts, free, opts);
const len = (w: FoundWall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);

describe('wall finder on a ray-cast basement', () => {
  it('finds exactly the 4 foundation walls and the partition', () => {
    expect(walls).toHaveLength(5);
    expect(walls.filter((w) => w.foundation)).toHaveLength(4);
    for (const w of walls.filter((x) => x.foundation)) expect(w.thickness).toBe(8);
  });

  it('measures the partition thickness from its two faces', () => {
    const p = walls.find((w) => !w.foundation)!;
    expect(p.thickness).toBeCloseTo(4.5, 0);
    expect((p.a.x + p.b.x) / 2).toBeCloseTo(202.25, 0);
    expect(len(p)).toBeGreaterThan(236);
  });

  it('finds the door and the 4 ft opening under its beam', () => {
    const p = walls.find((w) => !w.foundation)!;
    const door = p.openings.find((o) => o.type === 'door')!;
    expect(door.width).toBe(32);
    expect(door.height).toBe(80);
    expect(Math.abs(door.center.y - 46)).toBeLessThan(3);
    const wide = p.openings.find((o) => o.type === 'opening')!;
    expect(Math.abs(wide.width - 48)).toBeLessThanOrEqual(2);
    expect(Math.abs(wide.height - 84)).toBeLessThanOrEqual(1);
    expect(Math.abs(wide.center.y - 174)).toBeLessThan(3);
  });

  it('finds the window high in the north wall', () => {
    const north = walls.find((w) => w.foundation && w.a.y > 230)!;
    expect(north.openings).toHaveLength(1);
    const win = north.openings[0];
    expect(win.type).toBe('window');
    expect(Math.abs(win.sill - 62)).toBeLessThanOrEqual(2);
    expect(Math.abs(win.height - 18)).toBeLessThanOrEqual(3);
    expect(Math.abs(win.width - 32)).toBeLessThanOrEqual(5);
  });

  it('ignores the shelf, jacket, furnace and post', () => {
    for (const w of walls) {
      const midX = (w.a.x + w.b.x) / 2;
      const midY = (w.a.y + w.b.y) / 2;
      // nothing in the middle of either room
      expect(midY < 10 || midY > 230 || midX < 10 || midX > 350 || Math.abs(midX - 202) < 5).toBe(true);
    }
    // the wall behind the shelf and the one behind the jacket have no fake openings
    for (const w of walls.filter((x) => x.foundation && x.a.y < 230)) expect(w.openings).toHaveLength(0);
  });

  it('still works from a short walk on one side only', () => {
    const part = scanScene({ boxes: scene.boxes, eyes: scene.eyes.slice(0, 4) });
    const ws = findWalls(part.map.points(2), part.free, opts);
    const partition = ws.find((w) => Math.abs((w.a.x + w.b.x) / 2 - 202) < 6);
    expect(partition).toBeTruthy();
    expect(partition!.openings.some((o) => o.type === 'door')).toBe(true);
    expect(ws.length).toBeLessThanOrEqual(6);
  });
});
