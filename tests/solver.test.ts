import { describe, expect, it } from 'vitest';
import { createEmptyPlan, type Plan } from '../src/core/plan';
import { solveConstraints, wallGap } from '../src/core/solver';
import { CommandBus } from '../src/core/commands';
import { PlanStore } from '../src/core/store';

function hall() {
  const b = new CommandBus(new PlanStore(createEmptyPlan()));
  // Two parallel walls 40" apart (centers), a cross wall joining them at x = 0.
  const w1 = b.run('wall.add', { a: { x: 0, y: 0 }, b: { x: 120, y: 0 } })!;
  const w2 = b.run('wall.add', { a: { x: 0, y: 40 }, b: { x: 120, y: 41 } })!; // a little out of square
  const w3 = b.run('wall.add', { a: { x: 0, y: 0 }, b: { x: 0, y: 40 } })!;
  return { b, w1, w2, w3 };
}

const copy = (p: Plan) => JSON.parse(JSON.stringify(p)) as Plan;

describe('constraint solver', () => {
  it('holds a clear hall width and makes the walls parallel', () => {
    const { b, w1, w2 } = hall();
    const p = copy(b.store.plan);
    p.constraints.push({ id: 'c1', type: 'distance', a: w1, b: w2, value: 36, mode: 'clear' });
    const r = solveConstraints(p);
    expect(r.ok).toBe(true);
    const g = wallGap(p, w1, w2)!;
    expect(g.clear).toBeCloseTo(36, 2);
    expect(g.angle).toBeLessThan(1e-4);
  });

  it('moves only what it must: pinned corners stay', () => {
    const { b, w1, w2 } = hall();
    const p = copy(b.store.plan);
    const w1n = p.walls.find((w) => w.id === w1)!;
    const before = p.nodes.filter((n) => n.id === w1n.a || n.id === w1n.b).map((n) => ({ ...n }));
    p.constraints.push({ id: 'c1', type: 'distance', a: w1, b: w2, value: 30, mode: 'clear' });
    expect(solveConstraints(p, new Set([w1n.a, w1n.b])).ok).toBe(true);
    for (const n0 of before) expect(p.nodes.find((n) => n.id === n0.id)).toMatchObject({ x: n0.x, y: n0.y });
  });

  it('squares a corner and keeps a length', () => {
    const { b, w2, w3 } = hall();
    const p = copy(b.store.plan);
    p.constraints.push({ id: 'p', type: 'perpendicular', a: w3, b: w2 }, { id: 'l', type: 'length', a: w2, value: 96 });
    expect(solveConstraints(p).ok).toBe(true);
    const W = (id: string) => {
      const w = p.walls.find((x) => x.id === id)!;
      const a = p.nodes.find((n) => n.id === w.a)!;
      const bb = p.nodes.find((n) => n.id === w.b)!;
      return { dx: bb.x - a.x, dy: bb.y - a.y };
    };
    const u = W(w2);
    const v = W(w3);
    expect(Math.hypot(u.dx, u.dy)).toBeCloseTo(96, 2);
    expect(Math.abs(u.dx * v.dx + u.dy * v.dy) / (Math.hypot(u.dx, u.dy) * Math.hypot(v.dx, v.dy))).toBeLessThan(1e-4);
  });

  it('reports a conflict instead of breaking a lock', () => {
    const { b, w1, w2 } = hall();
    const p = copy(b.store.plan);
    for (const w of p.walls) w.locked = true;
    p.constraints.push({ id: 'c1', type: 'distance', a: w1, b: w2, value: 20, mode: 'clear' });
    const before = JSON.stringify(p.nodes);
    const r = solveConstraints(p);
    expect(r.ok).toBe(false);
    expect(r.worstId).toBe('c1');
    expect(JSON.stringify(p.nodes)).toBe(before);
  });

  it('keeps walls in line', () => {
    const b = new CommandBus(new PlanStore(createEmptyPlan()));
    const a = b.run('wall.add', { a: { x: 0, y: 0 }, b: { x: 60, y: 0 } })!;
    const c = b.run('wall.add', { a: { x: 100, y: 3 }, b: { x: 160, y: 5 } })!;
    const p = copy(b.store.plan);
    p.constraints.push({ id: 'k', type: 'collinear', a, b: c });
    expect(solveConstraints(p).ok).toBe(true);
    const [p0, p1] = p.nodes;
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    for (const q of p.nodes) expect(Math.abs((q.x - p0.x) * (p1.y - p0.y) - (q.y - p0.y) * (p1.x - p0.x)) / L).toBeLessThan(0.01);
  });

  it('is fast enough to run on every drag frame', () => {
    const b = new CommandBus(new PlanStore(createEmptyPlan()));
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(b.run('wall.add', { a: { x: 0, y: i * 40 }, b: { x: 200, y: i * 40 + (i % 3) } })!);
    const p = copy(b.store.plan);
    for (let i = 1; i < ids.length; i++) p.constraints.push({ id: `d${i}`, type: 'distance', a: ids[i - 1], b: ids[i], value: 32, mode: 'clear' });
    const t0 = performance.now();
    const r = solveConstraints(p);
    expect(r.ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(60);
  });
});

describe('locks through commands', () => {
  it('keeps a hall width while you drag a corner', () => {
    const { b, w1, w2 } = hall();
    expect(b.run('constraint.add', { type: 'distance', a: w1, b: w2, value: 36 })).toBeTruthy();
    expect(wallGap(b.store.plan, w1, w2)!.clear).toBeCloseTo(36, 2);
    // Drag the far end of w1 down 6": w2 follows to stay 36" clear and parallel.
    const n = b.store.plan.walls.find((w) => w.id === w1)!.b;
    expect(b.exec('node.move', { id: n, x: 120, y: -6 }).ok).toBe(true);
    const g = wallGap(b.store.plan, w1, w2)!;
    expect(g.clear).toBeCloseTo(36, 2);
    expect(g.angle).toBeLessThan(1e-3);
    const moved = b.store.plan.nodes.find((x) => x.id === n)!;
    expect(moved).toMatchObject({ x: 120, y: -6 });
  });

  it('sets a distance by typing it, in one undo step', () => {
    const { b, w1, w2 } = hall();
    const r = b.exec('dimension.set', { a: w1, b: w2, distance: 30, keep: true });
    expect(r.ok).toBe(true);
    expect(wallGap(b.store.plan, w1, w2)!.clear).toBeCloseTo(30, 2);
    expect(b.store.plan.constraints).toHaveLength(1);
    expect(b.store.undoLabel).toBe('Set distance');
    b.store.undo();
    expect(b.store.plan.constraints).toHaveLength(0);
  });

  it('refuses an edit that would break a lock, and says which', () => {
    const { b, w1, w2, w3 } = hall();
    b.run('constraint.add', { type: 'length', a: w3, value: 40 });
    b.run('element.setLocked', { id: w1, locked: true });
    b.run('element.setLocked', { id: w2, locked: true });
    // w3 joins the two locked walls: it can't be any length but 40ish, so typing 50 for the hall fails.
    const r = b.exec('dimension.set', { a: w1, b: w2, distance: 50 });
    expect(r.ok).toBe(false);
    const before = JSON.stringify(b.store.plan);
    const r2 = b.exec('constraint.add', { type: 'length', a: w3, value: 60 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/wall length/);
    expect(JSON.stringify(b.store.plan)).toBe(before);
  });

  it('typing a kept length changes what it keeps', () => {
    const { b, w1 } = hall();
    b.run('constraint.add', { type: 'length', a: w1 });
    expect(b.exec('wall.setLength', { id: w1, length: 100 }).ok).toBe(true);
    expect(b.store.plan.constraints[0].value).toBe(100);
  });

  it('drops locks with their wall and copies them when a wall splits', () => {
    const { b, w1, w2, w3 } = hall();
    b.run('constraint.add', { type: 'distance', a: w1, b: w2 });
    b.run('constraint.add', { type: 'length', a: w2 });
    b.run('wall.split', { id: w1 });
    expect(b.store.plan.constraints.filter((c) => c.type === 'distance')).toHaveLength(2);
    b.run('element.delete', { id: w2 });
    expect(b.store.plan.constraints).toHaveLength(0);
    void w3;
  });

  it('squares a corner on request', () => {
    const { b, w2, w3 } = hall();
    expect(b.exec('constraint.add', { type: 'perpendicular', a: w3, b: w2 }).ok).toBe(true);
    const p = b.store.plan;
    const dir = (id: string) => {
      const w = p.walls.find((x) => x.id === id)!;
      const a = p.nodes.find((n) => n.id === w.a)!;
      const c = p.nodes.find((n) => n.id === w.b)!;
      const L = Math.hypot(c.x - a.x, c.y - a.y);
      return { x: (c.x - a.x) / L, y: (c.y - a.y) / L };
    };
    const u = dir(w2);
    const v = dir(w3);
    expect(Math.abs(u.x * v.x + u.y * v.y)).toBeLessThan(1e-4);
  });
});
