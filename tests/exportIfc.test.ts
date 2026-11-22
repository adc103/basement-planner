import { describe, expect, it } from 'vitest';
import * as WebIFC from 'web-ifc';
import { CommandBus } from '../src/core/commands';
import { exportIfc, ifcGuid } from '../src/core/exportIfc';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';

function sample() {
  const b = new CommandBus(new PlanStore(createEmptyPlan()));
  b.run('plan.rename', { name: "Alec's basement" });
  const pts = [
    { x: 0, y: 0 },
    { x: 240, y: 0 },
    { x: 240, y: 144 },
    { x: 0, y: 144 },
  ];
  const ids = pts.map((p, i) => b.run('wall.add', { a: p, b: pts[(i + 1) % 4], kind: 'existing', thickness: 8 })!);
  const part = b.run('wall.add', { a: { x: 120, y: 0 }, b: { x: 120, y: 144 } })!;
  b.run('opening.add', { wallId: part, type: 'door', offset: 40, width: 32, height: 80 });
  b.run('opening.add', { wallId: ids[2], type: 'window', offset: 60, width: 36, height: 24, sill: 54 });
  b.run('wall.setDemolish', { id: ids[1], demolish: true });
  b.run('room.add', { seed: { x: 60, y: 70 }, name: 'Office' });
  b.run('box.add', { poly: [{ x: 150, y: 100 }, { x: 198, y: 100 }, { x: 198, y: 118 }, { x: 150, y: 118 }], z1: 18, label: 'Bench' });
  b.run('soffit.add', { poly: [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 22 }, { x: 10, y: 22 }], bottom: 84 });
  return b.store.plan;
}

describe('IFC export', () => {
  it('makes stable, valid 22-character ids', () => {
    expect(ifcGuid('wall:w1')).toBe(ifcGuid('wall:w1'));
    expect(ifcGuid('wall:w1')).not.toBe(ifcGuid('wall:w2'));
    expect(ifcGuid('x')).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  });

  it('opens in web-ifc (the engine behind most web BIM viewers) with real geometry', async () => {
    const plan = sample();
    const text = exportIfc(plan);
    const api = new WebIFC.IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(text));
    const count = (t: number) => api.GetLineIDsWithType(model, t).size();
    expect(count(WebIFC.IFCWALL)).toBe(plan.walls.length);
    expect(count(WebIFC.IFCDOOR)).toBe(1);
    expect(count(WebIFC.IFCWINDOW)).toBe(1);
    expect(count(WebIFC.IFCOPENINGELEMENT)).toBe(2);
    expect(count(WebIFC.IFCSPACE)).toBe(1);
    expect(count(WebIFC.IFCBUILDINGSTOREY)).toBe(1);
    expect(count(WebIFC.IFCBUILDINGELEMENTPROXY)).toBe(2); // the soffit and the bench
    // Every wall, door and window turns into triangles.
    let meshes = 0;
    let tris = 0;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    api.StreamAllMeshes(model, (m) => {
      meshes++;
      for (let i = 0; i < m.geometries.size(); i++) {
        const pg = m.geometries.get(i);
        const g = api.GetGeometry(model, pg.geometryExpressID);
        tris += g.GetIndexDataSize() / 3;
        const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const T = pg.flatTransformation;
        for (let k = 0; k < v.length; k += 6) {
          const x = v[k], y = v[k + 1], z = v[k + 2];
          const w = [T[0] * x + T[4] * y + T[8] * z + T[12], T[1] * x + T[5] * y + T[9] * z + T[13], T[2] * x + T[6] * y + T[10] * z + T[14]];
          for (let c = 0; c < 3; c++) [lo[c], hi[c]] = [Math.min(lo[c], w[c]), Math.max(hi[c], w[c])];
        }
      }
    });
    // Outside of the 8" walls: 248" x 152" footprint, 96" tall (web-ifc's viewer frame is y up).
    const size = hi.map((h, c) => (h - lo[c]) / 0.0254).sort((a, b) => a - b);
    expect(size[0]).toBeCloseTo(96, 0);
    expect(size[1]).toBeCloseTo(152, 0);
    expect(size[2]).toBeCloseTo(248, 0);
    expect(meshes).toBeGreaterThanOrEqual(plan.walls.length + 2);
    expect(tris).toBeGreaterThan(100);
    const props = api.GetLineIDsWithType(model, WebIFC.IFCPROPERTYSINGLEVALUE);
    const names = new Set<string>();
    for (let i = 0; i < props.size(); i++) names.add(api.GetLine(model, props.get(i)).Name.value);
    expect(names.has('Phase')).toBe(true);
    expect(text).toContain("IFCLABEL('demolish')");
    expect(text).toContain("'Alec''s basement'");
    api.CloseModel(model);
  }, 30_000);
});
