import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
} from '@iwsdk/core';
import type { DepthFrame } from '../core/scanIngest.js';
import { brickCoords, type BrickMesh } from '../core/tsdf.js';
import { surfaceFromMeshes, type Surface } from '../core/fit.js';
import type { FusionIn, FusionOut } from './fusionWorker.js';

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

  /** Per frame: ask for fresh mesh pieces now and then. */
  tick(time: number): void {
    if (!this.active || this.pending || time - this.lastMesh < MESH_EVERY) return;
    this.lastMesh = time;
    this.pending = true;
    this.send({ type: 'mesh' });
    // The worker answers only when something changed.
    setTimeout(() => (this.pending = false), 1500);
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

  private onMessage(m: FusionOut): void {
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
    const idx = new Uint32Array(ni);
    let ov = 0;
    let oi = 0;
    for (const k of set!) {
      const b = this.bricksMesh.get(k)!;
      pos.set(b.positions, ov);
      nrm.set(b.normals, ov);
      const base = ov / 3;
      for (let i = 0; i < b.indices.length; i++) idx[oi + i] = b.indices[i] + base;
      ov += b.positions.length;
      oi += b.indices.length;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    if (old) {
      old.geometry.dispose();
      old.geometry = g;
      return;
    }
    const mesh = new Mesh(g, this.mat);
    mesh.raycast = () => {};
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.pieces.set(ck, mesh);
  }
}
