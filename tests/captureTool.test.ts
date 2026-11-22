import { describe, expect, it } from 'vitest';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { CommandBus } from '../src/core/commands';
import { defaultSnapOptions } from '../src/core/snapping';
import { CaptureTool, type CaptureContext } from '../src/xr/tools/captureTool';
import type { AimHit } from '../src/xr/tools/tool';
import type { PP } from '../src/core/wallDetect';

const noop = () => {};
const fakePreview = new Proxy({}, { get: () => noop });

function setup(mesh: PP[] | null) {
  const store = new PlanStore(createEmptyPlan());
  const toasts: string[] = [];
  const cmd = new CommandBus(store);
  const ctx = {
    store,
    cmd,
    act: (n: never, p: never) => cmd.run(n, p),
    view: fakePreview,
    preview: fakePreview,
    toast: (m: string) => toasts.push(m),
    snapOptions: () => defaultSnapOptions,
    openKeypad: noop,
    openingPreset: () => ({ type: 'door', width: 32, height: 80 }),
    refreshUi: noop,
    roomMeshPoints: () => mesh,
  } as unknown as CaptureContext;
  return { store, toasts, tool: new CaptureTool(ctx) };
}

/** Aim at the wall surface y = 100 (facing -y) at x. */
const aimAt = (x: number, jitter = 0): AimHit => ({
  floor: null,
  floorDistM: 0,
  wall: null,
  marker: null,
  surface: { p: { x, y: 100 + jitter }, z: 48, n: { x: 0.05, y: -0.95 }, ny: 0.1, distM: 1.5 },
  ceiling: null,
  fine: false,
  pressing: true,
  eye: { x: 50, y: 0 },
});

describe('capture tool', () => {
  it('adds a wall from a sweep along it', () => {
    const { store, tool } = setup(null);
    tool.pressStart(aimAt(10));
    for (let x = 12; x <= 90; x += 3) tool.drag(aimAt(x, (x % 7) * 0.05));
    tool.commit(aimAt(90));
    expect(store.plan.walls).toHaveLength(1);
    const w = store.plan.walls[0];
    expect(w.kind).toBe('existing');
    expect(w.source).toBe('capture');
    const [a, b] = [w.a, w.b].map((id) => store.plan.nodes.find((n) => n.id === id)!);
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(78);
    // Centerline 2.25" behind the surface (4.5" capture thickness).
    expect((a.y + b.y) / 2).toBeCloseTo(102.25, 0);
  });

  it('proposes a wall from the room mesh on a tap and adds it on a second tap', () => {
    const mesh: PP[] = [];
    for (let x = 0; x <= 150; x += 3) for (let z = 0; z <= 96; z += 6) mesh.push({ x, y: 100, z });
    const { store, tool } = setup(mesh);
    tool.pressStart(aimAt(40));
    tool.commit(aimAt(40));
    expect(tool.proposal).not.toBeNull();
    expect(store.plan.walls).toHaveLength(0);
    tool.pressStart(aimAt(120));
    tool.commit(aimAt(120));
    expect(tool.proposal).toBeNull();
    expect(store.plan.walls).toHaveLength(1);
    const w = store.plan.walls[0];
    const [a, b] = [w.a, w.b].map((id) => store.plan.nodes.find((n) => n.id === id)!);
    expect(Math.abs(b.x - a.x)).toBeCloseTo(150, 0);
  });

  it('explains what to do when there is no room mesh', () => {
    const { tool, toasts } = setup(null);
    tool.pressStart(aimAt(40));
    tool.commit(aimAt(40));
    expect(toasts.at(-1)).toMatch(/sweep/);
  });
});
