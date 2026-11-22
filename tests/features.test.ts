import { describe, expect, it } from 'vitest';
import { createEmptyPlan, parsePlan, type Plan } from '../src/core/plan';
import { PlanStore } from '../src/core/store';
import {
  addMarker,
  addMeasure,
  addOpening,
  addWallBetween,
  deleteWall,
  moveNode,
  moveOpening,
  replaceExistingWalls,
  setObstacles,
  upsertRoom,
  wallLength,
} from '../src/core/ops';
import { convexHull, pointInPolygon, segmentHitsPolygon } from '../src/core/poly';
import { faceAt, findRoomFaces, resolveRooms } from '../src/core/rooms';
import { frameWall, generateFraming, summarizeFraming } from '../src/core/framing';
import { computeFootprints } from '../src/core/wallGeometry';
import { obstaclesFromScan, scanSignature, type P3 } from '../src/core/roomScan';
import { defaultSnapOptions, snap } from '../src/core/snapping';

const props = { height: 96, thickness: 4 };
const mk = (fn: (s: PlanStore) => void): PlanStore => {
  const s = new PlanStore(createEmptyPlan());
  fn(s);
  return s;
};
/** A closed W x H rectangle of walls starting at (x0,y0). */
const box = (s: PlanStore, x0: number, y0: number, w: number, h: number, t = 4) =>
  s.edit('box', (d) => {
    const P = [
      { x: x0, y: y0 },
      { x: x0 + w, y: y0 },
      { x: x0 + w, y: y0 + h },
      { x: x0, y: y0 + h },
    ];
    for (let i = 0; i < 4; i++) addWallBetween(d, P[i], P[(i + 1) % 4], { height: 96, thickness: t });
  });

describe('polygons', () => {
  it('builds a convex hull', () => {
    const h = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 3, y: 4 },
    ]);
    expect(h).toHaveLength(4);
  });
  it('tests points and segments', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
    expect(segmentHitsPolygon({ x: -5, y: 5 }, { x: 15, y: 5 }, sq)).toBe(true);
    expect(segmentHitsPolygon({ x: -5, y: 15 }, { x: 15, y: 15 }, sq)).toBe(false);
  });
});

describe('rooms', () => {
  it('finds a closed room and its clear floor area', () => {
    const s = mk((s) => box(s, 0, 0, 144, 120));
    const faces = findRoomFaces(s.plan);
    expect(faces).toHaveLength(1);
    // Inside the 4" walls: (144-4) x (120-4) = 140 x 116 sq in.
    expect(faces[0].areaSqFt).toBeCloseTo((140 * 116) / 144, 6);
    expect(faces[0].center.x).toBeCloseTo(72);
  });

  it('ignores open shapes and dead-end walls', () => {
    const s = mk((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 100, y: 0 }, props);
        addWallBetween(d, { x: 100, y: 0 }, { x: 100, y: 100 }, props);
      }),
    );
    expect(findRoomFaces(s.plan)).toHaveLength(0);
    const closed = mk((s) => {
      box(s, 0, 0, 100, 100);
      s.edit('spur', (d) => addWallBetween(d, { x: 50, y: 0 }, { x: 50, y: 30 }, props));
    });
    expect(findRoomFaces(closed.plan)).toHaveLength(1);
  });

  it('splits a box into two rooms with a dividing wall', () => {
    const s = mk((s) => {
      box(s, 0, 0, 200, 100);
      s.edit('div', (d) => addWallBetween(d, { x: 120, y: 0 }, { x: 120, y: 100 }, props));
    });
    const faces = findRoomFaces(s.plan);
    expect(faces).toHaveLength(2);
    const left = faceAt(faces, { x: 50, y: 50 })!;
    const right = faceAt(faces, { x: 160, y: 50 })!;
    expect(left.areaSqFt).toBeCloseTo((116 * 96) / 144, 6);
    expect(right.areaSqFt).toBeCloseTo((76 * 96) / 144, 6);
  });

  it('subtracts rooms inside a bigger area and labels the open floor', () => {
    const s = mk((s) => {
      box(s, 0, 0, 400, 300);
      box(s, 50, 50, 100, 100);
    });
    const faces = findRoomFaces(s.plan);
    expect(faces).toHaveLength(2);
    const outer = faces.find((f) => f.areaSqFt > 100)!;
    // (396 x 296) minus the inner box grown to its outside faces (104 x 104).
    expect(outer.areaSqFt).toBeCloseTo((396 * 296 - 104 * 104) / 144, 6);
    // Label is not inside the inner room.
    expect(outer.center.x < 48 || outer.center.x > 152 || outer.center.y < 48 || outer.center.y > 152).toBe(true);
  });

  it('keeps a named room attached to its walls after edits', () => {
    const s = mk((s) => box(s, 0, 0, 144, 120));
    s.edit('name', (d) => upsertRoom(d, { x: 50, y: 50 }, { name: 'Bedroom', finish: 'carpet' }));
    let r = resolveRooms(s.plan)[0];
    expect(r.room.name).toBe('Bedroom');
    expect(r.face).not.toBeNull();
    s.edit('open', (d) => deleteWall(d, d.walls[0].id));
    r = resolveRooms(s.plan)[0];
    expect(r.face).toBeNull();
  });
});

