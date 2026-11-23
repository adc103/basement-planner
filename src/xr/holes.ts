import {
  AlwaysDepth,
  AlwaysStencilFunc,
  BoxGeometry,
  EqualStencilFunc,
  FrontSide,
  Group,
  LessEqualDepth,
  Mesh,
  MeshBasicMaterial,
  Plane,
  ReplaceStencilOp,
  Vector3,
  type Camera,
  type Object3D,
} from '@iwsdk/core';
import type { Plan } from '../core/plan.js';
import { wallEnds } from '../core/ops.js';
import { INCH_M } from '../core/units.js';
import type { RoomMesh } from './roomMesh.js';

/** A hole you plan in a real wall: a new opening, or the whole wall torn out. */
interface Hole {
  key: string;
  wallId: string;
  /** Plan inches: wall start, unit direction, unit normal, half thickness. */
  a: { x: number; y: number };
  dir: { x: number; y: number };
  n: { x: number; y: number };
  half: number;
  /** Along the wall from a, and heights. */
  s0: number;
  s1: number;
  z0: number;
  z1: number;
  /** The whole wall (demolished). */
  whole: boolean;
}

interface Slot {
  ref: number;
  /** Pass 1: marks the hole where it is in view (nothing nearer in front). */
  mark: Mesh;
  /** Pass 2: clears the depth there and paints it dark (the far room is drawn over it). */
  clear: Mesh;
  content: Group;
  mat: MeshBasicMaterial;
  plane: Plane;
  chunks: Map<string, Mesh>;
  hole: Hole | null;
}

const SLOTS = 4;

/**
 * Virtual holes: see the room behind a real wall through an opening you plan to cut,
 * or through a whole wall you plan to remove, drawn 1:1 from the scanned room in its
 * photo colors. Stencil: the hole marks its pixels (where nothing nearer stands in
 * front of it), clears the depth there, and the scan is drawn again in it, clipped to
 * what lies beyond the wall. Where the far side wasn't scanned the hole shows dark.
 */
export class VirtualHoles {
  readonly group = new Group();
  private slots: Slot[] = [];
  private box = new BoxGeometry(1, 1, 1);
  private eye = new Vector3();
  private p = new Vector3();
  private nrm = new Vector3();
  /** Walls shown as holes (removed): the plan view stops drawing their model. */
  removedWalls: string[] = [];

  constructor(
    private root: Object3D,
    private mesh: RoomMesh,
  ) {
    this.group.name = 'virtual-holes';
    root.add(this.group);
    for (let i = 0; i < SLOTS; i++) this.slots.push(this.makeSlot(i + 1));
  }

