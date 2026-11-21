import { describe, expect, it } from 'vitest';
import { createEmptyPlan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import { addMarker, addOpening, addWallBetween, replaceExistingWalls, upsertRoom } from '../src/core/ops';
import { renderPlanSvg, roomSummaries } from '../src/core/plan2d';

function sample(): PlanStore {
  const s = new PlanStore(createEmptyPlan());
  s.edit('room', (d) => {
    const P = [
      { x: 0, y: 0 },
      { x: 144, y: 0 },
      { x: 144, y: 120 },
      { x: 0, y: 120 },
    ];
    const ids = P.map((p, i) => addWallBetween(d, p, P[(i + 1) % 4], { height: 96, thickness: 4.5 })!);
    addOpening(d, { wallId: ids[0], type: 'door', offset: 72, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
    upsertRoom(d, { x: 70, y: 60 }, { name: 'Bedroom', finish: 'carpet' });
    addMarker(d, { type: 'outlet', x: 2.25, y: 60, z: 12, wallId: null, note: '' });
    replaceExistingWalls(d, [{ a: { x: -20, y: -20 }, b: { x: 200, y: -20 } }], 96);
  });
  return s;
}

describe('2D plan', () => {
  it('draws walls, a door swing, dimensions, the room and pins', () => {
    const svg = renderPlanSvg(sample().plan, { title: 'Basement' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Bedroom');
    expect(svg).toContain('Carpet');
    expect(svg).toMatch(/\d+ sq ft/);
    expect(svg).toContain("12' 0&quot;"); // 144" wall dimension
    expect(svg).toContain(' A 32 32 '); // door swing arc
    expect(svg).toContain('url(#hatch)'); // scanned wall
    expect(svg).toContain('>O<'); // outlet pin
    // Door leaves a gap: the wall with the door is split in two base pieces.
    expect((svg.match(/fill="#2b3440" stroke="#2b3440"/g) ?? []).length).toBe(5);
  });

  it('handles an empty plan', () => {
    expect(renderPlanSvg(createEmptyPlan())).toContain('Nothing drawn yet');
  });

  it('escapes text', () => {
    const s = sample();
    s.edit('n', (d) => {
      d.rooms[0].name = 'Kid <room> & "den"';
    });
    expect(renderPlanSvg(s.plan)).toContain('Kid &lt;room&gt; &amp; &quot;den&quot;');
  });

  it('summarizes rooms', () => {
    const r = roomSummaries(sample().plan);
    expect(r).toHaveLength(1);
    expect(r[0].areaSqFt).toBeCloseTo((139.5 * 115.5) / 144, 6);
  });
});
