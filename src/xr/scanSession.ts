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
import { idbGet, idbSet } from './idb.js';

const STORE_KEY = 'scan-map:v1';
const SAMPLE_EVERY = 0.25; // s
const MAX_SHOWN = 60_000;

/**
 * "Scan basement": walk around while the headset depth sensor paints a point
 * map of the room in plan space. Works without Space Setup, at any size.
 * When scanning stops, walls, the ceiling, low areas (ducts/beams) and posts
 * are found and shown as ghosts to accept or discard.
 */
export class ScanSession {
  readonly map = new ScanMap(2);
  readonly group = new Group();
  scanning = false;
  proposals: StructureResult | null = null;
  depthOk: boolean | null = null;

  private sampler: DepthSampler;
  private dots: Points;
  private dotPos = new Float32Array(MAX_SHOWN * 3);
  private dotCol = new Float32Array(MAX_SHOWN * 3);
  private ghosts = new Group();
  private lastSample = 0;
  private lastShown = -1;
  private lastShowT = 0;
  private tmp = new Vector3();
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
    this.group.add(this.dots, this.ghosts);
    this.group.visible = false;
    root.add(this.group);
    this.loaded = idbGet<Float32Array>(STORE_KEY).then((a) => {
      if (a && a.length) this.map.load(a);
    });
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
  }

  clear(): void {
    this.map.clear();
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
      const root = this.root;
      root.updateWorldMatrix(true, false);
      const tmp = this.tmp;
      const map = this.map;
      const n = this.sampler.sample((x, y, z) => {
        tmp.set(x, y, z);
        root.worldToLocal(tmp);
        map.add(tmp.x / INCH_M, tmp.z / INCH_M, tmp.y / INCH_M);
      });
      this.depthOk = n >= 0;
    }
    if (time - this.lastShowT > 0.6) {
      this.lastShowT = time;
      this.refreshDots(false);
    }
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

  /** Find structure in the map and show it as ghosts. */
  analyze(plan: Plan, eye: Vec2): StructureResult {
    const pts = this.points();
    const axis = primaryAxis(plan);
    const res = findStructure(pts, plan, {
      eye,
      axisAngle: axis,
      partitionThickness: plan.settings.wallThickness,
      foundationThickness: plan.settings.foundationThickness,
    });
    this.proposals = res;
    this.showGhosts(res, plan);
    return res;
  }

  count(): number {
    const r = this.proposals;
    return r ? r.walls.length + r.soffits.length + r.posts.length : 0;
  }

  discard(): void {
    this.proposals = null;
    this.clearGhosts();
  }

  /** After accept/discard, hide the coverage so the plan reads clearly. */
  hide(): void {
    this.group.visible = false;
  }

  private clearGhosts(): void {
    for (const c of [...this.ghosts.children]) {
      this.ghosts.remove(c);
      const m = c as Mesh;
      m.geometry?.dispose();
    }
  }

  private wallMat = new MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide });
  private soffitMat = new MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.4, depthWrite: false, side: DoubleSide });
  private postMat = new MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.5, depthWrite: false });

  private showGhosts(res: StructureResult, plan: Plan): void {
    this.clearGhosts();
    const H = res.ceiling ?? plan.settings.wallHeight;
    for (const w of res.walls) {
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const m = new Mesh(new BoxGeometry(len * INCH_M, H * INCH_M, w.thickness * INCH_M), this.wallMat);
      m.position.set(((w.a.x + w.b.x) / 2) * INCH_M, (H / 2) * INCH_M, ((w.a.y + w.b.y) / 2) * INCH_M);
      m.rotation.y = -Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
      this.ghosts.add(m);
    }
    const flat = (poly: Vec2[], z: number, mat: MeshBasicMaterial) => {
      const s = new Shape(poly.map((p) => ({ x: p.x * INCH_M, y: p.y * INCH_M }) as never));
      const m = new Mesh(new ShapeGeometry(s), mat);
      m.rotation.x = Math.PI / 2; // shape xy -> plan xz
      m.position.y = z * INCH_M;
      this.ghosts.add(m);
    };
    for (const s of res.soffits) flat(s.poly, s.bottom, this.soffitMat);
    for (const p of res.posts) {
      const xs = p.poly.map((q) => q.x);
      const ys = p.poly.map((q) => q.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...ys) - Math.min(...ys);
      const m = new Mesh(new BoxGeometry(w * INCH_M, H * INCH_M, d * INCH_M), this.postMat);
      m.position.set(((Math.max(...xs) + Math.min(...xs)) / 2) * INCH_M, (H / 2) * INCH_M, ((Math.max(...ys) + Math.min(...ys)) / 2) * INCH_M);
      this.ghosts.add(m);
    }
    for (const c of this.ghosts.children) c.raycast = () => {};
  }
}
