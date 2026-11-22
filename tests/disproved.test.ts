import { describe, expect, it } from 'vitest';
import { FreeGrid } from '../src/core/freeSpace';
import { disprovedWalls } from '../src/core/wallFinder';

describe('disprovedWalls', () => {
  // Rays from y=-100 out to y=+100 across x 0..200, stopping at a real wall at y=60.
  const free = new FreeGrid(4);
  for (let k = 0; k < 3; k++) for (let x = 2; x < 200; x += 4) for (const z of [24, 40, 56, 72]) free.carve(x, -100, z, x, 60, z);
  const walls = [
    { id: 'ghost', a: { x: 20, y: 0 }, b: { x: 180, y: 0 }, source: 'capture' }, // in open air
    { id: 'real', a: { x: 20, y: 62.25 }, b: { x: 180, y: 62.25 }, source: 'capture' }, // behind the face rays stop at
    { id: 'drawn', a: { x: 20, y: 0 }, b: { x: 180, y: 0 }, source: 'manual' },
    { id: 'locked', a: { x: 20, y: 0 }, b: { x: 180, y: 0 }, source: 'capture', locked: true },
  ];
  it('flags scanned walls you have seen straight through, and nothing else', () => {
    expect(disprovedWalls(walls, free, 0)).toEqual(['ghost']);
  });
});
