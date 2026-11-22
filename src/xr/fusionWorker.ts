/// <reference lib="webworker" />
import type { DepthFrame } from '../core/scanIngest.js';
import { TsdfVolume, type BrickMesh, type ColorPhoto } from '../core/tsdf.js';
import { fitWall, SurfaceIndex, surfaceFromMeshes, type WallFit } from '../core/fit.js';
import { pickWall, type PickResult, type Ray3 } from '../core/pickWall.js';
import { idbGet, idbSet } from './idb.js';

/**
 * Depth fusion off the render thread: frames in, mesh pieces out.
 * The volume saves itself to IndexedDB so the room mesh survives a restart.
 */

export type FusionIn =
  | { type: 'frame'; frame: DepthFrame }
  | { type: 'mesh' }
  | { type: 'color'; photo: ColorPhoto }
  | { type: 'clear' }
  | { type: 'save' }
  | { type: 'load' }
  | { type: 'pick'; id: number; ray: Ray3; thickness: number; height: number };

export type FusionOut =
  | { type: 'meshes'; meshes: BrickMesh[]; bricks: number; frames: number; ms: number }
  | { type: 'stats'; bricks: number; frames: number; integrateMs: number }
  /** The wall under a ray; `fit` is that wall measured (both faces, thickness) when found. */
  | { type: 'pick'; id: number; result: PickResult; fit: WallFit | null; ms: number };

const KEY = 'scan-tsdf:v1';
const vol = new TsdfVolume();
const post = (m: FusionOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let integrateMs = 0;

/** The latest mesh of every brick (kept here too: the sent copies are transferred). */
const surfaceBricks = new Map<number, { positions: Float32Array; normals: Float32Array }>();
let surfaceVersion = 0;
let index: { version: number; idx: SurfaceIndex } | null = null;

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
  } else if (m.type === 'color') {
    vol.colorize(m.photo);
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
  } else if (m.type === 'clear') {
    vol.clear();
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