  private makeSlot(ref: number): Slot {
    const mark = new Mesh(
      this.box,
      new MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        depthFunc: LessEqualDepth,
        side: FrontSide,
        stencilWrite: true,
        stencilRef: ref,
        stencilFunc: AlwaysStencilFunc,
        stencilZPass: ReplaceStencilOp,
      }),
    );
    const clearMat = new MeshBasicMaterial({
      color: 0x14181e,
      depthFunc: AlwaysDepth,
      depthWrite: true,
      side: FrontSide,
      stencilWrite: true,
      stencilRef: ref,
      stencilFunc: EqualStencilFunc,
      stencilWriteMask: 0,
    });
    clearMat.onBeforeCompile = (sh) => {
      // As far as it gets: the room behind (and anything planned in it) draws over it.
      sh.fragmentShader = sh.fragmentShader.replace(/}\s*$/, '  gl_FragDepth = 1.0;\n}');
    };
    clearMat.customProgramCacheKey = () => 'hole-clear';
    const clear = new Mesh(this.box, clearMat);
    // The scan's own depth pass is -2; holes go after it and before everything else.
    mark.renderOrder = -1.9;
    clear.renderOrder = -1.8;
    for (const m of [mark, clear]) {
      m.raycast = () => {};
      m.visible = false;
      this.group.add(m);
    }
    const plane = new Plane();
    const mat = this.mesh.portalMaterial(ref, plane);
    const content = new Group();
    content.visible = false;
    this.group.add(content);
    return { ref, mark, clear, content, mat, plane, chunks: new Map(), hole: null };
  }

  /** The holes the plan asks for. */
  private holes(plan: Plan): Hole[] {
    const out: Hole[] = [];
    for (const w of plan.walls) {
      if (w.kind !== 'existing') continue;
      const { a, b } = wallEnds(plan, w);
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1) continue;
      const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const base = { wallId: w.id, a, dir, n: { x: -dir.y, y: dir.x }, half: w.thickness / 2 };
      if (w.demolish) {
        out.push({ ...base, key: `w:${w.id}`, s0: 0, s1: L, z0: 0, z1: w.height, whole: true });
        continue;
      }
      for (const o of plan.openings) {
        if (o.wallId !== w.id || o.kind !== 'new') continue;
        out.push({ ...base, key: `o:${o.id}`, s0: o.offset - o.width / 2, s1: o.offset + o.width / 2, z0: o.sill, z1: o.sill + o.height, whole: false });
      }
    }
    return out;
  }

  /** Per frame: pick the nearest holes in view and draw them. */
  update(plan: Plan, camera: Camera): void {
    camera.getWorldPosition(this.eye);
    this.root.updateWorldMatrix(true, false);
    const local = this.root.worldToLocal(this.p.copy(this.eye));
    const eye = { x: local.x / INCH_M, y: local.z / INCH_M };
    const all = this.holes(plan);
    const ranked = all
      .map((h) => {
        const s = Math.max(h.s0, Math.min(h.s1, (eye.x - h.a.x) * h.dir.x + (eye.y - h.a.y) * h.dir.y));
        const across = (eye.x - h.a.x) * h.n.x + (eye.y - h.a.y) * h.n.y;
        return { h, across, d: Math.hypot(eye.x - (h.a.x + h.dir.x * s), eye.y - (h.a.y + h.dir.y * s)) };
      })
      // Standing in the hole itself: nothing to look through.
      .filter((r) => Math.abs(r.across) > r.h.half + 4)
      .sort((x, y) => x.d - y.d)
      .slice(0, SLOTS);
    const hasMesh = this.mesh.triangles > 0;
    this.slots.forEach((slot, i) => {
      const r = ranked[i];
      slot.hole = r?.h ?? null;
      const on = !!r;
      slot.mark.visible = slot.clear.visible = on;
      slot.content.visible = on && hasMesh;
      if (!r) return;
      this.place(slot, r.h, Math.sign(r.across) || 1);
      if (hasMesh) this.syncChunks(slot);
    });
    const removed = all.filter((h) => h.whole).map((h) => h.wallId);
    if (removed.join() !== this.removedWalls.join()) this.removedWalls = removed;
  }

  /** Size the hole's box and point its clip plane at the wall's far face (from `side`). */
  private place(slot: Slot, h: Hole, side: number): void {
    const mid = (h.s0 + h.s1) / 2;
    const cx = h.a.x + h.dir.x * mid;
    const cy = h.a.y + h.dir.y * mid;
    const ang = Math.atan2(h.dir.y, h.dir.x);
    const depth = (h.half * 2 + 1) * INCH_M;
    for (const m of [slot.mark, slot.clear]) {
      m.position.set(cx * INCH_M, ((h.z0 + h.z1) / 2) * INCH_M, cy * INCH_M);
      m.rotation.set(0, -ang, 0);
      m.scale.set((h.s1 - h.s0) * INCH_M, (h.z1 - h.z0) * INCH_M, depth);
    }
    // Far face, half an inch beyond it, facing away from you: the room behind is kept.
    const off = (h.half + 0.5) * -side;
    this.p.set((cx + h.n.x * off) * INCH_M, 0, (cy + h.n.y * off) * INCH_M);
    this.root.localToWorld(this.p);
    this.nrm.set(-h.n.x * side, 0, -h.n.y * side).transformDirection(this.root.matrixWorld);
    slot.plane.setFromNormalAndCoplanarPoint(this.nrm, this.p);
  }

  /** The scan's chunks, drawn again for this hole (shared geometry). */
  private syncChunks(slot: Slot): void {
    const seen = new Set<string>();
    for (const [k, piece] of this.mesh.chunks()) {
      seen.add(k);
      let m = slot.chunks.get(k);
      if (!m) {
        m = new Mesh(piece.geometry, slot.mat);
        m.raycast = () => {};
        m.renderOrder = -1.6;
        slot.chunks.set(k, m);
        slot.content.add(m);
      } else if (m.geometry !== piece.geometry) m.geometry = piece.geometry;
    }
    for (const [k, m] of slot.chunks) {
      if (seen.has(k)) continue;
      slot.content.remove(m);
      slot.chunks.delete(k);
    }
  }
}
