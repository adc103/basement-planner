import { describe, expect, it } from 'vitest';
import { IDENTITY, planToWorld, solveTwoPoint, worldToPlan, type PlanTransform } from '../src/core/alignment';
import { loadSavedPlan, planFromJson, planToJson, savePlan, type KV } from '../src/core/persistence';
import { createEmptyPlan } from '../src/core/plan';

describe('plan <-> world', () => {
  it('inverts', () => {
    const t: PlanTransform = { theta: 0.7, tx: 1.2, tz: -3.4 };
    const p = { x: 37, y: -120 };
    const back = worldToPlan(t, planToWorld(t, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('identity maps inches to meters', () => {
    expect(planToWorld(IDENTITY, { x: 100, y: 0 }).x).toBeCloseTo(2.54);
  });
});

describe('two-point alignment', () => {
  const truth: PlanTransform = { theta: 1.1, tx: -0.8, tz: 2.3 };
  const r1 = { x: 0, y: 0 };
  const r2 = { x: 240, y: 36 };

  it('recovers an exact transform', () => {
    const sol = solveTwoPoint(r1, r2, planToWorld(truth, r1), planToWorld(truth, r2))!;
    expect(sol.transform.theta).toBeCloseTo(truth.theta, 9);
    expect(sol.transform.tx).toBeCloseTo(truth.tx, 9);
    expect(sol.transform.tz).toBeCloseTo(truth.tz, 9);
    expect(sol.residual).toBeCloseTo(0, 6);
  });

  it('splits a clicking error between the two corners and reports it', () => {
    const w1 = planToWorld(truth, r1);
    const w2 = planToWorld(truth, r2);
    // Second click lands 1" long along the reference direction.
    const dirx = w2.x - w1.x;
    const dirz = w2.z - w1.z;
    const l = Math.hypot(dirx, dirz);
    const w2b = { x: w2.x + (dirx / l) * 0.0254, z: w2.z + (dirz / l) * 0.0254 };
    const sol = solveTwoPoint(r1, r2, w1, w2b)!;
    expect(sol.spanError).toBeCloseTo(1, 6);
    expect(sol.residual).toBeCloseTo(0.5, 6);
    // A point in the middle of the plan lands within half an inch.
    const mid = { x: 120, y: 18 };
    const a = planToWorld(truth, mid);
    const b = planToWorld(sol.transform, mid);
    expect(Math.hypot(a.x - b.x, a.z - b.z) / 0.0254).toBeLessThan(0.5);
  });

  it('rejects corners that are too close together', () => {
    expect(solveTwoPoint(r1, { x: 2, y: 0 }, { x: 0, z: 0 }, { x: 0.05, z: 0 })).toBeNull();
  });
});

describe('persistence', () => {
  class Mem implements KV {
    m = new Map<string, string>();
    getItem(k: string) {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
  }

  it('saves and restores', () => {
    const kv = new Mem();
    const p = createEmptyPlan();
    p.name = 'Test';
    expect(savePlan(p, kv)).toBe(true);
    const { plan, restored } = loadSavedPlan(kv);
    expect(restored).toBe(true);
    expect(plan.name).toBe('Test');
  });

  it('starts fresh when the saved data is corrupt', () => {
    const kv = new Mem();
    kv.setItem('basement-planner:plan:v1', '{nope');
    expect(loadSavedPlan(kv).restored).toBe(false);
  });

  it('exports and imports JSON', () => {
    const p = createEmptyPlan();
    expect(planFromJson(planToJson(p))).toEqual(p);
    expect(() => planFromJson('not json')).toThrow(/not JSON/);
  });
});
