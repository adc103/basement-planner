import {
  BufferAttribute,
  BufferGeometry,
  DataArrayTexture,
  DoubleSide,
  EqualStencilFunc,
  type Plane,
  LinearFilter,
  Matrix4,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
  LessEqualDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
} from '@iwsdk/core';
import type { DepthFrame } from '../core/scanIngest.js';
import { brickCoords, NO_SLOT, PHOTO_SLOTS, type BrickMesh, type ColorPhoto } from '../core/tsdf.js';
import { surfaceFromMeshes, type Surface } from '../core/fit.js';
import type { FusionIn, FusionOut } from './fusionWorker.js';
import type { WallFit } from '../core/fit.js';
import type { PickResult, Ray3 } from '../core/pickWall.js';
import type { FoundOpening, OpeningWall } from '../core/findOpening.js';

export interface WallPick {
  result: PickResult;
  fit: WallFit | null;
}

const PREF = 'basement-planner:room-mesh:v1';

/** How far the scan is drawn behind where it is, as seen from your eye (meters). */
const PUSH_BACK = 0.025;

/**
 * Draw the scan an inch behind its true place, straight away from the eye (so it looks
 * the same): plan walls and lines that sit on a real surface then always draw in
 * front of it, instead of fighting it pixel by pixel (shimmering stripes, worse with
 * the headset's coarse depth buffer). A fixed distance, unlike polygon offset.
 */
function pushBack<M extends MeshBasicMaterial>(m: M): M {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      mvPosition.xyz *= 1.0 + ${PUSH_BACK.toFixed(3)} / max(length(mvPosition.xyz), 0.1);
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => 'room-mesh-push-back';
  return m;
}

/**
 * Stencil test for the scan's own drawing: only where no virtual hole is (stencil 0).
 * Inside a hole the room behind is drawn instead (see holes.ts).
 */
const OUTSIDE_HOLES = { stencilWrite: true, stencilRef: 0, stencilFunc: EqualStencilFunc, stencilWriteMask: 0 } as const;

/** Photo size kept as textures (the camera photos the scan takes). */
const PW = 640;
const PH = 480;

/**
 * The scan in color, sharp: each triangle shows the photo that saw it best (picked per
 * voxel in the fusion worker), projected onto it here per pixel. Triangles whose
 * corners picked different photos, or none, keep the averaged vertex color.
 */
