/// <reference lib="webworker" />
import type { DepthFrame } from '../core/scanIngest.js';
import { TsdfVolume, type BrickMesh, type ColorPhoto, type PhotoCam } from '../core/tsdf.js';
import { fitWall, SurfaceIndex, surfaceFromMeshes, type WallFit } from '../core/fit.js';
import { pickWall, type PickResult, type Ray3 } from '../core/pickWall.js';
import { findOpening, type FoundOpening, type OpeningWall } from '../core/findOpening.js';
import { PhotoAligner } from '../core/photoAlign.js';
import { idbGet, idbSet } from './idb.js';

/**
 * Depth fusion off the render thread: frames in, mesh pieces out.
 * The volume saves itself to IndexedDB so the room mesh survives a restart.
 */

export type FusionIn =
  | { type: 'frame'; frame: DepthFrame }
  | { type: 'mesh' }
  | { type: 'color'; id: number; photo: ColorPhoto }
  /** A photo the worker had no time to paint with: just note what it saw (coverage). */
  | { type: 'seen'; cam: PhotoCam }
  | { type: 'clear' }
  | { type: 'save' }
  | { type: 'load' }
  | { type: 'pick'; id: number; ray: Ray3; thickness: number; height: number }
  | { type: 'opening'; id: number; wall: OpeningWall; at: number; atZ: number };

export type FusionOut =
  | { type: 'meshes'; meshes: BrickMesh[]; bricks: number; frames: number; ms: number }
  | { type: 'stats'; bricks: number; frames: number; integrateMs: number }
  /** The wall under a ray; `fit` is that wall measured (both faces, thickness) when found. */
  | { type: 'pick'; id: number; result: PickResult; fit: WallFit | null; ms: number }
  | { type: 'opening'; id: number; opening: FoundOpening | null }
  /** Where photo `id` was kept as a texture (null: not worth keeping), and its color gains. */
  | { type: 'photoSlot'; id: number; slot: number | null; gain: [number, number, number]; camToRoot: number[]; aligned: number | null };

const KEY = 'scan-tsdf:v1';
const vol = new TsdfVolume();
const post = (m: FusionOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let integrateMs = 0;

/** The latest mesh of every brick (kept here too: the sent copies are transferred). */
const surfaceBricks = new Map<number, { positions: Float32Array; normals: Float32Array }>();
let surfaceVersion = 0;
let index: { version: number; idx: SurfaceIndex } | null = null;

const aligner = new PhotoAligner();
let pointsCache: { version: number; pts: Float32Array } | null = null;

/** Surface points for lining photos up (every third mesh vertex, root meters). */
function surfacePoints(): Float32Array {
  if (pointsCache && pointsCache.version === surfaceVersion) return pointsCache.pts;
  let n = 0;
  for (const b of surfaceBricks.values()) n += Math.ceil(b.positions.length / 9);
  const pts = new Float32Array(n * 3);
  let o = 0;
  for (const b of surfaceBricks.values()) {
    for (let i = 0; i < b.positions.length; i += 9) {
      pts[o++] = b.positions[i];
      pts[o++] = b.positions[i + 1];
      pts[o++] = b.positions[i + 2];
    }
  }
  pointsCache = { version: surfaceVersion, pts: pts.subarray(0, o) };
  return pointsCache.pts;
}

/** Half-size gray copy of a photo (for lining it up). */
function halfGray(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): { g: Uint8Array; w: number; h: number } {
  const W = w >> 1;
  const H = h >> 1;
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + dy) * w + x * 2 + dx) * 4;
        s += 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2];
      }
      g[y * W + x] = s / 4;
    }
  }
  return { g, w: W, h: H };
}

/** Spatial index over the room mesh, rebuilt only after the mesh changed. */
function surfaceIndex(): SurfaceIndex {
  if (!index || index.version !== surfaceVersion) index = { version: surfaceVersion, idx: new SurfaceIndex(surfaceFromMeshes(surfaceBricks.values())) };
  return index.idx;
}

function sendMeshes(meshes: BrickMesh[], ms: number): void {
  for (const m of meshes) {
    if (m.indices.length) surfaceBricks.set(m.key, { positions: m.positions.slice(), normals: m.normals.slice() });
    else surfaceBricks.delete(m.key);
  }
  surfaceVersion++;
  const transfer: Transferable[] = [];
  for (const m of meshes) transfer.push(m.positions.buffer, m.normals.buffer, m.indices.buffer, m.colors.buffer);
  post({ type: 'meshes', meshes, bricks: vol.brickCount, frames: vol.frames, ms }, transfer);
}

self.onmessage = async (e: MessageEvent<FusionIn>) => {
  const m = e.data;
  if (m.type === 'frame') {
    const t0 = performance.now();
    vol.integrate(m.frame);
    integrateMs = integrateMs * 0.9 + (performance.now() - t0) * 0.1;
    post({ type: 'stats', bricks: vol.brickCount, frames: vol.frames, integrateMs });
  } else if (m.type === 'seen') {
    vol.markSeen(m.cam);
  } else if (m.type === 'color') {
    // Line the photo up with the earlier ones first (its pose is often a few degrees off).
    const ph = m.photo;
    let cam = ph.camToRoot;
    let aligned: number | null = null;
    const pts = surfacePoints();
    if (pts.length > 3000) {
      const thumb = halfGray(ph.rgba, ph.w, ph.h);
      const r = aligner.add({ camToRoot: ph.camToRoot, fx: ph.fx / 2, fy: ph.fy / 2, cx: ph.cx / 2, cy: ph.cy / 2 }, thumb, pts);
      cam = Array.from(r.cam.camToRoot);
      if (Number.isFinite(r.after)) aligned = r.after - r.before;
    }
    vol.colorize({ ...ph, camToRoot: cam }, 4.5, true);
    post({ type: 'photoSlot', id: m.id, slot: vol.lastSlot, gain: vol.lastGain, camToRoot: Array.from(cam), aligned });
  } else if (m.type === 'mesh') {
    if (!vol.dirty.size) return;
    const t0 = performance.now();
    const meshes = vol.meshDirty();
    sendMeshes(meshes, performance.now() - t0);
  } else if (m.type === 'pick') {
    const t0 = performance.now();
    const idx = surfaceIndex();
    const result = pickWall(idx, m.ray);
    let fit: WallFit | null = null;
    if ('wall' in result) {
      // Measure it as a wall: the face found, its centerline a default half-thickness behind.
      const { a, b, n } = result.wall;
      const h = m.thickness / 2;
      fit = fitWall(idx, { a: { x: a.x - n.x * h, y: a.y - n.y * h }, b: { x: b.x - n.x * h, y: b.y - n.y * h }, thickness: m.thickness, z0: 0, z1: m.height, openings: [] });
    }
    post({ type: 'pick', id: m.id, result, fit, ms: performance.now() - t0 });
  } else if (m.type === 'opening') {
    post({ type: 'opening', id: m.id, opening: findOpening(surfaceIndex(), m.wall, m.at, m.atZ) });
  } else if (m.type === 'clear') {
    vol.clear();
    aligner.clear();
    surfaceBricks.clear();
    surfaceVersion++;
    await idbSet(KEY, new Uint8Array(0));
  } else if (m.type === 'save') {
    await idbSet(KEY, vol.serialize());
  } else if (m.type === 'load') {
    const bytes = await idbGet<Uint8Array>(KEY);
    if (bytes && bytes.length && vol.load(bytes)) {
      const t0 = performance.now();
      sendMeshes(vol.meshAll(), performance.now() - t0);
    }
  }
};
