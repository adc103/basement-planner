import {
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
  Vector3,
  type Camera,
} from '@iwsdk/core';
import { add, scale, type Vec2 } from '../core/geom2d.js';
import { wallEnds } from '../core/ops.js';
import type { Plan, Wall } from '../core/plan.js';
import { formatLength, INCH_M } from '../core/units.js';
import { computeFootprints, footprintPoly, wallPrisms, type WallFootprint } from '../core/wallGeometry.js';
import { TextLabel } from './labels.js';

export type WallViewMode = 'solid' | 'ghost';

/** Plan (inches) -> plan-root local (meters). y is height. */
export function planToLocal(p: Vec2, heightIn = 0, out = new Vector3()): Vector3 {
  return out.set(p.x * INCH_M, heightIn * INCH_M, p.y * INCH_M);
}

export function localToPlan(v: Vector3): Vec2 {
  return { x: v.x / INCH_M, y: v.z / INCH_M };
}

interface WallLabel {
  label: TextLabel;
  mid: Vec2;
  normal: Vec2;
  half: number;
  /** Label height above the floor, inches. */
  z: number;
}

/**
 * Builds three.js meshes for the plan under `root` (the plan's local frame).
 * Rebuilt wholesale whenever the plan changes; plans are small.
 */
export class PlanView {
  readonly root = new Group();
  private content = new Group();
  private labels: WallLabel[] = [];
  private refMarkers: TextLabel[] = [];
  mode: WallViewMode = 'ghost';
  showLabels = true;
  /** Meshes for raycasting, wallId in userData. */
  wallMeshes: Mesh[] = [];