function photoTextured(m: MeshBasicMaterial, u: { photoTex: { value: DataArrayTexture | null }; photoView: { value: Matrix4[] }; photoK: { value: Vector4[] }; photoGain: { value: Vector3[] } }): MeshBasicMaterial {
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    base.call(m, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float photo;\nvarying float vPhoto;\nvarying vec3 vRootPos;\nvarying vec3 vWN;\nvarying vec3 vWP;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvPhoto = photo;\nvRootPos = position;\nvWN = mat3(modelMatrix) * normal;\nvWP = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray photoTex;
        uniform mat4 photoView[${PHOTO_SLOTS}];
        uniform vec4 photoK[${PHOTO_SLOTS}];
        uniform vec3 photoGain[${PHOTO_SLOTS}];
        varying float vPhoto;
        varying vec3 vRootPos;
        varying vec3 vWN;
        varying vec3 vWP;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Seen from behind (the scan's normals point into the room it was scanned from):
        // nothing to show. Drawing it would paint the other side's colors on, mirrored.
        if (dot(vWN, cameraPosition - vWP) < 0.0) discard;
        if (vPhoto < ${NO_SLOT - 0.5} && abs(vPhoto - floor(vPhoto + 0.5)) < 0.02) {
          int si = int(vPhoto + 0.5);
          vec4 c = photoView[si] * vec4(vRootPos, 1.0);
          float z = -c.z;
          if (z > 0.05) {
            vec2 uv = vec2(photoK[si].z + photoK[si].x * c.x / z, photoK[si].w - photoK[si].y * c.y / z);
            if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0)
              diffuseColor.rgb = min(texture(photoTex, vec3(uv, float(si))).rgb * photoGain[si], vec3(1.0));
          }
        }
        // Photo pixels and vertex colors are sRGB bytes: to linear, as the renderer expects
        // (else the output encoding brightens them a second time and they look washed out).
        diffuseColor.rgb = sRGBTransferEOTF(vec4(diffuseColor.rgb, 1.0)).rgb;`,
      );
  };
  m.customProgramCacheKey = () => 'room-mesh-photo-textured';
  return m;
}
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
  /**
   * See-through skin, drawn in two passes: depth first (no color), then the tint only
   * where it is the nearest surface. One blended layer per pixel: no flicker from
   * overlapping see-through chunks drawn in changing order, and far less GPU work than
   * blending every layer of the room. Unlit: the scan's normals are noisy at 4 cm, and
   * shading them lights flat walls in blotches that shift as you move.
   */
  private mat = pushBack(new MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.3, depthWrite: false, depthFunc: LessEqualDepth, side: DoubleSide, ...OUTSIDE_HOLES }));
  private matDepth = pushBack(new MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: DoubleSide }));
  /** Photo colors, solid: the room as the camera saw it. */
  /** Photos kept as textures, and where each was taken (root -> camera, intrinsics / size). */
  private photoU = {
    photoTex: { value: null as DataArrayTexture | null },
    photoView: { value: Array.from({ length: PHOTO_SLOTS }, () => new Matrix4()) },
    photoK: { value: Array.from({ length: PHOTO_SLOTS }, () => new Vector4()) },
    photoGain: { value: Array.from({ length: PHOTO_SLOTS }, () => new Vector3(1, 1, 1)) },
  };
  private matColor = photoTextured(pushBack(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, ...OUTSIDE_HOLES })), this.photoU);

  /**
   * The scan as seen through a virtual hole (stencil value `ref`): colored, solid, and
   * only beyond `beyond` (the wall's far face), so the wall itself and this side vanish.
   */
  portalMaterial(ref: number, beyond: Plane): MeshBasicMaterial {
    const m = photoTextured(
      new MeshBasicMaterial({
        vertexColors: true,
        side: DoubleSide,
        stencilWrite: true,
        stencilRef: ref,
        stencilFunc: EqualStencilFunc,
        stencilWriteMask: 0,
        clippingPlanes: [beyond],
      }),
      this.photoU,
    );
    return m;
  }
  /** Photos sent to the worker, waiting to hear whether they're kept as textures. */
  private pendingPhotos = new Map<number, ColorPhoto>();
  private photoId = 0;
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
    const id = ++this.photoId;
    this.pendingPhotos.set(id, { ...photo, rgba: photo.rgba.slice() });
    this.send({ type: 'color', id, photo: { ...photo, rgba, camToRoot: Array.from(photo.camToRoot) } }, [rgba.buffer]);
  }

  /** Keep a photo the worker chose as a texture: upload it to its slot. */
  private keepPhoto(id: number, slot: number | null, gain: [number, number, number]): void {
    const ph = this.pendingPhotos.get(id);
    this.pendingPhotos.delete(id);
    if (!ph || slot === null || ph.w !== PW || ph.h !== PH) return;
    let tex = this.photoU.photoTex.value;
    if (!tex) {
      tex = new DataArrayTexture(new Uint8Array(PW * PH * 4 * PHOTO_SLOTS), PW, PH, PHOTO_SLOTS);
      tex.format = RGBAFormat;
      tex.type = UnsignedByteType;
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      this.photoU.photoTex.value = tex;
    }
    (tex.image.data as Uint8Array).set(ph.rgba, slot * PW * PH * 4);
    tex.addLayerUpdate(slot);
    tex.needsUpdate = true;
    this.photoU.photoView.value[slot].fromArray(Array.from(ph.camToRoot)).invert();
    this.photoU.photoK.value[slot].set(ph.fx / PW, ph.fy / PH, ph.cx / PW, ph.cy / PH);
    this.photoU.photoGain.value[slot].set(gain[0], gain[1], gain[2]);
  }

  setColored(on: boolean): void {
    this.colored = on;
    for (const m of this.pieces.values()) {
      m.material = on ? this.matColor : this.mat;
      m.children[0].visible = !on;
    }
  }

  /** Per frame: ask for fresh mesh pieces now and then. */
  tick(time: number): void {
    this.drain(3);
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
    // Stopping: mesh the last frames too (else up to a second of scanning is left out).
    if (this.active && !on) this.send({ type: 'mesh' });
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

  private openings = new Map<number, (o: FoundOpening | null) => void>();

  /** The open doorway (or window) in a wall near a spot along it, measured on the room mesh. */
  findOpening(wall: OpeningWall, at: number, atZ: number): Promise<FoundOpening | null> {
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.pickId;
    return new Promise((resolve) => {
      this.openings.set(id, resolve);
      this.send({ type: 'opening', id, wall, at, atZ });
    });
  }

  private onMessage(m: FusionOut): void {
    if (m.type === 'photoSlot') {
      this.keepPhoto(m.id, m.slot, m.gain);
      return;
    }
    if (m.type === 'opening') {
      this.openings.get(m.id)?.(m.opening);
      this.openings.delete(m.id);
      return;
    }
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
    for (const ck of dirty) this.dirty.add(ck);
    // Rebuild a few chunks now (so a small change shows at once), the rest over the
    // next frames: a big update no longer lands on one frame as a hitch.
    this.drain(4);
  }

  /** Chunks waiting to be rebuilt. */
  private dirty = new Set<string>();

  /** Rebuild waiting chunks for up to `budgetMs`. */
  private drain(budgetMs: number): void {
    if (!this.dirty.size) return;
    const t0 = performance.now();
    for (const ck of this.dirty) {
      this.dirty.delete(ck);
      this.rebuild(ck);
      if (performance.now() - t0 > budgetMs) break;
    }
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
    const pho = new Uint8Array(nv / 3).fill(NO_SLOT);
    const idx = new Uint32Array(ni);
    let ov = 0;
    let oi = 0;
    for (const k of set!) {
      const b = this.bricksMesh.get(k)!;
      pos.set(b.positions, ov);
      nrm.set(b.normals, ov);
      if (b.colors.length === b.positions.length) col.set(b.colors, ov);
      if (b.photos.length * 3 === b.positions.length) pho.set(b.photos, ov / 3);
      const base = ov / 3;
      for (let i = 0; i < b.indices.length; i++) idx[oi + i] = b.indices[i] + base;
      ov += b.positions.length;
      oi += b.indices.length;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('color', new BufferAttribute(col, 3, true));
    g.setAttribute('photo', new BufferAttribute(pho, 1));
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    if (old) {
      old.geometry.dispose();
      old.geometry = g;
      (old.children[0] as Mesh).geometry = g;
      return;
    }
    const mesh = new Mesh(g, this.colored ? this.matColor : this.mat);
    mesh.raycast = () => {};
    mesh.renderOrder = -1;
    // Depth pass (an opaque draw, so it runs before every see-through one).
    const depth = new Mesh(g, this.matDepth);
    depth.raycast = () => {};
    depth.renderOrder = -2;
    depth.visible = !this.colored;
    mesh.add(depth);
    this.group.add(mesh);
    this.pieces.set(ck, mesh);
  }
}