describe('framing', () => {
  it('frames corners and tees the way a framer would', () => {
    // An L (120" x 96") plus a tee wall ending on the middle of the long wall.
    const s = mk((s) =>
      s.edit('w', (d) => {
        addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, { height: 96, thickness: 4.5 });
        addWallBetween(d, { x: 120, y: 0 }, { x: 120, y: 96 }, { height: 96, thickness: 4.5 });
        addWallBetween(d, { x: 60, y: 0 }, { x: 60, y: 60 }, { height: 96, thickness: 4.5 });
      }),
    );
    const m = generateFraming(s.plan);
    const byWall = new Map<string, typeof m>();
    for (const x of m) byWall.set(x.wallId, [...(byWall.get(x.wallId) ?? []), x]);
    const walls = s.plan.walls;
    // the long wall was split at the tee: both halves get a backing stud beside the tee wall
    const halves = walls.filter((w) => {
      const a = s.plan.nodes.find((n) => n.id === w.a)!;
      const b = s.plan.nodes.find((n) => n.id === w.b)!;
      return a.y === 0 && b.y === 0;
    });
    expect(halves).toHaveLength(2);
    for (const h of halves) {
      const studs = byWall.get(h.id)!.filter((x) => x.kind === 'stud').map((x) => x.s);
      const L = 60;
      const tee = h.a === walls.find((w) => w.a === h.b || w.b === h.b)?.b ? L : 0;
      void tee;
      // a stud 2.25 + 0.75 in from the tee on this half
      expect(studs.some((v) => Math.abs(v - 3) < 0.01 || Math.abs(v - (L - 3)) < 0.01)).toBe(true);
    }
    // the tee wall butts into the long wall's face: its framing starts 2.25" off the centerline
    const tee = walls.find((w) => {
      const a = s.plan.nodes.find((n) => n.id === w.a)!;
      const b = s.plan.nodes.find((n) => n.id === w.b)!;
      return a.x === 60 && b.x === 60;
    })!;
    const plates = byWall.get(tee.id)!.filter((x) => x.kind === 'plate' && x.z0 === 0);
    const lo = Math.min(...plates.map((p) => p.s - p.len / 2));
    expect(lo).toBeCloseTo(2.25, 5);
    // no two studs on one wall closer than 3" (no wasted, crowded studs) except kings/jacks
    for (const list of byWall.values()) {
      const ss = list.filter((x) => x.kind === 'stud').map((x) => x.s).sort((a, b) => a - b);
      for (let i = 1; i < ss.length; i++) expect(ss[i] - ss[i - 1]).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('frames a plain 8 ft wall at 16" on center', () => {
    const s = mk((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 96, y: 0 }, { height: 96, thickness: 4.5 })));
    const m = generateFraming(s.plan);
    const studs = m.filter((x) => x.kind === 'stud');
    // Free ends extend 2.25" past the nodes: a 100.5" wall. Layout is measured from its
    // end so 4 ft sheets break on studs: ends + 16,32,48,64,80,96 from the end = 8 studs.
    expect(studs).toHaveLength(8);
    const s0 = Math.min(...studs.map((x) => x.s)) - 0.75;
    const layout = studs.map((x) => x.s - s0).filter((v) => v > 2 && v < 99);
    for (const v of layout) expect(v % 16).toBeCloseTo(0, 5);
    expect(m.filter((x) => x.kind === 'plate')).toHaveLength(3); // bottom + double top
    for (const st of studs) expect(st.z1).toBeCloseTo(96 - 3);
  });

  it('adds kings, jacks and a header around a door and breaks the bottom plate', () => {
    const s = mk((s) =>
      s.edit('w', (d) => {
        const id = addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, { height: 96, thickness: 4.5 })!;
        addOpening(d, { wallId: id, type: 'door', offset: 60, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      }),
    );
    const w = s.plan.walls[0];
    const m = frameWall(w, computeFootprints(s.plan).get(w.id)!, s.plan.openings);
    expect(m.filter((x) => x.kind === 'king')).toHaveLength(2);
    expect(m.filter((x) => x.kind === 'jack')).toHaveLength(2);
    const header = m.find((x) => x.kind === 'header')!;
    expect(header.z0).toBeCloseTo(80);
    expect(header.len).toBeCloseTo(35);
    // No stud inside the rough opening.
    for (const st of m.filter((x) => x.kind === 'stud')) expect(st.s < 44 - 3 || st.s > 76 + 3).toBe(true);
    // Bottom plate is two pieces, none across the door.
    const bottoms = m.filter((x) => x.kind === 'plate' && x.z0 === 0);
    expect(bottoms).toHaveLength(2);
    expect(summarizeFraming(m).headers).toBe(1);
  });

  it('uses 5.5" studs for 2x6 walls', () => {
    const s = mk((s) => s.edit('w', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 50, y: 0 }, { height: 96, thickness: 6.5 })));
    s.edit('t', (d) => {
      d.walls[0].framing.studSize = '2x6';
    });
    expect(generateFraming(s.plan)[0].depth).toBe(5.5);
  });
});

