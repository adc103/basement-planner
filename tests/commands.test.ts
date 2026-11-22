import { describe, expect, it } from 'vitest';
import { COMMANDS, CommandBus, describePlan, toolSpecs } from '../src/core/commands';
import { createEmptyPlan, parsePlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';

function bus() {
  return new CommandBus(new PlanStore(createEmptyPlan()));
}

function square(b: CommandBus, s = 120) {
  const pts = [
    { x: 0, y: 0 },
    { x: s, y: 0 },
    { x: s, y: s },
    { x: 0, y: s },
  ];
  return pts.map((p, i) => b.run('wall.add', { a: p, b: pts[(i + 1) % 4] })!);
}

describe('command layer', () => {
  it('adds walls with plan defaults and one undo step each', () => {
    const b = bus();
    const ids = square(b);
    expect(ids.every(Boolean)).toBe(true);
    const w = b.store.plan.walls[0];
    expect(w.height).toBe(96);
    expect(w.thickness).toBe(4.5);
    expect(w.evidence).toBe('manual');
    expect(b.store.plan.nodes).toHaveLength(4);
    b.store.undo();
    expect(b.store.plan.walls).toHaveLength(3);
    expect(b.journal).toHaveLength(4);
  });

  it('refuses bad input without changing anything', () => {
    const b = bus();
    const before = b.store.plan;
    const r = b.exec('wall.add', { a: { x: 0, y: 0 }, b: { x: 0.1, y: 0 } });
    expect(r.ok).toBe(false);
    expect(b.store.plan).toBe(before);
    expect(b.exec('wall.setHeight', { id: 'nope', height: 80 }).ok).toBe(false);
    expect(b.exec('wall.setHeight', { id: 'x', height: -3 } as never).ok).toBe(false);
    expect(b.exec('settings.set', { values: { bogus: 1 } }).ok).toBe(false);
    expect(b.exec('settings.set', { values: { wallHeight: 'tall' } }).ok).toBe(false);
    expect(b.journal.filter((e) => !e.ok)).toHaveLength(5);
  });

  it('locks protect walls, their corners and their openings', () => {
    const b = bus();
    const [w0, w1] = square(b);
    const door = b.run('opening.add', { wallId: w0, type: 'door', offset: 60, width: 32, height: 80 })!;
    expect(door).toBeTruthy();
    b.run('element.setLocked', { id: w0, locked: true });
    expect(b.exec('wall.setHeight', { id: w0, height: 80 })).toEqual({ ok: false, error: 'That wall is locked' });
    // w1 shares a corner with the locked wall: it can't be dragged away from it.
    const shared = b.store.plan.walls.find((w) => w.id === w1)!.a;
    expect(b.exec('node.move', { id: shared, x: 130, y: 0 }).ok).toBe(false);
    expect(b.exec('element.delete', { id: w0 }).ok).toBe(false);
    // Locking an opening protects it inside an unlocked wall.
    b.run('element.setLocked', { id: w0, locked: false });
    b.run('element.setLocked', { id: door, locked: true });
    expect(b.exec('element.delete', { id: w0 }).ok).toBe(false);
    expect(b.exec('opening.update', { id: door, width: 36 }).ok).toBe(false);
  });

  it('marks real walls for demolition, not planned ones', () => {
    const b = bus();
    const real = b.run('wall.add', { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: 'existing' })!;
    const planned = b.run('wall.add', { a: { x: 0, y: 50 }, b: { x: 100, y: 50 } })!;
    expect(b.exec('wall.setDemolish', { id: real, demolish: true }).ok).toBe(true);
    expect(b.exec('wall.setDemolish', { id: planned, demolish: true }).ok).toBe(false);
    expect((describePlan(b.store.plan) as { walls: Array<{ phase: string }> }).walls.map((w) => w.phase)).toEqual(['demolish', 'new']);
    // Turning it into a planned wall clears the demolition mark.
    b.run('wall.setKind', { id: real, kind: 'new' });
    expect(b.store.plan.walls[0].demolish).toBe(false);
  });

  it('checks openings still fit when changed', () => {
    const b = bus();
    const [w0] = square(b, 60);
    const o = b.run('opening.add', { wallId: w0, type: 'door', offset: 30, width: 30, height: 80 })!;
    expect(b.exec('opening.update', { id: o, width: 70 }).ok).toBe(false);
    expect(b.store.plan.openings[0].width).toBe(30);
    expect(b.exec('opening.update', { id: o, type: 'window', sill: 40, height: 60 }).ok).toBe(false);
    expect(b.exec('opening.update', { id: o, type: 'window', sill: 40, height: 36 }).ok).toBe(true);
    expect(b.store.plan.openings[0]).toMatchObject({ type: 'window', sill: 40, height: 36 });
  });

  it('previews without committing', () => {
    const b = bus();
    square(b);
    const before = b.store.plan;
    const p = b.preview('wall.add', { a: { x: 60, y: 0 }, b: { x: 60, y: 120 } });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.plan.walls.length).toBeGreaterThan(before.walls.length);
    expect(b.store.plan).toBe(before);
  });

  it('publishes every public command as a JSON-schema tool', () => {
    const specs = toolSpecs();
    expect(specs.length).toBeGreaterThan(20);
    expect(specs.find((s) => s.name.startsWith('scan.'))).toBeUndefined();
    const add = specs.find((s) => s.name === 'wall.add')!;
    expect(add.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] });
    for (const s of specs) expect(JSON.stringify(s.inputSchema).length).toBeGreaterThan(10);
    expect(Object.keys(COMMANDS)).toContain('element.setLocked');
  });

  it('opens version 1 plan files', () => {
    const v1 = {
      format: 'basement-planner',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      settings: {},
      nodes: [
        { id: 'n1', x: 0, y: 0 },
        { id: 'n2', x: 100, y: 0 },
      ],
      walls: [{ id: 'w1', a: 'n1', b: 'n2', height: 96, thickness: 8, kind: 'existing', source: 'scan' }],
      openings: [{ id: 'o1', wallId: 'w1', type: 'door', offset: 50, width: 32, height: 80 }],
    };
    const p = parsePlan(v1);
    expect(p.version).toBe(2);
    expect(p.levels).toHaveLength(1);
    expect(p.walls[0]).toMatchObject({ evidence: 'measured', locked: false, demolish: false, level: 'L1' });
    expect(p.openings[0].kind).toBe('existing');
  });
});
