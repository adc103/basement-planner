import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FreeGrid } from '../src/core/freeSpace';
import { createEmptyPlan } from '../src/core/plan';
import { ScanMap } from '../src/core/scanMap';
import { decodeRecording, encodeRecording, ingestFrame, type DepthFrame } from '../src/core/scanIngest';
import { findStructure } from '../src/core/structure';
import { TsdfVolume } from '../src/core/tsdf';
import { refineStructure, sameWall, surfaceFromMeshes } from '../src/core/fit';
import { basementScene, depthFramesFor } from './synthScan';

function replay(frames: DepthFrame[]) {
  const map = new ScanMap(3, 1_200_000);
  const free = new FreeGrid(4);
  for (const f of frames) ingestFrame(f, map, free);
  const res = findStructure(map.points(2), createEmptyPlan(), { eye: { x: 100, y: 100 }, axisAngle: null, partitionThickness: 4.5, foundationThickness: 8 }, free);
  return { map, res };
}

describe('scan recording and replay', () => {
  const frames = depthFramesFor(basementScene());

  it('replays depth frames from a virtual headset into the right structure', () => {
    const { map, res } = replay(frames);
    expect(map.size).toBeGreaterThan(5000);
    expect(res.ceiling).toBeGreaterThan(88);
    expect(res.ceiling).toBeLessThan(96);
    const partition = res.walls.find((w) => Math.abs(w.a.x - w.b.x) < 2 && Math.abs(w.a.x - 202) < 4);
    expect(partition, 'the stud partition').toBeTruthy();
    const doors = partition!.openings.map((o) => Math.round(o.width));
    expect(doors.some((wd) => Math.abs(wd - 32) <= 3)).toBe(true);
    expect(doors.some((wd) => Math.abs(wd - 48) <= 3)).toBe(true);
    expect(res.walls.length).toBeGreaterThanOrEqual(5);
  });

  it('fits the found walls to the room mesh and labels them measured', () => {
    const { res } = replay(frames);
    const vol = new TsdfVolume();
    for (const f of frames) vol.integrate(f);
    const fit = refineStructure(res, surfaceFromMeshes(vol.meshDirty()));
    const part = fit.walls.find((w) => Math.abs(w.a.x - w.b.x) < 2 && Math.abs(w.a.x - 202) < 4)!;
    expect(Math.abs(part.a.x - 202.25)).toBeLessThan(0.5);
    expect(Math.abs(part.thickness - 4.5)).toBeLessThan(0.75);
    expect(part.evidence).toBe('measured');
    const door = part.openings.find((o) => Math.abs(o.width - 32) < 4)!;
    expect(Math.abs(door.width - 32)).toBeLessThan(1);
    expect(door.evidence).toBe('measured');
    const outer = fit.walls.filter((w) => w.foundation);
    expect(outer.filter((w) => w.evidence === 'measured').length).toBeGreaterThanOrEqual(3);
    // Corners stay joined: every end still lies on another wall.
    for (const w of fit.walls) {
      for (const p of [w.a, w.b]) {
        const on = fit.walls.some((o) => {
          if (o === w) return false;
          const L = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
          return Math.abs(-(p.x - o.a.x) * (o.b.y - o.a.y) + (p.y - o.a.y) * (o.b.x - o.a.x)) / L < 0.05;
        });
        if (w.b.y < 260) expect(on, `end ${p.x.toFixed(1)},${p.y.toFixed(1)}`).toBe(true);
      }
    }
    console.log(fit.walls.map((w) => `${w.evidence} t${w.thickness} ${w.a.x.toFixed(2)},${w.a.y.toFixed(2)} [${w.openings.map((o) => `${o.type}${o.width} ${o.evidence}`).join(', ')}]`).join('\n'));
  }, 60_000);

  it('carries camera photos with their poses and timing (format v3)', () => {
    const some = frames.slice(0, 3);
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]); // odd length: tests the padding
    const track = [0.1, 0.2].map((t) => ({ t, m: some[2].viewToRoot }));
    const photos = [0, 1].map((i) => ({ t: i, jpeg, viewToRoot: some[i].viewToRoot, proj: some[i].proj, captured: i + 0.05, track }));
    const r = decodeRecording(encodeRecording(some, {}, photos));
    expect(r.header.version).toBe(3);
    expect(r.photos[1].captured).toBeCloseTo(1.05, 5);
    expect(r.photos[1].track).toHaveLength(2);
    expect(Array.from(r.photos[1].track![1].m)).toEqual(Array.from(some[2].viewToRoot));
    expect(r.frames).toHaveLength(3);
    expect(r.photos).toHaveLength(2);
    expect(Array.from(r.photos[1].jpeg)).toEqual(Array.from(jpeg));
    expect(Array.from(r.photos[1].viewToRoot)).toEqual(Array.from(some[1].viewToRoot));
    // Version 1 files (no photos) still open.
    expect(decodeRecording(encodeRecording(some)).photos).toHaveLength(0);
  });

  it('round-trips through the file format exactly', () => {
    const some = frames.slice(0, 20);
    const back = decodeRecording(encodeRecording(some)).frames;
    expect(back).toHaveLength(20);
    expect(Array.from(back[7].depthMM)).toEqual(Array.from(some[7].depthMM));
    expect(Array.from(back[7].viewToRoot)).toEqual(Array.from(some[7].viewToRoot));
    expect(back[7].head).toEqual(some[7].head.map((v) => Math.fround(v)));
  });

  // Real scans saved from the headset (flat page > Save scan recording) go in tests/scans/.
  const dir = new URL('./scans/', import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.bpscan(\.gz)?$/.test(f)) : [];
  for (const file of files) {
    it(`replays the real scan ${file}`, { timeout: 60_000 }, () => {
      let bytes = new Uint8Array(readFileSync(new URL(file, dir)));
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(gunzipSync(bytes));
      const { header, frames: real } = decodeRecording(bytes);
      expect(real).toHaveLength(header.frames);
      const { res } = replay(real);
      expect(res.walls.length).toBeGreaterThan(0);
      // With the room mesh: no stacked copies of the same wall.
      const vol = new TsdfVolume();
      for (const f of real) vol.integrate(f);
      const fit = refineStructure(res, surfaceFromMeshes(vol.meshDirty()));
      for (let i = 0; i < fit.walls.length; i++) for (let j = i + 1; j < fit.walls.length; j++) expect(sameWall(fit.walls[i], fit.walls[j])).toBe(false);
      expect(fit.walls.length).toBeLessThanOrEqual(12);
    });
  }
});
