/**
 * Score the wall finder on real captures (tests/scans, kept out of git).
 *
 *   npx tsx scripts/wall-eval.ts [capture ...]
 *
 * For captures that include Quest Space Setup, its walls are the reference:
 *   found    - Space Setup walls matched by a shown proposal (parallel, within 8", half its length)
 *   off      - mean distance of those matches, inches
 *   false    - shown proposals inside Space Setup's rooms that match no Space Setup wall
 * Shown = not 'inferred' (guessed walls start switched off in the review).
 * Writes a top-down picture per capture to /tmp/wall-eval/.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { refineStructure, surfaceFromMeshes } from '../src/core/fit';
import { FreeGrid } from '../src/core/freeSpace';
import { createEmptyPlan } from '../src/core/plan';
import { decodeRecording, ingestFrame } from '../src/core/scanIngest';
import { ScanMap } from '../src/core/scanMap';
import { findStructure } from '../src/core/structure';
import { TsdfVolume } from '../src/core/tsdf';

type V = { x: number; y: number };
const IN = 0.0254;
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('tests/scans').filter((f) => f.endsWith('.gz')).map((f) => join('tests/scans', f));
mkdirSync('/tmp/wall-eval', { recursive: true });

for (const file of files) {
  let bytes = new Uint8Array(readFileSync(file));
  if (bytes[0] === 0x1f) bytes = new Uint8Array(gunzipSync(bytes));
  const { header, frames } = decodeRecording(bytes);
  const ex = (header.extras ?? {}) as any;
  const map = new ScanMap(3, 1_200_000);
  const free = new FreeGrid(4);
  const vol = new TsdfVolume();
  for (const f of frames) {
    ingestFrame(f, map, free);
    vol.integrate(f);
  }
  const plan = createEmptyPlan();
  const eye = frames.length ? { x: frames[0].head[0] / IN, y: frames[0].head[2] / IN } : { x: 0, y: 0 };
  const t0 = performance.now();
  const raw = findStructure(map.points(2), plan, { eye, axisAngle: null, partitionThickness: plan.settings.wallThickness, foundationThickness: plan.settings.foundationThickness }, free);
  const res = refineStructure(raw, surfaceFromMeshes(vol.meshDirty()));
  const ms = performance.now() - t0;
  const shown = res.walls.filter((w) => w.evidence !== 'inferred');

  // Space Setup reference walls and floors.
  let planes: Array<{ label: string; polygon: number[][] }> = ex.spaceSetup?.planes ?? [];
  // Older captures lost the planes when the session ended; the last room import still has the walls.
  const imp = [...(ex.journal ?? [])].reverse().find((j: any) => j.name === 'scan.importRoom')?.params?.scan;
  if (!planes.length && imp) {
    planes = imp.walls.map((w: any) => ({ label: 'wall', polygon: [[w.a.x, w.a.y, 0], [w.b.x, w.b.y, 0]] }));
    // No floor outlines in the import: use the walls' bounding box as the room area.
    const xs = imp.walls.flatMap((w: any) => [w.a.x, w.b.x]), ys = imp.walls.flatMap((w: any) => [w.a.y, w.b.y]);
    const [ax, bx, ay, by] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    planes.push({ label: 'floor', polygon: [[ax, ay], [bx, ay], [bx, by], [ax, by]] });
  }
  const ssWalls: Array<{ a: V; b: V }> = [];
  const floors: V[][] = [];
  for (const p of planes) {
    const xs = p.polygon.map((q) => q[0]);
    const ys = p.polygon.map((q) => q[1]);
    if (p.label === 'floor') floors.push(p.polygon.map((q) => ({ x: q[0], y: q[1] })));
    if (p.label !== 'wall') continue;
    // A vertical plane: its footprint is a line; take the two farthest points.
    let best = [p.polygon[0], p.polygon[0]];
    let bd = -1;
    for (const a of p.polygon) for (const b of p.polygon) {
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > bd) [bd, best] = [d, [a, b]];
    }
    if (bd > 12 && Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) < bd * 1.2) ssWalls.push({ a: { x: best[0][0], y: best[0][1] }, b: { x: best[1][0], y: best[1][1] } });
  }
  const inside = (pt: V, poly: V[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const near = (pt: V, poly: V[], r: number) => inside(pt, poly) || poly.some((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = Math.max(0, Math.min(L, ((pt.x - a.x) * (b.x - a.x) + (pt.y - a.y) * (b.y - a.y)) / L));
    return Math.hypot(a.x + ((b.x - a.x) * t) / L - pt.x, a.y + ((b.y - a.y) * t) / L - pt.y) < r;
  });
  /** Overlap (inches along `s`) of `o` lying parallel within `tol` of `s`, and their offset. */
  const overlap = (s: { a: V; b: V }, o: { a: V; b: V }, tol: number) => {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const d = { x: (s.b.x - s.a.x) / L, y: (s.b.y - s.a.y) / L };
    const Lo = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
    const od = { x: (o.b.x - o.a.x) / Lo, y: (o.b.y - o.a.y) / Lo };
    if (Math.abs(d.x * od.y - d.y * od.x) > 0.17) return { len: 0, off: Infinity };
    const mid = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    const off = Math.abs(-(mid.x - s.a.x) * d.y + (mid.y - s.a.y) * d.x);
    if (off > tol) return { len: 0, off };
    const ta = (o.a.x - s.a.x) * d.x + (o.a.y - s.a.y) * d.y;
    const tb = (o.b.x - s.a.x) * d.x + (o.b.y - s.a.y) * d.y;
    return { len: Math.max(0, Math.min(L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb))), off };
  };
  let found = 0, offSum = 0, falseN = 0, judged = 0;
  for (const s of ssWalls) {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    let best: { len: number; off: number } = { len: 0, off: Infinity };
    for (const w of shown) {
      const o = overlap(s, w, 8);
      if (o.len > best.len) best = o;
    }
    if (process.env.DEBUG) console.log(`  ss (${s.a.x.toFixed(0)},${s.a.y.toFixed(0)})-(${s.b.x.toFixed(0)},${s.b.y.toFixed(0)}) len ${L.toFixed(0)} best ${best.len.toFixed(0)} off ${best.off.toFixed(1)}`);
    if (best.len >= L * 0.5) {
      found++;
      offSum += best.off;
    }
  }
  for (const w of shown) {
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    if (!floors.some((f) => near(mid, f, 18))) continue;
    judged++;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const cov = ssWalls.reduce((m, s) => Math.max(m, overlap(w, s, 12).len), 0);
    if (cov < L * 0.3) falseN++;
    if (process.env.DEBUG) console.log(`  ${cov < L * 0.3 ? 'FALSE' : 'ok   '} ${w.evidence} (${w.a.x.toFixed(0)},${w.a.y.toFixed(0)})-(${w.b.x.toFixed(0)},${w.b.y.toFixed(0)}) len ${L.toFixed(0)} cov ${cov.toFixed(0)}`);
  }
  const name = basename(file).replace(/\.bpscan\.gz$/, '');
  console.log(
    `${name.padEnd(18)} ${frames.length} frames ${header.w}x${header.h}: ${res.walls.length} walls, ${shown.length} shown` +
      (ssWalls.length ? `; Space Setup ${ssWalls.length} walls: found ${found}, off ${(offSum / Math.max(1, found)).toFixed(1)}", false ${falseN}/${judged}` : '; no Space Setup') +
      ` (${ms.toFixed(0)} ms)`,
  );

  // Picture: grey points, green Space Setup, red shown, orange guessed, purple path.
  const pts = map.points(2);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
  const S = Math.min(3, 1200 / Math.max(x1 - x0, y1 - y0));
  const W = Math.ceil((x1 - x0) * S) + 40, H = Math.ceil((y1 - y0) * S) + 40;
  const img = new Uint8Array(W * H * 4).fill(255);
  const put = (x: number, y: number, c: number[], r = 0) => {
    const u = Math.round((x - x0) * S) + 20, v = Math.round((y - y0) * S) + 20;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      if (u + a < 0 || v + b < 0 || u + a >= W || v + b >= H) continue;
      const o = ((v + b) * W + u + a) * 4;
      [img[o], img[o + 1], img[o + 2]] = c;
    }
  };
  const line = (a: V, b: V, c: number[], r = 1) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    for (let t = 0; t <= len; t += 0.5 / S) put(a.x + ((b.x - a.x) * t) / len, a.y + ((b.y - a.y) * t) / len, c, r);
  };
  const z0 = res.floorOffset ?? 0;
  for (const p of pts) if (p.z - z0 > 6 && p.z - z0 < (res.ceiling ?? 96) - 6) put(p.x, p.y, [190, 190, 190]);
  for (const s of ssWalls) line(s.a, s.b, [0, 170, 0], 3);
  for (const w of res.walls) if (w.evidence === 'inferred') line(w.a, w.b, [255, 170, 0], 0);
  for (const w of shown) line(w.a, w.b, [220, 0, 0], 1);
  for (const f of frames) put(f.head[0] / IN, f.head[2] / IN, [120, 0, 200], 1);
  writeFileSync(`/tmp/wall-eval/${name}.jpg`, jpeg.encode({ data: img, width: W, height: H }, 88).data);
}