describe('editing', () => {
  it('moves a corner and keeps openings inside their walls', () => {
    const s = mk((s) =>
      s.edit('w', (d) => {
        const id = addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, props)!;
        addOpening(d, { wallId: id, type: 'door', offset: 100, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      }),
    );
    const nodeB = s.plan.walls[0].b;
    s.edit('move', (d) => moveNode(d, nodeB, { x: 80, y: 0 }));
    expect(wallLength(s.plan, s.plan.walls[0])).toBe(80);
    expect(s.plan.openings[0].offset).toBeCloseTo(80 - 16 - 1.5);
  });

  it('slides a door but not past the wall end', () => {
    const s = mk((s) =>
      s.edit('w', (d) => {
        const id = addWallBetween(d, { x: 0, y: 0 }, { x: 120, y: 0 }, props)!;
        addOpening(d, { wallId: id, type: 'door', offset: 30, width: 32, height: 80, sill: 0, hinge: 'a', swing: 'left' });
      }),
    );
    const id = s.plan.openings[0].id;
    s.edit('slide', (d) => moveOpening(d, id, 70));
    expect(s.plan.openings[0].offset).toBe(70);
    s.edit('slide', (d) => moveOpening(d, id, 500));
    expect(s.plan.openings[0].offset).toBeCloseTo(120 - 16 - 1.5);
  });

  it('snaps a dragged corner without snapping to itself', () => {
    const s = mk((s) => box(s, 0, 0, 100, 100));
    const n = s.plan.nodes.find((x) => x.x === 100 && x.y === 100)!;
    const r = snap(s.plan, { x: 100.5, y: 100.2 }, { ...defaultSnapOptions, excludeNodeId: n.id });
    expect(r.targetId).not.toBe(n.id);
  });

  it('keeps captured walls when a new scan is imported', () => {
    const s = mk(() => {});
    s.edit('cap', (d) => addWallBetween(d, { x: 0, y: 0 }, { x: 50, y: 0 }, { height: 96, thickness: 4.5, kind: 'existing', source: 'capture' }));
    s.edit('scan', (d) => replaceExistingWalls(d, [{ a: { x: 0, y: 100 }, b: { x: 200, y: 100 } }], 96));
    expect(s.plan.walls.map((w) => w.source).sort()).toEqual(['capture', 'scan']);
  });

  it('stores markers, measures and obstacles and survives JSON', () => {
    const s = mk(() => {});
    s.edit('x', (d) => {
      addMarker(d, { type: 'outlet', x: 1, y: 2, z: 12, wallId: null, note: '' });
      addMeasure(d, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
      setObstacles(d, [{ label: 'storage', poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], height: 30, source: 'scan' }]);
    });
    const again: Plan = parsePlan(JSON.parse(JSON.stringify(s.plan)));
    expect(again.markers).toHaveLength(1);
    expect(again.measures).toHaveLength(1);
    expect(again.obstacles).toHaveLength(1);
  });

  it('loads v1 plans saved before these features', () => {
    const old = createEmptyPlan() as unknown as Record<string, unknown>;
    delete old.obstacles;
    delete old.markers;
    delete old.rooms;
    delete old.measures;
    const p = parsePlan(old);
    expect(p.rooms).toEqual([]);
    expect(p.settings.autoImportScan).toBe(true);
  });

  it('snaps to scanned object corners', () => {
    const s = mk(() => {});
    s.edit('o', (d) => setObstacles(d, [{ label: 'other', poly: [{ x: 50, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 70 }, { x: 50, y: 70 }], height: 60, source: 'scan' }]));
    const r = snap(s.plan, { x: 81, y: 49.5 }, { ...defaultSnapOptions });
    expect(r.kind).toBe('endpoint');
    expect(r.point).toEqual({ x: 80, y: 50 });
  });
});

describe('scan objects', () => {
  const toPlan = (w: P3) => ({ p: { x: w.x / 0.0254, y: w.z / 0.0254 }, y: w.y });
  const cube = (x: number, z: number, sx: number, sz: number, h: number): P3[] => {
    const c: P3[] = [];
    for (const dx of [0, sx]) for (const dz of [0, sz]) for (const y of [0, h]) c.push({ x: x + dx, y, z: z + dz });
    return c;
  };

  it('makes footprints for furniture boxes and skips structure', () => {
    const obs = obstaclesFromScan(
      [
        { label: 'storage', corners: cube(1, 1, 0.6, 0.5, 1.2) },
        { label: 'wall', corners: cube(0, 0, 4, 0.1, 2.4) },
        { label: 'global mesh', corners: cube(0, 0, 5, 5, 2.4) },
      ],
      toPlan,
      0,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].poly).toHaveLength(4);
    expect(obs[0].height).toBeCloseTo(1.2 / 0.0254);
  });

  it('gives the same signature for the same scan', () => {
    const w = [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }];
    expect(scanSignature(w, [])).toBe(scanSignature([{ a: { x: 0.4, y: 0 }, b: { x: 100, y: 0.4 } }], []));
    expect(scanSignature(w, [])).not.toBe(scanSignature([{ a: { x: 0, y: 0 }, b: { x: 150, y: 0 } }], []));
  });
});

describe('ceiling', () => {
  it('stores soffits and per-room ceiling overrides', async () => {
    const { addSoffit, roomCeiling } = await import('../src/core/ops');
    const s = mk((s) => box(s, 0, 0, 144, 120));
    s.edit('sf', (d) => addSoffit(d, [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 22 }, { x: 10, y: 22 }], 84));
    s.edit('room', (d) => upsertRoom(d, { x: 50, y: 50 }, { name: 'Theater', ceilingType: 'drop', ceilingHeight: 90 }));
    expect(s.plan.soffits).toHaveLength(1);
    const r = s.plan.rooms[0];
    expect(roomCeiling(s.plan, r)).toEqual({ height: 90, type: 'drop' });
    expect(roomCeiling(s.plan, null)).toEqual({ height: 96, type: 'drywall' });
    const { renderPlanSvg } = await import('../src/core/plan2d');
    const svg = renderPlanSvg(s.plan);
    expect(svg).toContain('Soffit 7');
    expect(svg).toContain('Drop ceiling 7');
  });
});
