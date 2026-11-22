import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FreeGrid } from '../src/core/freeSpace';
import { createEmptyPlan } from '../src/core/plan';
import { ScanMap } from '../src/core/scanMap';
import { decodeRecording, encodeRecording, ingestFrame, type DepthFrame } from '../src/core/scanIngest';
import { findStructure } from '../src/core/structure';
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
    it(`replays the real scan ${file}`, () => {
      let bytes = new Uint8Array(readFileSync(new URL(file, dir)));
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(gunzipSync(bytes));
      const { header, frames: real } = decodeRecording(bytes);
      expect(real).toHaveLength(header.frames);
      const { res } = replay(real);
      expect(res.walls.length).toBeGreaterThan(0);
    });
  }
});
