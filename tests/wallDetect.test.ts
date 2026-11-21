import { describe, expect, it } from 'vitest';
import { centerlineFromFace, detectWallFromMesh, faceFromSweep, fitLine, type PP } from '../src/core/wallDetect';

/** Deterministic pseudo-random noise. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 2;
}

describe('line fitting', () => {
  it('recovers a line exactly', () => {
    const f = fitLine([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }])!;
    expect(Math.abs(f.d.x)).toBeCloseTo(Math.SQRT1_2);
    expect(f.rms).toBeCloseTo(0);
  });
});

describe('sweep capture', () => {
  it('fits a wall from noisy hit-test samples and ignores a stray hit', () => {
    const r = rng(1);
    const samples: PP[] = [];
    // Wall surface along y = 100 from x = 10 to 110, ~0.4" jitter.
    for (let x = 10; x <= 110; x += 2) samples.push({ x, y: 100 + r() * 0.4, z: 40 + r() * 10 });
    samples.push({ x: 60, y: 70, z: 40 }); // hit something in front once
    const f = faceFromSweep(samples, { x: 50, y: 0 })!;
    expect(f.a.y).toBeCloseTo(100, 0);
    expect(f.b.y).toBeCloseTo(100, 0);
    expect(Math.abs(f.b.x - f.a.x)).toBeCloseTo(100, 0);
    // Normal points toward the viewer (y < 100).
    expect(f.n.y).toBeLessThan(-0.99);
    const c = centerlineFromFace(f, 8);
    expect(c.a.y).toBeCloseTo(104, 0);
  });

  it('needs some travel', () => {
    expect(faceFromSweep([{ x: 0, y: 0, z: 30 }, { x: 2, y: 0, z: 30 }], { x: 0, y: -50 })).toBeNull();
  });
});

describe('mesh detection', () => {
  // A room mesh: floor, a 120" wall along y = 0 from x = 0..120, a gap (doorway) to x = 156,
  // then the wall continues to 220; plus a box (furniture) in the room.
  function roomMesh(): PP[] {
    const r = rng(7);
    const v: PP[] = [];
    for (let x = 0; x <= 220; x += 3) {
      if (x > 120 && x < 156) continue;
      for (let z = 0; z <= 96; z += 6) v.push({ x: x + r() * 0.3, y: r() * 0.5, z });
    }
    for (let x = 0; x <= 220; x += 6) for (let y = 0; y <= 150; y += 6) v.push({ x, y, z: 0 }); // floor
    for (let x = 40; x <= 70; x += 3) for (let z = 0; z <= 30; z += 3) v.push({ x, y: 60, z }); // box face
    return v;
  }

  it('finds the wall segment that was tapped, stopping at the doorway', () => {
    const f = detectWallFromMesh(roomMesh(), { x: 50, y: 0, z: 48 }, { x: 60, y: 120 })!;
    expect(f).not.toBeNull();
    const xs = [f.a.x, f.b.x].sort((p, q) => p - q);
    expect(xs[0]).toBeLessThan(2);
    expect(xs[1]).toBeGreaterThan(118);
    expect(xs[1]).toBeLessThan(123);
    expect(Math.abs(f.a.y)).toBeLessThan(0.5);
    expect(f.n.y).toBeGreaterThan(0.99); // faces the room
  });

  it('finds the other side of the doorway when tapped there', () => {
    const f = detectWallFromMesh(roomMesh(), { x: 190, y: 0, z: 48 }, { x: 60, y: 120 })!;
    const xs = [f.a.x, f.b.x].sort((p, q) => p - q);
    expect(xs[0]).toBeGreaterThan(153);
    expect(xs[1]).toBeGreaterThan(217);
  });

  it('gives up where there is no flat wall', () => {
    expect(detectWallFromMesh(roomMesh(), { x: 60, y: 120, z: 48 }, { x: 60, y: 120 })).toBeNull();
  });
});
