import { describe, expect, it } from 'vitest';
import { createEmptyPlan, parsePlan, type Plan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import {
  addOpening,
  addWallBetween,
  deleteWall,
  replaceExistingWalls,
  setWallLength,
  wallLength,
} from '../src/core/ops';

const props = { height: 96, thickness: 4.5 };

function store(): PlanStore {
  return new PlanStore(createEmptyPlan());
}

describe('walls', () => {
  it('chains walls through shared nodes', () => {
    const s = store();
    s.edit('w', (d) => {
      addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, props);
      addWallBetween(d, { x: 120, y: 0 }, { x: 120, y: 96 }, props);
    });
    expect(s.plan.walls).toHaveLength(2);
    expect(s.plan.nodes).toHaveLength(3);
  });

  it('rejects zero-length and duplicate walls', () => {
    const s = store();
    s.edit('w', (d) => {
      expect(addWallBetween(d, { x: 0, y: 0 }, { x: 0.1, y: 0 }, props)).toBeNull();
      expect(addWallBetween(d, { x: 0, y: 0 }, { x: 10, y: 0 }, props)).not.toBeNull();
      expect(addWallBetween(d, { x: 10, y: 0 }, { x: 0, y: 0 }, props)).toBeNull();
    });
    expect(s.plan.walls).toHaveLength(1);
  });

  it('splits a wall when a new wall starts on it (T junction) and keeps openings on the right half', () => {
    const s = store();
    s.edit('w', (d) => {
      const id = addWallBetween(d, { x: 0, y: 0 }, { x: 200, y: 0 }, props)!;
      addOpening(d, { wallId: id, type: 'door', offset: 150, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 100 }, props);
    });
    expect(s.plan.walls).toHaveLength(3);
    expect(s.plan.nodes).toHaveLength(4);
    const door = s.plan.openings[0];
    const host = s.plan.walls.find((w) => w.id === door.wallId)!;
    expect(wallLength(s.plan, host)).toBeCloseTo(100);
    expect(door.offset).toBeCloseTo(50);
  });

  it('sets an exact length by moving the far end', () => {
    const s = store();
    let id = '';
    s.edit('w', (d) => {
      id = addWallBetween(d, { x: 0, y: 0 }, { x: 97.3, y: 41.1 }, props)!;
    });
    s.edit('len', (d) => setWallLength(d, id, 120));
    const w = s.plan.walls[0];
    expect(wallLength(s.plan, w)).toBeCloseTo(120, 9);
    // direction preserved
    const b = s.plan.nodes.find((n) => n.id === w.b)!;
    expect(Math.atan2(b.y, b.x)).toBeCloseTo(Math.atan2(41.1, 97.3), 9);
  });

  it('deletes walls with their openings and orphan nodes', () => {
    const s = store();
    let id = '';
    s.edit('w', (d) => {
      id = addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, props)!;
      addWallBetween(d, { x: 120, y: 0 }, { x: 120, y: 120 }, props);
      addOpening(d, { wallId: id, type: 'opening', offset: 60, width: 36, height: 80, sill: 0, hinge: 'a', swing: 'left' });
    });
    s.edit('del', (d) => deleteWall(d, id));
    expect(s.plan.walls).toHaveLength(1);
    expect(s.plan.openings).toHaveLength(0);
    expect(s.plan.nodes).toHaveLength(2);
  });
});

describe('openings', () => {
  it('clamps an opening inside the wall and rejects overlaps', () => {
    const s = store();
    s.edit('w', (d) => {
      const id = addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props)!;
      const o1 = addOpening(d, { wallId: id, type: 'door', offset: 5, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      expect(o1).not.toBeNull();
      const o2 = addOpening(d, { wallId: id, type: 'door', offset: 30, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      expect(o2).toBeNull();
    });
    expect(s.plan.openings[0].offset).toBeCloseTo(16 + 1.5);
  });

  it('rejects an opening wider than the wall', () => {
    const s = store();
    s.edit('w', (d) => {
      const id = addWallBetween(d, { x: 0, y: 0 }, { x: 30, y: 0 }, props)!;
      expect(addOpening(d, { wallId: id, type: 'door', offset: 15, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' })).toBeNull();
    });
  });

  it('caps opening height below the wall top', () => {
    const s = store();
    s.edit('w', (d) => {
      const id = addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, { height: 80, thickness: 4.5 })!;
      addOpening(d, { wallId: id, type: 'door', offset: 50, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
    });
    expect(s.plan.openings[0].height).toBe(79);
  });
});

describe('existing walls', () => {
  it('replaces the previous import', () => {
    const s = store();
    s.edit('import', (d) =>
      replaceExistingWalls(d, [{ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }, { a: { x: 300, y: 0 }, b: { x: 300, y: 200 } }], 90),
    );
    s.edit('import', (d) => replaceExistingWalls(d, [{ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }], 90));
    expect(s.plan.walls).toHaveLength(1);
    expect(s.plan.walls[0].kind).toBe('existing');
    expect(s.plan.walls[0].thickness).toBe(8);
  });
});

describe('store', () => {
  it('undoes and redoes edits', () => {
    const s = store();
    s.edit('a', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 10, y: 0 }, props));
    s.edit('b', (d) => addWallBetween(d, { x: 10, y: 0 }, { x: 10, y: 10 }, props));
    expect(s.undo()).toBe('b');
    expect(s.plan.walls).toHaveLength(1);
    expect(s.undo()).toBe('a');
    expect(s.plan.walls).toHaveLength(0);
    expect(s.plan.nodes).toHaveLength(0);
    expect(s.undo()).toBeNull();
    s.redo();
    s.redo();
    expect(s.plan.walls).toHaveLength(2);
  });

  it('groups edits into one undo step', () => {
    const s = store();
    s.begin('chain');
    s.edit('a', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 10, y: 0 }, props));
    s.edit('b', (d) => addWallBetween(d, { x: 10, y: 0 }, { x: 10, y: 10 }, props));
    s.end();
    expect(s.undo()).toBe('chain');
    expect(s.plan.walls).toHaveLength(0);
  });

  it('drops redo history after a new edit', () => {
    const s = store();
    s.edit('a', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 10, y: 0 }, props));
    s.undo();
    s.edit('b', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 0, y: 10 }, props));
    expect(s.canRedo).toBe(false);
  });

  it('ignores no-op edits', () => {
    const s = store();
    s.edit('noop', () => {});
    expect(s.canUndo).toBe(false);
  });
});

describe('parsePlan', () => {
  it('round-trips a plan through JSON', () => {
    const s = store();
    s.edit('a', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 10, y: 0 }, props));
    const again: Plan = parsePlan(JSON.parse(JSON.stringify(s.plan)));
    expect(again).toEqual(s.plan);
  });

  it('rejects other JSON with a readable message', () => {
    expect(() => parsePlan({ hello: 1 })).toThrow(/Not a valid plan file/);
  });

  it('drops dangling walls and openings', () => {
    const p = createEmptyPlan();
    const bad = {
      ...p,
      walls: [{ id: 'w1', a: 'n1', b: 'nX', height: 96, thickness: 4.5 }],
      nodes: [{ id: 'n1', x: 0, y: 0 }],
      openings: [{ id: 'o', wallId: 'w1', type: 'door', offset: 1, width: 1, height: 1 }],
    };
    const out = parsePlan(bad);
    expect(out.walls).toHaveLength(0);
    expect(out.openings).toHaveLength(0);
  });
});
