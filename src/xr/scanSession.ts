import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Shape,
  ShapeGeometry,
  Matrix4,
  Vector3,
  type Object3D,
  type World,
} from '@iwsdk/core';
import type { Vec2 } from '../core/geom2d.js';
import { primaryAxis } from '../core/snapping.js';
import type { Plan } from '../core/plan.js';
import { ScanMap } from '../core/scanMap.js';
import { findStructure, type StructureResult } from '../core/structure.js';
import { INCH_M } from '../core/units.js';
import type { PP } from '../core/wallDetect.js';
import { DepthSampler } from './depthSampler.js';
import { FreeGrid } from '../core/freeSpace.js';
import { idbGet, idbSet } from './idb.js';
import { ingestFrame, type DepthFrame } from '../core/scanIngest.js';
import { ScanRecorder } from './scanRecorder.js';

const STORE_KEY = 'scan-map:v1';
const FREE_KEY = 'scan-free:v1';
const LIVE_EVERY = 3; // s between live wall previews while scanning
const SAMPLE_EVERY = 0.25; // s
const MAX_SHOWN = 60_000;

/**
 * "Scan basement": walk around while the headset depth sensor paints a point
 * map of the room in plan space. Works without Space Setup, at any size.
 * When scanning stops, walls, the ceiling, low areas (ducts/beams) and posts
 * are found and shown as ghosts to accept or discard.
 */
export class ScanSession {
  readonly map = new ScanMap(3, 1_200_000);
  /** Where depth rays passed: tells doorways (seen through) from hidden wall. */
  readonly free = new FreeGrid(4);
  private worker: Worker | null = null;
  private jobId = 0;
  private pending = new Map<number, (r: StructureResult | null) => void>();
  private liveBusy = false;
  private lastLive = 0;
  private liveVersion = -1;
  private eyeP = new Vector3();
  readonly group = new Group();
  scanning = false;
  proposals: StructureResult | null = null;
  /** Review: kinds included, and single items turned off by tapping them. */
  kinds = { walls: true, soffits: true, posts: false };
  excluded = new Set<string>();
  depthOk: boolean | null = null;

  readonly sampler: DepthSampler;
  private dots: Points;
  private dotPos = new Float32Array(MAX_SHOWN * 3);
  private dotCol = new Float32Array(MAX_SHOWN * 3);
  private ghosts = new Group();
  private lastSample = 0;
  private lastShown = -1;
  private lastShowT = 0;
  private tmp = new Vector3();
  /** Every depth frame of the scan, kept so a real scan can be saved and replayed. */
  readonly recorder = new ScanRecorder();
  private col = new Color();
  private loaded: Promise<void>;

