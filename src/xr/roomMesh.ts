import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
} from '@iwsdk/core';
import type { DepthFrame } from '../core/scanIngest.js';
import { brickCoords, type BrickMesh, type ColorPhoto } from '../core/tsdf.js';
import { surfaceFromMeshes, type Surface } from '../core/fit.js';
import type { FusionIn, FusionOut } from './fusionWorker.js';
import type { WallFit } from '../core/fit.js';
import type { PickResult, Ray3 } from '../core/pickWall.js';

export interface WallPick {
  result: PickResult;
  fit: WallFit | null;
}

const PREF = 'basement-planner:room-mesh:v1';
const MESH_EVERY = 1; // s between mesh updates while scanning
/** Bricks per render chunk edge: 4 x 32 cm = one draw call per ~1.3 m cube. */
const CHUNK = 4;

/**
 * The live room mesh: depth frames fused in a worker, shown as a soft
 * see-through skin over the real room while you scan. Kept on the headset.
 */
export class RoomMesh {
  readonly group = new Group();
  private worker: Worker | null = null;
  /** Latest mesh of every brick, grouped into render chunks. */
  private bricksMesh = new Map<number, BrickMesh>();
  private chunkBricks = new Map<string, Set<number>>();
  private pieces = new Map<string, Mesh>();
  private mat = new MeshLambertMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.32, depthWrite: false, side: DoubleSide });
  /** Photo colors, solid: the room as the camera saw it. */
  private matColor = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
  /** Show photo colors instead of the see-through blue. */
  colored = false;
  /** Bricks painted by at least one photo. */
  coloredBricks = 0;
  private lastMesh = 0;
  private pending = false;
  bricks = 0;
  frames = 0;
  triangles = 0;
  integrateMs = 0;
  /** User preference: show the mesh outside of scanning too. */
  shown = true;
  /** Set while scanning: the mesh always shows then. */
  active = false;

  constructor(root: Object3D) {
    this.group.name = 'room-mesh';
    this.group.renderOrder = -1;
    root.add(this.group);
    try {
      this.shown = localStorage.getItem(PREF) !== 'off';
    } catch {
      /* default on */
    }
    try {
      this.worker = new Worker(new URL('./fusionWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FusionOut>) => this.onMessage(e.data);
      this.send({ type: 'load' });
    } catch {
      this.worker = null;
    }
    this.applyVisibility();
  }

  private send(m: FusionIn, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /** Fuse a frame (copied: the recorder keeps the original). */
  push(f: DepthFrame): void {
    if (!this.worker) return;
    const frame: DepthFrame = { ...f, depthMM: f.depthMM.slice() };
    this.send({ type: 'frame', frame }, [frame.depthMM.buffer]);
  }

  /** Paint the mesh from a camera photo (copied pixels go to the fusion worker). */
  colorize(photo: ColorPhoto): void {
    if (!this.worker) return;
    const rgba = photo.rgba.slice();
    this.send({ type: 'color', photo: { ...photo, rgba, camToRoot: Array.from(photo.camToRoot) } }, [rgba.buffer]);
  }

  setColored(on: boolean): void {
    this.colored = on;
    for (const m of this.pieces.values()) m.material = on ? this.matColor : this.mat;
  }

  /** Per frame: ask for fresh mesh pieces now and then. */
  tick(time: number): void {
    if (!this.active || this.pending || time - this.lastMesh < MESH_EVERY) return;
    this.lastMesh = time;
    this.pending = true;
    this.send({ type: 'mesh' });
    // The worker answers only when something changed.
    setTimeout(() => (this.pending = false), 1500);
  }

  /** The rendered chunks (for drawing the mesh elsewhere, e.g. through a wall). */
  chunks(): IterableIterator<[string, Mesh]> {
    return this.pieces.entries();
  }

  /** Mesh vertices and normals in plan inches, for fitting and checking walls. */
  surface(): Surface {
    return surfaceFromMeshes(this.bricksMesh.values());
  }

  save(): void {
    this.send({ type: 'mesh' });
    this.send({ type: 'save' });
  }

  clear(): void {
    this.send({ type: 'clear' });
    for (const m of this.pieces.values()) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.pieces.clear();
    this.bricksMesh.clear();
    this.chunkBricks.clear();
    this.bricks = this.frames = this.triangles = 0;
  }

  setShown(on: boolean): void {
    this.shown = on;
    try {
      localStorage.setItem(PREF, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    this.applyVisibility();
  }

  setActive(on: boolean): void {
    this.active = on;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.group.visible = this.active || this.shown;
  }

  private picks = new Map<number, (p: WallPick | null) => void>();
  private pickId = 0;

  /**
   * The wall under a ray, found and measured on the room mesh in the fusion worker
   * (plan inches). Resolves null without a worker.
   */
  pick(ray: Ray3, thickness: number, height: number): Promise<WallPick | null> {
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.pickId;
    return new Promise((resolve) => {
      this.picks.set(id, resolve);
      this.send({ type: 'pick', id, ray, thickness, height });
    });
  }

  private onMessage(m: FusionOut): void {
    if (m.type === 'pick') {
      this.picks.get(m.id)?.({ result: m.result, fit: m.fit });
      this.picks.delete(m.id);
      return;
    }
    this.bricks = m.bricks;
    this.frames = m.frames;
    if (m.type === 'stats') {
      this.integrateMs = m.integrateMs;
      return;
    }
    this.pending = false;
    const dirty = new Set<string>();
    for (const p of m.meshes) {
      const [bx, by, bz] = brickCoords(p.key);
      const ck = `${Math.floor(bx / CHUNK)},${Math.floor(by / CHUNK)},${Math.floor(bz / CHUNK)}`;
      let set = this.chunkBricks.get(ck);
      if (!set) this.chunkBricks.set(ck, (set = new Set()));
      if (p.indices.length) {
        this.bricksMesh.set(p.key, p);
        set.add(p.key);
      } else {
        this.bricksMesh.delete(p.key);
        set.delete(p.key);
      }
      dirty.add(ck);
    }
    for (const ck of dirty) this.rebuild(ck);
    let t = 0;
    for (const x of this.pieces.values()) t += (x.geometry.index?.count ?? 0) / 3;
    this.triangles = t;
  }

  /** One geometry per chunk: the bricks' pieces joined. */
  private rebuild(ck: string): void {
    const set = this.chunkBricks.get(ck);
    const old = this.pieces.get(ck);
    let nv = 0;
    let ni = 0;
    for (const k of set ?? []) {
      const b = this.bricksMesh.get(k)!;
      nv += b.positions.length;
      ni += b.indices.length;
    }
    if (!ni) {
      if (old) {
        old.geometry.dispose();
        this.group.remove(old);
        this.pieces.delete(ck);
      }
      return;
    }
    const pos = new Float32Array(nv);
    const nrm = new Float32Array(nv);
    // Vertex colors: grey where no photo has reached yet.
    const col = new Uint8Array(nv).fill(110);
    const idx = new Uint32Array(ni);
    let ov = 0;
    let oi = 0;
    for (const k of set!) {
      const b = this.bricksMesh.get(k)!;
      pos.set(b.positions, ov);
      nrm.set(b.normals, ov);
      if (b.colors.length === b.positions.length) col.set(b.colors, ov);
      const base = ov / 3;
      for (let i = 0; i < b.indices.length; i++) idx[oi + i] = b.indices[i] + base;
      ov += b.positions.length;
      oi += b.indices.length;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('color', new BufferAttribute(col, 3, true));
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    if (old) {
      old.geometry.dispose();
      old.geometry = g;
      return;
    }
    const mesh = new Mesh(g, this.colored ? this.matColor : this.mat);
    mesh.raycast = () => {};
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.pieces.set(ck, mesh);
  }
}