  private matNew = new MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.95, metalness: 0, side: DoubleSide });
  private matExisting = new MeshStandardMaterial({
    color: 0x8a96a3,
    roughness: 1,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: DoubleSide,
  });
  private matHighlight = new MeshStandardMaterial({
    color: 0xff6b5a,
    emissive: new Color(0x551a10),
    roughness: 0.9,
    transparent: true,
    opacity: 0.75,
    side: DoubleSide,
  });
  private edgeMat = new LineBasicMaterial({ color: 0x2b3440 });
  private edgeMatExisting = new LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.6 });
  private highlighted: string | null = null;

  constructor() {
    this.root.add(this.content);
    this.root.name = 'plan-root';
    this.applyMode();
  }

  setMode(mode: WallViewMode): void {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    const ghost = this.mode === 'ghost';
    this.matNew.transparent = ghost;
    this.matNew.opacity = ghost ? 0.38 : 1;
    this.matNew.depthWrite = !ghost;
    this.matNew.needsUpdate = true;
  }

  rebuild(plan: Plan): void {
    for (const c of [...this.content.children]) {
      this.content.remove(c);
      c.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments) o.geometry.dispose();
      });
    }
    for (const l of this.labels) l.label.dispose();
    for (const l of this.refMarkers) l.dispose();
    this.labels = [];
    this.refMarkers = [];
    this.wallMeshes = [];

    const fps = computeFootprints(plan);
    for (const wall of plan.walls) {
      const fp = fps.get(wall.id);
      if (!fp) continue;
      this.buildWall(plan, wall, fp);
    }

    if (plan.reference) {
      const { r1, r2 } = plan.reference;
      [r1, r2].forEach((r, i) => {
        const l = new TextLabel(`Ref ${i + 1}`, { bg: 'rgba(160,90,10,0.9)', height: 0.05 });
        planToLocal(r, 2, l.sprite.position);
        this.content.add(l.sprite);
        this.refMarkers.push(l);
      });
    }
    this.highlighted = null;
  }

  private buildWall(plan: Plan, wall: Wall, fp: WallFootprint): void {
    const existing = wall.kind === 'existing';
    const prisms = existing
      ? [{ wallId: wall.id, poly: footprintPoly(fp), z0: 0, z1: wall.height }]
      : wallPrisms(fp, wall, plan.openings);
    const pos: number[] = [];
    for (const p of prisms) appendPrism(pos, p.poly, p.z0, p.z1);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, existing ? this.matExisting : this.matNew);
    mesh.userData.wallId = wall.id;
    mesh.userData.kind = wall.kind;
    mesh.renderOrder = existing ? 1 : 2;
    this.content.add(mesh);
    this.wallMeshes.push(mesh);
    const edges = new LineSegments(new EdgesGeometry(geo, 25), existing ? this.edgeMatExisting : this.edgeMat);
    edges.renderOrder = 3;
    edges.raycast = () => {};
    this.content.add(edges);

    if (!existing) {
      const { a, b } = wallEnds(plan, wall);
      const label = new TextLabel(formatLength(fp.length), { height: 0.055 });
      this.content.add(label.sprite);
      this.labels.push({
        label,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        normal: fp.normal,
        half: fp.half,
        z: Math.min(wall.height / 2, 54),
      });
      for (const o of plan.openings.filter((x) => x.wallId === wall.id)) {
        const center = add(a, scale(fp.dir, o.offset));
        const ol = new TextLabel(`${o.type === 'door' ? 'Door' : 'Opening'} ${widthText(o.width)}`, {
          height: 0.04,
          bg: 'rgba(30,70,120,0.85)',
        });
        this.content.add(ol.sprite);
        this.labels.push({
          label: ol,
          mid: center,
          normal: fp.normal,
          half: fp.half,
          z: Math.min(o.sill + o.height + 5, wall.height - 3),
        });
      }
    }
  }

  private tmpCam = new Vector3();
  private tmpLocal = new Vector3();

  /** Keep labels on the viewer's side of each wall, at a readable height. */
  updateLabels(camera: Camera): void {
    camera.getWorldPosition(this.tmpCam);
    this.root.worldToLocal(this.tmpCam);
    const eye = localToPlan(this.tmpCam);
    for (const l of this.labels) {
      l.label.sprite.visible = this.showLabels;
      const side = Math.sign((eye.x - l.mid.x) * l.normal.x + (eye.y - l.mid.y) * l.normal.y) || 1;
      const off = l.half + 2.5;
      const p = { x: l.mid.x + l.normal.x * off * side, y: l.mid.y + l.normal.y * off * side };
      planToLocal(p, l.z, this.tmpLocal);
      l.label.sprite.position.copy(this.tmpLocal);
    }
  }

  setHighlight(wallId: string | null): void {
    if (wallId === this.highlighted) return;
    for (const m of this.wallMeshes) {
      const isExisting = m.userData.kind === 'existing';
      m.material = m.userData.wallId === wallId ? this.matHighlight : isExisting ? this.matExisting : this.matNew;
    }
    this.highlighted = wallId;
  }
}

/** Append a vertical prism (polygon footprint extruded z0..z1, inches) as triangles in meters. */
export function appendPrism(out: number[], poly: Vec2[], z0: number, z1: number): void {
  const n = poly.length;
  if (n < 3) return;
  const y0 = z0 * INCH_M;
  const y1 = z1 * INCH_M;
  const P = poly.map((p) => [p.x * INCH_M, p.y * INCH_M] as const);
  const push = (x: number, y: number, z: number) => out.push(x, y, z);
  // Sides
  for (let i = 0; i < n; i++) {
    const [ax, az] = P[i];
    const [bx, bz] = P[(i + 1) % n];
    push(ax, y0, az);
    push(bx, y0, bz);
    push(bx, y1, bz);
    push(ax, y0, az);
    push(bx, y1, bz);
    push(ax, y1, az);
  }
  // Caps
  const contour = P.map(([x, z]) => new Vector2(x, z));
  const tris = ShapeUtils.triangulateShape(contour, []);
  for (const [i, j, k] of tris) {
    push(P[i][0], y1, P[i][1]);
    push(P[k][0], y1, P[k][1]);
    push(P[j][0], y1, P[j][1]);
    push(P[i][0], y0, P[i][1]);
    push(P[j][0], y0, P[j][1]);
    push(P[k][0], y0, P[k][1]);
  }
}

/** Door widths read better in inches (32"), long openings in feet. */
export function widthText(inches: number): string {
  return inches < 60 ? `${+inches.toFixed(2)}"` : formatLength(inches);
}