  constructor(
    private world: World,
    private root: Object3D,
  ) {
    this.sampler = new DepthSampler(world);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.dotPos, 3));
    g.setAttribute('color', new BufferAttribute(this.dotCol, 3));
    g.setDrawRange(0, 0);
    this.dots = new Points(g, new PointsMaterial({ size: 0.012, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.dots.frustumCulled = false;
    this.dots.raycast = () => {};
    this.group.add(this.dots, this.ghosts, this.doorGhosts);
    this.group.visible = false;
    root.add(this.group);
    this.loaded = Promise.all([
      idbGet<Float32Array>(STORE_KEY).then((a) => {
        if (a && a.length) this.map.load(a);
      }),
      idbGet<{ keys: Float64Array; counts: Uint8Array }>(FREE_KEY).then((f) => {
        if (f && f.keys?.length) this.free.load(f);
      }),
      this.recorder.load(),
    ]).then(() => {});
    try {
      this.worker = new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; res?: StructureResult; error?: string }>) => {
        const done = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (e.data.error) console.warn('[scan] detection failed', e.data.error);
        done?.(e.data.res ?? null);
      };
    } catch {
      this.worker = null; // fall back to the main thread
    }
  }

  get hasMap(): boolean {
    return this.map.size > 0;
  }

  /** Points seen at least twice, plan inches. */
  points(): PP[] {
    return this.map.points(2);
  }

  async start(): Promise<void> {
    await this.loaded;
    this.proposals = null;
    this.clearGhosts();
    this.scanning = true;
    this.depthOk = null;
    this.group.visible = true;
  }

  stop(): void {
    this.scanning = false;
    void idbSet(STORE_KEY, this.map.serialize());
    void idbSet(FREE_KEY, this.free.serialize());
    void this.recorder.save();
  }

  clear(): void {
    this.recorder.clear();
    this.map.clear();
    this.free.clear();
    void idbSet(FREE_KEY, this.free.serialize());
    this.proposals = null;
    this.clearGhosts();
    this.refreshDots(true);
    void idbSet(STORE_KEY, new Float32Array(0));
  }

  /** Per frame while in XR. */
  tick(time: number): void {
    if (!this.scanning) return;
    if (time - this.lastSample >= SAMPLE_EVERY) {
      this.lastSample = time;
      const f = this.captureFrame(time);
      this.depthOk = !!f;
      if (f) {
        ingestFrame(f, this.map, this.free);
        this.recorder.add(f);
      }
    }
    if (time - this.lastShowT > 0.6) {
      this.lastShowT = time;
      this.refreshDots(false);
    }
    // Live preview: walls appear while you walk.
    if (this.liveBusy || !this.livePlan || time - this.lastLive < LIVE_EVERY || this.map.version === this.liveVersion) return;
    if (this.map.size < 2000) return;
    this.lastLive = time;
    this.liveVersion = this.map.version;
    this.liveBusy = true;
    const plan = this.livePlan;
    void this.detect(plan, this.liveEye).then((res) => {
      this.liveBusy = false;
      if (!res || !this.scanning) return;
      this.live = res;
      this.showGhosts(res, plan, true);
    });
  }

  private rootInv = new Matrix4();
  private viewM = new Matrix4();
  private scanT0 = -1;

  /** This frame's depth as a DepthFrame in the plan root's frame. */
  private captureFrame(time: number): DepthFrame | null {
    const c = this.sampler.capture();
    if (!c) return null;
    const root = this.root;
    root.updateWorldMatrix(true, false);
    this.rootInv.copy(root.matrixWorld).invert();
    this.viewM.fromArray(c.viewWorld).premultiply(this.rootInv);
    const pl = this.world.player;
    const local = (o: Object3D): [number, number, number] => {
      const v = root.worldToLocal(o.getWorldPosition(this.tmp));
      return [v.x, v.y, v.z];
    };
    if (this.scanT0 < 0) this.scanT0 = time;
    return {
      t: time - this.scanT0,
      w: this.sampler.width,
      h: this.sampler.height,
      depthMM: c.depthMM,
      proj: c.proj,
      viewToRoot: new Float32Array(this.viewM.elements),
      head: local(pl.head),
      handL: local(pl.gripSpaces.left),
      handR: local(pl.gripSpaces.right),
    };
  }

  /** Plan and eye for live previews (set by the app while scanning). */
  livePlan: Plan | null = null;
  liveEye: Vec2 = { x: 0, y: 0 };
  live: StructureResult | null = null;

  private opts(plan: Plan, eye: Vec2) {
    return {
      eye,
      axisAngle: plan.walls.length ? primaryAxis(plan) : null,
      partitionThickness: plan.settings.wallThickness,
      foundationThickness: plan.settings.foundationThickness,
    };
  }

  /** Run detection, in the worker when available. */
  detect(plan: Plan, eye: Vec2): Promise<StructureResult | null> {
    const pts = this.points();
    if (!this.worker) return Promise.resolve(findStructure(pts, plan, this.opts(plan, eye), this.free));
    const flat = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => {
      flat[i * 3] = p.x;
      flat[i * 3 + 1] = p.y;
      flat[i * 3 + 2] = p.z;
    });
    const fr = this.free.serialize();
    const id = ++this.jobId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage(
        { id, pts: flat, freeKeys: fr.keys, freeCounts: fr.counts, freeVoxel: this.free.voxel, plan: JSON.parse(JSON.stringify(plan)), opts: this.opts(plan, eye) },
        [flat.buffer, fr.keys.buffer, fr.counts.buffer],
      );
    });
  }

  /** Coverage: recolor by height so walls (warm) and floor/ceiling (cool) read apart. */
  private refreshDots(force: boolean): void {
    if (!force && this.map.version === this.lastShown) return;
    this.lastShown = this.map.version;
    const pts = this.map.points(2);
    const step = Math.max(1, Math.ceil(pts.length / MAX_SHOWN));
    let k = 0;
    for (let i = 0; i < pts.length && k < MAX_SHOWN; i += step, k++) {
      const p = pts[i];
      this.dotPos[k * 3] = p.x * INCH_M;
      this.dotPos[k * 3 + 1] = p.z * INCH_M;
      this.dotPos[k * 3 + 2] = p.y * INCH_M;
      this.col.setHSL(0.55 - Math.min(1, Math.max(0, p.z / 100)) * 0.45, 0.9, 0.6);
      this.dotCol[k * 3] = this.col.r;
      this.dotCol[k * 3 + 1] = this.col.g;
      this.dotCol[k * 3 + 2] = this.col.b;
    }
    const g = this.dots.geometry;
    g.setDrawRange(0, k);
    (g.attributes.position as BufferAttribute).needsUpdate = true;
    (g.attributes.color as BufferAttribute).needsUpdate = true;
  }

  /** Find structure in the map and show it as ghosts to review. */
  async analyze(plan: Plan, eye: Vec2): Promise<StructureResult> {
    const res = (await this.detect(plan, eye)) ?? findStructure(this.points(), plan, this.opts(plan, eye), this.free);
    this.live = null;
    this.proposals = res;
    this.excluded.clear();
    this.lastPlan = plan;
    this.showGhosts(res, plan);
    return res;
  }

  private lastPlan: Plan | null = null;

  /** What will be added: included kinds, minus tapped-off items. */
  chosen(): StructureResult | null {
    const r = this.proposals;
    if (!r) return null;
    const keep = <T>(kind: 'walls' | 'soffits' | 'posts', list: T[]) =>
      this.kinds[kind] ? list.filter((_, i) => !this.excluded.has(`${kind}:${i}`)) : [];
    return { ...r, walls: keep('walls', r.walls), soffits: keep('soffits', r.soffits), posts: keep('posts', r.posts) };
  }

  count(): number {
    const c = this.chosen();
    return c ? c.walls.length + c.soffits.length + c.posts.length : 0;
  }

  /** Any proposals to review (even if all are switched off). */
  get reviewing(): boolean {
    const r = this.proposals;
    return !!r && r.walls.length + r.soffits.length + r.posts.length > 0;
  }

  total(kind: 'walls' | 'soffits' | 'posts'): number {
    return this.proposals?.[kind].length ?? 0;
  }

  toggleKind(kind: 'walls' | 'soffits' | 'posts'): void {
    this.kinds[kind] = !this.kinds[kind];
    this.restyle();
  }

  /** Proposal nearest a floor point (plan inches), within reach. */
  pick(p: Vec2): string | null {
    const r = this.proposals;
    if (!r) return null;
    let best: string | null = null;
    let bestD = 18;
    r.walls.forEach((w, i) => {
      if (!this.kinds.walls) return;
      const dx = w.b.x - w.a.x;
      const dy = w.b.y - w.a.y;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / L2));
      const d = Math.hypot(p.x - (w.a.x + dx * t), p.y - (w.a.y + dy * t));
      if (d < bestD) [best, bestD] = [`walls:${i}`, d];
    });
    const inPoly = (poly: Vec2[]) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    r.posts.forEach((q, i) => {
      if (!this.kinds.posts) return;
      const cx = q.poly.reduce((s, v) => s + v.x, 0) / q.poly.length;
      const cy = q.poly.reduce((s, v) => s + v.y, 0) / q.poly.length;
      const d = Math.hypot(p.x - cx, p.y - cy) - 3;
      if (d < bestD) [best, bestD] = [`posts:${i}`, d];
    });
    if (!best) r.soffits.forEach((q, i) => {
      if (this.kinds.soffits && inPoly(q.poly)) best = `soffits:${i}`;
    });
    return best;
  }

  toggle(id: string): void {
    if (this.excluded.has(id)) this.excluded.delete(id);
    else this.excluded.add(id);
    this.restyle();
  }

  /** Highlight the item under the cursor. */
  hover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.restyle();
  }

  private hovered: string | null = null;

  private liveMode = false;

  private restyle(): void {
    if (this.liveMode) {
      // While scanning: everything found so far, faint, posts left out.
      for (const c of this.ghosts.children) {
        const kind = (c.userData.id as string).split(':')[0];
        c.visible = kind !== 'posts';
        (c as Mesh).material = kind === 'walls' ? this.liveMat : (c.userData.mat as MeshBasicMaterial);
      }
      for (const c of this.doorGhosts.children) c.visible = true;
      return;
    }
    for (const c of this.doorGhosts.children) c.visible = this.kinds.walls && !this.excluded.has(c.userData.door as string);
    for (const c of this.ghosts.children) {
      const id = c.userData.id as string;
      const kind = id.split(':')[0] as 'walls' | 'soffits' | 'posts';
      const off = !this.kinds[kind] || this.excluded.has(id);
      c.visible = this.kinds[kind];
      const m = c as Mesh;
      const base = m.userData.mat as MeshBasicMaterial;
      m.material = off ? this.offMat : id === this.hovered ? this.hoverMat : base;
    }
  }

  discard(): void {
    this.proposals = null;
    this.excluded.clear();
    this.clearGhosts();
  }

  /** After accept/discard, hide the coverage so the plan reads clearly. */
  hide(): void {
    this.group.visible = false;
  }

  private clearGhosts(): void {
    for (const c of [...this.doorGhosts.children]) {
      this.doorGhosts.remove(c);
      (c as Mesh).geometry.dispose();
    }
    for (const c of [...this.ghosts.children]) {
      this.ghosts.remove(c);
      const m = c as Mesh;
      m.geometry?.dispose();
    }
  }

  private wallMat = new MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide });
  private soffitMat = new MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.4, depthWrite: false, side: DoubleSide });
  private postMat = new MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.5, depthWrite: false });
  private doorMat = new MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.55, depthWrite: false });
  private doorGhosts = new Group();
  private liveMat = new MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide });
  private offMat = new MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
  private hoverMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide });

  private showGhosts(res: StructureResult, plan: Plan, live = false): void {
    this.clearGhosts();
    this.liveMode = live;
    const H = res.ceiling ?? plan.settings.wallHeight;
    const tag = (m: Mesh, id: string, mat: MeshBasicMaterial) => {
      m.userData.id = id;
      m.userData.mat = mat;
    };
    res.walls.forEach((w, i) => {
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const m = new Mesh(new BoxGeometry(len * INCH_M, H * INCH_M, w.thickness * INCH_M), this.wallMat);
      m.position.set(((w.a.x + w.b.x) / 2) * INCH_M, (H / 2) * INCH_M, ((w.a.y + w.b.y) / 2) * INCH_M);
      m.rotation.y = -Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
      tag(m, `walls:${i}`, this.wallMat);
      this.ghosts.add(m);
      // Doorways: a blue box in the opening, part of the wall's ghost.
      for (const o of w.openings) {
        const dm = new Mesh(new BoxGeometry(o.width * INCH_M, o.height * INCH_M, (w.thickness + 1) * INCH_M), this.doorMat);
        dm.position.set(o.center.x * INCH_M, (o.height / 2) * INCH_M, o.center.y * INCH_M);
        dm.rotation.y = m.rotation.y;
        dm.raycast = () => {};
        dm.userData.door = `walls:${i}`;
        this.doorGhosts.add(dm);
      }
    });
    const flat = (poly: Vec2[], z: number, mat: MeshBasicMaterial, id: string) => {
      const s = new Shape(poly.map((p) => ({ x: p.x * INCH_M, y: p.y * INCH_M }) as never));
      const m = new Mesh(new ShapeGeometry(s), mat);
      m.rotation.x = Math.PI / 2; // shape xy -> plan xz
      m.position.y = z * INCH_M;
      tag(m, id, mat);
      this.ghosts.add(m);
    };
    res.soffits.forEach((s, i) => flat(s.poly, s.bottom, this.soffitMat, `soffits:${i}`));
    res.posts.forEach((p, i) => {
      const xs = p.poly.map((q) => q.x);
      const ys = p.poly.map((q) => q.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...ys) - Math.min(...ys);
      const m = new Mesh(new BoxGeometry(w * INCH_M, H * INCH_M, d * INCH_M), this.postMat);
      m.position.set(((Math.max(...xs) + Math.min(...xs)) / 2) * INCH_M, (H / 2) * INCH_M, ((Math.max(...ys) + Math.min(...ys)) / 2) * INCH_M);
      tag(m, `posts:${i}`, this.postMat);
      this.ghosts.add(m);
    });
    for (const c of this.ghosts.children) c.raycast = () => {};
    this.restyle();
  }
}
