/**
 * Review a scan capture off the headset: replays it through the scanner and
 * writes a report (Markdown + images) of everything it shows.
 *
 *   npx tsx scripts/capture-report.ts <capture.bpscan.gz> [outDir]
 *
 * Captures hold photos of a home: they stay out of git (tests/scans is ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { checkPlan, planSegs, refineStructure, surfaceFromMeshes } from '../src/core/fit';
import { FreeGrid } from '../src/core/freeSpace';
import { createEmptyPlan, parsePlan, type Plan } from '../src/core/plan';
import { decodeRecording, ingestFrame } from '../src/core/scanIngest';
import { ScanMap } from '../src/core/scanMap';
import { findStructure, type StructureResult } from '../src/core/structure';
import { TsdfVolume } from '../src/core/tsdf';
import { formatLength } from '../src/core/units';

const file = process.argv[2];
if (!file) throw new Error('usage: capture-report <capture> [outDir]');
const out = process.argv[3] ?? join('/tmp/report', basename(file).replace(/\..*$/, ''));
mkdirSync(out, { recursive: true });
let bytes = new Uint8Array(readFileSync(file));
if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(gunzipSync(bytes));
const { header, frames, photos } = decodeRecording(bytes);
const ex = (header.extras ?? {}) as Record<string, any>;
const md: string[] = [];
const L = (s = '') => md.push(s);
const IN = 0.0254;
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '-');

// --- Replay ----------------------------------------------------------------------
const map = new ScanMap(3, 1_200_000);
const free = new FreeGrid(4);
const vol = new TsdfVolume();
let t0 = performance.now();
for (const f of frames) {
  ingestFrame(f, map, free);
  vol.integrate(f);
}
const replayMs = performance.now() - t0;
const surf = surfaceFromMeshes(vol.meshDirty());
const pts = map.points(2);
const plan: Plan = ex.plan ? parsePlan(ex.plan) : createEmptyPlan();
const eye = frames.length ? { x: frames[0].head[0] / IN, y: frames[0].head[2] / IN } : { x: 0, y: 0 };
t0 = performance.now();
const raw = findStructure(pts, createEmptyPlan(), { eye, axisAngle: null, partitionThickness: plan.settings.wallThickness, foundationThickness: plan.settings.foundationThickness }, free);
const res: StructureResult = refineStructure(raw, surf);
const findMs = performance.now() - t0;

// --- Header -------------------------------------------------------------------------
const dur = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
let path = 0;
for (let i = 1; i < frames.length; i++) path += Math.hypot(frames[i].head[0] - frames[i - 1].head[0], frames[i].head[2] - frames[i - 1].head[2]);
L(`# Scan review: ${basename(file)}`);
L();
L(`- Captured ${header.createdAt}, app ${ex.app?.version ?? 'unknown'} (built ${ex.app?.builtAt ?? '?'})`);
L(`- ${header.userAgent ?? ''}`);
L(`- ${frames.length} depth frames at ${header.w}x${header.h} over ${f1(dur)} s; walked ${f1(path)} m; ${photos.length} photos${photos.length ? ` (${photos.filter((p) => Number.isFinite(p.captured ?? NaN)).length} with capture time, ${photos.filter((p) => p.track?.length).length} with pose track)` : ''}`);
L(`- Replay: ${pts.length} points, room mesh ${surf.pos.length / 3} vertices, ${vol.brickCount} bricks; replay ${replayMs.toFixed(0)} ms, wall finding ${findMs.toFixed(0)} ms`);
L(`- Floor offset ${res.floorOffset ?? '-'}", ceiling ${res.ceiling ?? '-'}", room direction ${((res.axis * 180) / Math.PI).toFixed(1)} deg`);
L();

// --- Found walls ------------------------------------------------------------------------
L('## What the scanner finds in this capture');
L();
L('| # | from | to | length | thick | evidence | conf | dev | openings |');
L('|---|---|---|---|---|---|---|---|---|');
res.walls.forEach((w, i) => {
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  L(`| ${i + 1} | ${f1(w.a.x)}, ${f1(w.a.y)} | ${f1(w.b.x)}, ${f1(w.b.y)} | ${formatLength(Math.round(len))} | ${w.thickness} | ${w.evidence ?? '-'} | ${w.confidence.toFixed(2)} | ${f1(w.deviation ?? NaN)} | ${w.openings.map((o) => `${o.type} ${o.width}"${o.evidence ? ` (${o.evidence})` : ''}`).join(', ') || '-'} |`);
});
L();
L(`Soffits: ${res.soffits.length}, posts: ${res.posts.length}.`);
L();

// --- The plan on the headset ------------------------------------------------------------
if (ex.plan) {
  L('## The plan on the headset at save time');
  L();
  L(`${plan.walls.length} walls (${plan.walls.filter((w) => w.kind === 'existing').length} real), ${plan.openings.length} openings, ${plan.rooms.length} rooms, ${plan.boxes.length} boxes, ${plan.constraints.length} locks.`);
  L();
  const checks = checkPlan(plan, surf, { includeNew: true });
  if (checks.length) {
    L('| wall | kind | as drawn: evidence | off by | mesh says moved | coverage |');
    L('|---|---|---|---|---|---|');
    for (const c of checks) {
      const w = plan.walls.find((x) => x.id === c.wallId)!;
      L(`| ${c.wallId} | ${w.kind} | ${c.check.evidence} | ${f1(c.check.deviation)}" | ${f1(c.fitted.shift)}" | ${(c.check.coverage * 100).toFixed(0)}% |`);
    }
    L();
  }
  const truths = plan.measures.filter((m) => m.truth);
  if (truths.length) {
    L('### Tape measure checks');
    L();
    L('| headset | tape | error |');
    L('|---|---|---|');
    for (const m of truths) {
      const d = Math.hypot(m.a.x - m.b.x, m.a.y - m.b.y, m.a.z - m.b.z);
      L(`| ${formatLength(Math.round(d * 8) / 8)} | ${formatLength(m.truth!)} | ${(d - m.truth!).toFixed(2)}" |`);
    }
    L();
  }
  // What the scanner would add now, given the plan.
  const fresh = refineStructure(findStructure(pts, plan, { eye, axisAngle: null, partitionThickness: plan.settings.wallThickness, foundationThickness: plan.settings.foundationThickness }, free), surf, planSegs(plan));
  L(`Scanning again with this plan would propose ${fresh.walls.length} new walls.`);
  L();
}

// --- Space Setup ----------------------------------------------------------------------------
const ss = ex.spaceSetup ?? { planes: [], meshes: [] };
L('## Quest Space Setup data');
L();
L(`${ss.planes.length} planes (${[...new Set(ss.planes.map((p: any) => p.label))].join(', ') || 'none'}), ${ss.meshes.length} meshes (${ss.meshes.reduce((n: number, m: any) => n + m.vertices.length, 0)} vertices).`);
L();

// --- Top-down picture -------------------------------------------------------------------------
{
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
  if (Number.isFinite(x0)) {
    const S = Math.min(3, 1400 / Math.max(x1 - x0, y1 - y0));
    const W = Math.ceil((x1 - x0) * S) + 40;
    const H = Math.ceil((y1 - y0) * S) + 40;
    const img = new Uint8Array(W * H * 4).fill(255);
    const put = (x: number, y: number, c: number[], r = 0) => {
      const u = Math.round((x - x0) * S) + 20;
      const v = Math.round((y - y0) * S) + 20;
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (u + a < 0 || v + b < 0 || u + a >= W || v + b >= H) continue;
        const o = ((v + b) * W + u + a) * 4;
        img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
      }
    };
    const line = (a: { x: number; y: number }, b: { x: number; y: number }, c: number[], r = 1) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= len; t += 0.5 / S) put(a.x + ((b.x - a.x) * t) / len, a.y + ((b.y - a.y) * t) / len, c, r);
    };
    const z0 = res.floorOffset ?? 0;
    for (const p of pts) {
      const h = p.z - z0;
      if (h < 6 || h > (res.ceiling ?? 96) - 6) continue;
      put(p.x, p.y, h > 60 ? [140, 140, 140] : [200, 200, 200]);
    }
    for (const pl of ss.planes) for (let i = 0; i < pl.polygon.length; i++) line({ x: pl.polygon[i][0], y: pl.polygon[i][1] }, { x: pl.polygon[(i + 1) % pl.polygon.length][0], y: pl.polygon[(i + 1) % pl.polygon.length][1] }, [0, 160, 0], 0);
    const node = new Map(plan.nodes.map((n) => [n.id, n]));
    for (const w of plan.walls) line(node.get(w.a)!, node.get(w.b)!, [40, 90, 230], 2);
    for (const w of res.walls) {
      line(w.a, w.b, w.evidence === 'inferred' ? [240, 170, 0] : [220, 0, 0], 1);
      for (const o of w.openings) put(o.center.x, o.center.y, [0, 180, 220], 3);
    }
    for (const f of frames) put(f.head[0] / IN, f.head[2] / IN, [120, 0, 200], 1);
    writeFileSync(join(out, 'topdown.jpg'), jpeg.encode({ data: img, width: W, height: H }, 90).data);
    L('## Top-down');
    L();
    L('![top-down](topdown.jpg)');
    L();
    L('Grey: scanned points (dark above 5 ft). Red: walls the scanner finds now (orange = guessed), cyan dots: openings. Blue: walls in the plan. Green: Space Setup planes. Purple: your path.');
    L();
  }
}

// --- Photos -------------------------------------------------------------------------------------------
if (photos.length) {
  const cols = 4;
  const tw = 320, th = 240;
  const rows = Math.ceil(photos.length / cols);
  const W = cols * tw, H = rows * th;
  const sheet = new Uint8Array(W * H * 4).fill(30);
  photos.forEach((p, i) => {
    const im = jpeg.decode(p.jpeg, { useTArray: true });
    const ox = (i % cols) * tw, oy = Math.floor(i / cols) * th;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const s = (Math.floor((y * im.height) / th) * im.width + Math.floor((x * im.width) / tw)) * 4;
      const d = ((oy + y) * W + ox + x) * 4;
      sheet[d] = im.data[s]; sheet[d + 1] = im.data[s + 1]; sheet[d + 2] = im.data[s + 2]; sheet[d + 3] = 255;
    }
    writeFileSync(join(out, `photo-${String(i).padStart(3, '0')}.jpg`), p.jpeg);
  });
  writeFileSync(join(out, 'photos.jpg'), jpeg.encode({ data: sheet, width: W, height: H }, 80).data);
  L('## Photos');
  L();
  L('![photos](photos.jpg)');
  L();
  L('| # | t | capture lag | pose track |');
  L('|---|---|---|---|');
  photos.forEach((p, i) => L(`| ${i} | ${p.t.toFixed(2)} s | ${Number.isFinite(p.captured ?? NaN) ? `${((p.t - p.captured!) * 1000).toFixed(0)} ms` : '-'} | ${p.track?.length ?? 0} poses |`));
  L();
}

writeFileSync(join(out, 'report.md'), md.join('\n'));
writeFileSync(join(out, 'result.json'), JSON.stringify({ header: { ...header, extras: undefined }, walls: res.walls, soffits: res.soffits, posts: res.posts }, null, 1));
console.log(`report: ${join(out, 'report.md')}`);
