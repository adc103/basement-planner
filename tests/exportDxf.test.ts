import DxfParser from 'dxf-parser';
import { describe, expect, it } from 'vitest';
import { CommandBus } from '../src/core/commands';
import { exportDxf } from '../src/core/exportDxf';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';

describe('DXF export', () => {
  const b = new CommandBus(new PlanStore(createEmptyPlan()));
  const pts = [
    { x: 0, y: 0 },
    { x: 240, y: 0 },
    { x: 240, y: 144 },
    { x: 0, y: 144 },
  ];
  const ids = pts.map((p, i) => b.run('wall.add', { a: p, b: pts[(i + 1) % 4], kind: 'existing', thickness: 8 })!);
  const part = b.run('wall.add', { a: { x: 120, y: 0 }, b: { x: 120, y: 144 } })!;
  const hall = b.run('wall.add', { a: { x: 156, y: 0 }, b: { x: 156, y: 144 } })!;
  b.run('constraint.add', { type: 'distance', a: part, b: hall, value: 31.5 });
  b.run('opening.add', { wallId: part, type: 'door', offset: 40, width: 32, height: 80 });
  b.run('opening.add', { wallId: ids[2], type: 'window', offset: 60, width: 36, height: 24, sill: 54 });
  b.run('wall.setDemolish', { id: ids[1], demolish: true });
  b.run('room.add', { seed: { x: 60, y: 70 }, name: 'Office' });
  const dxf = exportDxf(b.store.plan);
  const doc = new DxfParser().parseSync(dxf)!;

  it('parses, in inches, with a layer for each kind of thing', () => {
    expect(doc.header.$INSUNITS).toBe(1);
    expect(Object.keys(doc.tables.layer.layers)).toEqual(expect.arrayContaining(['WALLS-NEW', 'WALLS-EXISTING', 'WALLS-DEMOLISH', 'DOORS', 'WINDOWS', 'ROOMS', 'DIMENSIONS']));
  });

  it('draws walls 1:1, split at the door, demolished on their own layer', () => {
    const by = (layer: string, type: string) => doc.entities.filter((e) => e.layer === layer && e.type === type);
    expect(by('WALLS-DEMOLISH', 'LWPOLYLINE')).toHaveLength(1);
    // The partition is split by the door into two closed pieces.
    const newWalls = by('WALLS-NEW', 'LWPOLYLINE') as Array<{ vertices: Array<{ x: number; y: number }> }>;
    expect(newWalls.length).toBe(3);
    const xs = newWalls.flatMap((e) => e.vertices.map((v) => v.x));
    expect(Math.min(...xs)).toBeCloseTo(117.75, 2);
    // y is flipped: plan y = 144 is drawing y = -144.
    const all = doc.entities.filter((e) => e.type === 'LWPOLYLINE').flatMap((e) => (e as { vertices: Array<{ y: number }> }).vertices.map((v) => v.y));
    expect(Math.min(...all)).toBeCloseTo(-148, 1);
  });

  it('has the door swing, the window, the room name and the kept distance', () => {
    expect(doc.entities.some((e) => e.type === 'ARC' && e.layer === 'DOORS' && Math.abs((e as { radius: number }).radius - 32) < 1e-6)).toBe(true);
    expect(doc.entities.filter((e) => e.layer === 'WINDOWS')).toHaveLength(3);
    const texts = doc.entities.filter((e) => e.type === 'TEXT').map((e) => (e as { text: string }).text);
    expect(texts).toContain('Office');
    expect(texts.some((t) => /2' 7 1\/2" clear, kept/.test(t))).toBe(true);
  });
});
