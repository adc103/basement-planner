import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
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
  type Material,
} from '@iwsdk/core';
import { add, scale, type Vec2 } from '../core/geom2d.js';
import { wallEnds } from '../core/ops.js';
import type { CeilingType, Finish, Plan, Wall } from '../core/plan.js';
import { roomCeiling } from '../core/ops.js';
import { FINISH_COLORS, FINISH_NAMES, MARKER_INFO } from '../core/plan2d.js';
import { generateFraming, type Member, type MemberKind } from '../core/framing.js';

const LUMBER_COLORS: Record<MemberKind, string> = {
  plate: '#d8b47e',
  stud: '#e3c48f',
  king: '#c99d5e',
  jack: '#b8874a',
  header: '#9a6a35',
  cripple: '#e3c48f',
};
import { findRoomFaces, openArea, resolveRooms } from '../core/rooms.js';
import { formatLength, INCH_M } from '../core/units.js';
import { computeFootprints, footprintPoly, wallPrisms, type WallFootprint } from '../core/wallGeometry.js';
import { TextLabel } from './labels.js';

export type WallViewMode = 'solid' | 'ghost' | 'xray';

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
  /** Utility pin meshes for raycasting, markerId in userData. */
  markerMeshes: Mesh[] = [];

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
  private matHover = new MeshStandardMaterial({
    color: 0x9cc7ff,
    emissive: new Color(0x10305a),
    roughness: 0.9,
    transparent: true,
    opacity: 0.6,
    side: DoubleSide,
  });
  private matSelected = new MeshStandardMaterial({
    color: 0x3d8bff,
    emissive: new Color(0x0d2a55),
    roughness: 0.9,
    transparent: true,
    opacity: 0.7,
    side: DoubleSide,
  });
  private matObstacle = new MeshStandardMaterial({
    color: 0xa08a6a,
    roughness: 1,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: DoubleSide,
  });
  private edgeMatObstacle = new LineBasicMaterial({ color: 0xe0c49a, transparent: true, opacity: 0.8 });
  private tapeMat = new MeshBasicMaterial({ color: 0xffd60a });
  private tapeGeo = new CylinderGeometry(0.003, 0.003, 1, 6, 1).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  private edgeMat = new LineBasicMaterial({ color: 0x2b3440 });
  private edgeMatExisting = new LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.6 });
  private highlighted: string | null = null;
  private highlightKind: 'hover' | 'danger' = 'danger';
  private selected: string | null = null;
  private extraLabels: TextLabel[] = [];

  constructor() {
    this.root.add(this.content);
    this.root.name = 'plan-root';
    this.applyMode();
  }

  setMode(mode: WallViewMode): void {
    const rebuild = (mode === 'xray') !== (this.mode === 'xray');
    this.mode = mode;
    this.applyMode();
    if (rebuild && this.lastPlan) this.rebuild(this.lastPlan);
  }

  /** Materials that real-world depth should be able to hide (planned content only). */
  occludableMaterials(): Material[] {
    return [this.matNew, this.matHover, this.matSelected, this.matHighlight, this.matLumber, this.matSoffit];
  }

  private applyMode(): void {
    const ghost = this.mode === 'ghost';
    const xray = this.mode === 'xray';
    // Stays transparent in solid mode too: depth occlusion fades pixels via alpha.
    this.matNew.transparent = true;
    this.matNew.opacity = xray ? 0.1 : ghost ? 0.38 : 1;
    this.matNew.depthWrite = !ghost && !xray;
    this.matNew.needsUpdate = true;
  }

  private lastPlan: Plan | null = null;
  private matLumber = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  private lumberGeo = new BoxGeometry(1, 1, 1);
  framing: Member[] = [];
  private markerGeo = new SphereGeometry(1.6 * INCH_M, 16, 12);
  private markerMats = new Map<string, MeshStandardMaterial>();

  rebuild(plan: Plan): void {
    this.lastPlan = plan;
    for (const c of [...this.content.children]) {
      this.content.remove(c);
      c.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
        else if ((o instanceof Mesh || o instanceof LineSegments) && !o.userData.shared) o.geometry.dispose();
      });
    }
    for (const l of this.labels) l.label.dispose();
    for (const l of this.refMarkers) l.dispose();
    for (const l of this.extraLabels) l.dispose();
    this.extraLabels = [];
    this.labels = [];
    this.refMarkers = [];
    this.wallMeshes = [];
    this.markerMeshes = [];

    const fps = computeFootprints(plan);
    for (const wall of plan.walls) {
      const fp = fps.get(wall.id);
      if (!fp) continue;
      this.buildWall(plan, wall, fp);
    }

    this.buildRooms(plan);
    this.buildObstacles(plan);
    this.buildMarkers(plan);
    this.buildSoffits(plan);
    if (plan.settings.showCeiling) this.buildCeilings(plan);
    this.framing = [];
    if (this.mode === 'xray') this.buildFraming(plan);
    this.buildMeasures(plan);

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
    this.applyMaterials();
  }

  private roomMeshes = new Map<string, Mesh>();
  private selectedRoom: string | null = null;
  private roomMats = new Map<string, MeshBasicMaterial>();
  private matRoomSelected = new MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.3, depthWrite: false, side: DoubleSide });

  private roomMat(finish: Finish): MeshBasicMaterial {
    let m = this.roomMats.get(finish);
    if (!m) {
      const opacity: Record<Finish, number> = { none: 0.12, carpet: 0.8, lvp: 0.85, tile: 0.85, concrete: 0.55, epoxy: 0.75 };
      m = new MeshBasicMaterial({
        color: finish === 'none' ? new Color(FINISH_COLORS.none) : 0xffffff,
        map: finish === 'none' ? null : floorTexture(finish),
        transparent: true,
        opacity: opacity[finish],
        depthWrite: false,
        side: DoubleSide,
      });
      this.roomMats.set(finish, m);
    }
    return m;
  }


  /** Flat polygon (plan inches) with holes at a height (m), with 4 ft texture UVs. */
  private flatArea(outline: Array<{ x: number; y: number }>, holes: Array<Array<{ x: number; y: number }>>, y: number): BufferGeometry {
    const contour = outline.map((p) => new Vector2(p.x * INCH_M, p.y * INCH_M));
    const hs = holes.map((h) => h.map((p) => new Vector2(p.x * INCH_M, p.y * INCH_M)));
    const all = [...contour, ...hs.flat()];
    const pos: number[] = [];
    const uv: number[] = [];
    for (const tri of ShapeUtils.triangulateShape(contour, hs)) {
      for (const t of tri) {
        pos.push(all[t].x, y, all[t].y);
        uv.push(all[t].x / 1.2192, all[t].y / 1.2192);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    return geo;
  }

  private buildRooms(plan: Plan): void {
    this.roomMeshes.clear();
    const faces = findRoomFaces(plan);
    const open = openArea(plan, faces);
    if (open) {
      const mesh = new Mesh(this.flatArea(open.outline, open.holes, 0.003), this.roomMat(plan.settings.floorFinish));
      mesh.raycast = () => {};
      this.content.add(mesh);
    }
    const rooms = resolveRooms(plan, faces);
    const byKey = new Map<string, (typeof rooms)[number]>();
    for (const r of rooms) if (r.face) byKey.set(r.face.key, r);
    for (const face of faces) {
      const r = byKey.get(face.key);
      const geo = this.flatArea(face.inner, face.holes, 0.004);
      const mesh = new Mesh(geo, this.roomMat(r?.room.finish ?? 'none'));
      mesh.userData.baseMat = mesh.material;
      mesh.renderOrder = 0;
      mesh.raycast = () => {};
      this.content.add(mesh);
      this.roomMeshes.set(face.key, mesh);
      const text = r
        ? `${r.room.name}  ${face.areaSqFt.toFixed(0)} sq ft${r.room.finish !== 'none' ? `  ${FINISH_NAMES[r.room.finish]}` : ''}`
        : `${face.areaSqFt.toFixed(0)} sq ft`;
      const l = new TextLabel(text, r ? { height: 0.06, bg: 'rgba(20,40,70,0.88)' } : { height: 0.04, bg: 'rgba(0,0,0,0.55)' });
      planToLocal(face.center, r ? 40 : 30, l.sprite.position);
      this.content.add(l.sprite);
      this.extraLabels.push(l);
    }
    this.applyRoomSelection();
  }

  setSelectedRoom(key: string | null): void {
    this.selectedRoom = key;
    this.applyRoomSelection();
  }

  private applyRoomSelection(): void {
    for (const [key, m] of this.roomMeshes) m.material = key === this.selectedRoom ? this.matRoomSelected : (m.userData.baseMat as MeshBasicMaterial);
  }

  private buildFraming(plan: Plan): void {
    const members = generateFraming(plan);
    this.framing = members;
    if (!members.length) return;
    const mesh = new InstancedMesh(this.lumberGeo, this.matLumber, members.length);
    mesh.userData.shared = true;
    mesh.raycast = () => {};
    const m4 = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const size = new Vector3();
    const up = new Vector3(0, 1, 0);
    const color = new Color();
    const byWall = new Map(plan.walls.map((w) => [w.id, w]));
    members.forEach((mb, i) => {
      const w = byWall.get(mb.wallId)!;
      const { a, b } = wallEnds(plan, w);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const c = { x: a.x + dir.x * mb.s, y: a.y + dir.y * mb.s };
      planToLocal(c, (mb.z0 + mb.z1) / 2, pos);
      q.setFromAxisAngle(up, -Math.atan2(dir.y, dir.x));
      size.set(mb.len * INCH_M, (mb.z1 - mb.z0) * INCH_M, mb.depth * INCH_M);
      m4.compose(pos, q, size);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, color.set(LUMBER_COLORS[mb.kind]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.content.add(mesh);
  }

  private matSoffit = new MeshStandardMaterial({ color: 0xecebff, roughness: 0.95, transparent: true, opacity: 0.55, side: DoubleSide });
  private ceilingMats = new Map<CeilingType, MeshBasicMaterial>();

  private ceilingMat(type: CeilingType): MeshBasicMaterial {
    let m = this.ceilingMats.get(type);
    if (!m) {
      m = new MeshBasicMaterial({ map: ceilingTexture(type), transparent: true, opacity: type === 'drywall' ? 0.7 : 0.85, depthWrite: false, side: DoubleSide });
      this.ceilingMats.set(type, m);
    }
    return m;
  }

  private buildSoffits(plan: Plan): void {
    for (const sf of plan.soffits) {
      const top = plan.settings.wallHeight;
      if (sf.bottom >= top) continue;
      const pos: number[] = [];
      appendPrism(pos, sf.poly, sf.bottom, top);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = new Mesh(geo, this.matSoffit);
      mesh.raycast = () => {};
      mesh.renderOrder = 2;
      this.content.add(mesh);
      const edges = new LineSegments(new EdgesGeometry(geo, 25), this.edgeMat);
      edges.raycast = () => {};
      this.content.add(edges);
      const c = sf.poly.reduce((acc, p) => ({ x: acc.x + p.x / sf.poly.length, y: acc.y + p.y / sf.poly.length }), { x: 0, y: 0 });
      const l = new TextLabel(`Soffit ${formatLength(sf.bottom)}`, { height: 0.035, bg: 'rgba(70,60,160,0.85)' });
      planToLocal(c, sf.bottom - 3, l.sprite.position);
      this.content.add(l.sprite);
      this.extraLabels.push(l);
    }
  }

  /** Ceiling planes over every closed area, in each room's type and height. */
  private buildCeilings(plan: Plan): void {
    const faces = findRoomFaces(plan);
    const rooms = resolveRooms(plan, faces);
    const open = openArea(plan, faces);
    if (open) {
      const c = roomCeiling(plan, null);
      const mesh = new Mesh(this.flatArea(open.outline, open.holes, c.height * INCH_M - 0.003), this.ceilingMat(c.type));
      mesh.raycast = () => {};
      mesh.renderOrder = 1;
      this.content.add(mesh);
    }
    for (const face of faces) {
      const room = rooms.find((r) => r.face?.key === face.key)?.room ?? null;
      const c = roomCeiling(plan, room);
      const contour = face.inner.map((p) => new Vector2(p.x * INCH_M, p.y * INCH_M));
      const holes = face.holes.map((h) => h.map((p) => new Vector2(p.x * INCH_M, p.y * INCH_M)));
      const all = [...contour, ...holes.flat()];
      const pos: number[] = [];
      const uv: number[] = [];
      const y = c.height * INCH_M - 0.003;
      for (const tri of ShapeUtils.triangulateShape(contour, holes)) {
        for (const t of tri) {
          pos.push(all[t].x, y, all[t].y);
          uv.push(all[t].x / 1.2192, all[t].y / 1.2192); // texture tile = 4 ft
        }
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
      const mesh = new Mesh(geo, this.ceilingMat(c.type));
      mesh.raycast = () => {};
      mesh.renderOrder = 1;
      this.content.add(mesh);
    }
  }

  private markerMat(color: string): MeshStandardMaterial {
    let m = this.markerMats.get(color);
    if (!m) {
      m = new MeshStandardMaterial({ color: new Color(color), emissive: new Color(color).multiplyScalar(0.35), roughness: 0.6 });
      this.markerMats.set(color, m);
    }
    return m;
  }

  private buildMarkers(plan: Plan): void {
    for (const mk of plan.markers) {
      const info = MARKER_INFO[mk.type];
      const z = mk.z > 0 ? mk.z : 3;
      const mesh = new Mesh(this.markerGeo, this.markerMat(info.color));
      mesh.userData.shared = true;
      mesh.userData.markerId = mk.id;
      planToLocal(mk, z, mesh.position);
      this.content.add(mesh);
      this.markerMeshes.push(mesh);
      const l = new TextLabel(info.name, { height: 0.03, bg: 'rgba(20,24,32,0.85)' });
      planToLocal(mk, z + (mk.z >= 90 ? -5 : 4), l.sprite.position);
      this.content.add(l.sprite);
      this.extraLabels.push(l);
    }
  }

  private buildObstacles(plan: Plan): void {
    for (const o of plan.obstacles) {
      const pos: number[] = [];
      appendPrism(pos, o.poly, 0, o.height);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = new Mesh(geo, this.matObstacle);
      mesh.renderOrder = 1;
      mesh.raycast = () => {};
      this.content.add(mesh);
      const edges = new LineSegments(new EdgesGeometry(geo, 25), this.edgeMatObstacle);
      edges.raycast = () => {};
      this.content.add(edges);
      const c = o.poly.reduce((acc, p) => ({ x: acc.x + p.x / o.poly.length, y: acc.y + p.y / o.poly.length }), { x: 0, y: 0 });
      const l = new TextLabel(prettyLabel(o.label), { height: 0.035, bg: 'rgba(90,70,40,0.85)' });
      planToLocal(c, o.height + 3, l.sprite.position);
      this.content.add(l.sprite);
      this.extraLabels.push(l);
    }
  }

  private buildMeasures(plan: Plan): void {
    const A = new Vector3();
    const B = new Vector3();
    const Z = new Vector3(0, 0, 1);
    for (const m of plan.measures) {
      planToLocal(m.a, m.a.z + 0.2, A);
      planToLocal(m.b, m.b.z + 0.2, B);
      const l = A.distanceTo(B);
      if (l < 1e-3) continue;
      const tape = new Mesh(this.tapeGeo, this.tapeMat);
      tape.position.copy(A);
      tape.quaternion.setFromUnitVectors(Z, B.clone().sub(A).normalize());
      tape.scale.set(1, 1, l);
      tape.raycast = () => {};
      tape.userData.shared = true;
      this.content.add(tape);
      const label = new TextLabel(measureLabel(m.a, m.b), { height: 0.045, bg: 'rgba(120,95,0,0.9)' });
      label.sprite.position.copy(A).add(B).multiplyScalar(0.5);
      label.sprite.position.y += 0.05;
      this.content.add(label.sprite);
      this.extraLabels.push(label);
    }
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

  /** Hover highlight: 'danger' (red, delete tool) or 'hover' (light blue, edit tool). */
  setHighlight(wallId: string | null, kind: 'hover' | 'danger' = 'danger'): void {
    if (wallId === this.highlighted && kind === this.highlightKind) return;
    this.highlighted = wallId;
    this.highlightKind = kind;
    this.applyMaterials();
  }

  /** Persistent selection highlight (blue). */
  setSelected(wallId: string | null): void {
    if (wallId === this.selected) return;
    this.selected = wallId;
    this.applyMaterials();
  }

  private applyMaterials(): void {
    for (const m of this.wallMeshes) {
      const id = m.userData.wallId as string;
      const base = m.userData.kind === 'existing' ? this.matExisting : this.matNew;
      m.material =
        id === this.highlighted
          ? this.highlightKind === 'danger'
            ? this.matHighlight
            : this.matHover
          : id === this.selected
            ? this.matSelected
            : base;
    }
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

/** 4 ft repeating ceiling pattern: plain drywall, a 2x4 drop-ceiling grid, or joists at 16" o.c. */
function ceilingTexture(type: CeilingType): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  if (type === 'open') {
    g.fillStyle = '#3c3f45';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#b08a58';
    for (let i = 0; i < 3; i++) g.fillRect(((i * 16) / 48) * 256, 0, 10, 256); // joists every 16"
  } else {
    g.fillStyle = type === 'drop' ? '#f1f0ea' : '#e9edf2';
    g.fillRect(0, 0, 256, 256);
    if (type === 'drywall') {
      // 4' x 8' sheet seams, faint, so the plane reads against a white real ceiling.
      g.strokeStyle = '#b9c3cf';
      g.lineWidth = 3;
      g.strokeRect(0, 0, 256, 256);
    }
    if (type === 'drop') {
      g.strokeStyle = '#9aa0a8';
      g.lineWidth = 5;
      g.strokeRect(0, 0, 256, 256);
      g.beginPath();
      g.moveTo(128, 0);
      g.lineTo(128, 256);
      g.stroke(); // 2' x 4' tiles
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** 4 ft repeating floor pattern for each finish. */
function floorTexture(finish: Finish): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const px = 256 / 48; // pixels per inch
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (finish === 'lvp') {
    // 7" x 48" planks, staggered, with wood tone variation.
    const tones = ['#c79a63', '#b98a55', '#d2a873', '#a97b4b', '#c09060'];
    const w = 7 * px;
    for (let r = 0; r * w < 256; r++) {
      const off = ((r * 17) % 48) * px;
      for (let k = -1; k < 2; k++) {
        g.fillStyle = tones[Math.floor(rnd() * tones.length)];
        g.fillRect(off + k * 256, r * w, 256, w);
        g.fillStyle = 'rgba(60,40,20,0.55)';
        g.fillRect(off + k * 256, r * w, 2, w);
      }
      g.fillStyle = 'rgba(60,40,20,0.55)';
      g.fillRect(0, r * w, 256, 2);
    }
  } else if (finish === 'tile') {
    g.fillStyle = '#d7dde2';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#8b959e';
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(i * 12 * px, 0);
      g.lineTo(i * 12 * px, 256);
      g.moveTo(0, i * 12 * px);
      g.lineTo(256, i * 12 * px);
      g.stroke();
    }
  } else if (finish === 'carpet') {
    g.fillStyle = '#9c8f80';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
      g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
    }
  } else if (finish === 'epoxy') {
    g.fillStyle = '#7f95ad';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = ['#e6e9ee', '#2c3440', '#b9c4d2'][i % 3];
      g.fillRect(rnd() * 256, rnd() * 256, 3, 2);
    }
  } else {
    // Sealed concrete: mottled grey with a saw cut every 4 ft.
    g.fillStyle = '#a9adb2';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},255,0.04)`;
      g.beginPath();
      g.arc(rnd() * 256, rnd() * 256, 10 + rnd() * 30, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#6f757c';
    g.fillRect(0, 0, 256, 3);
    g.fillRect(0, 0, 3, 256);
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function prettyLabel(label: string): string {
  const l = label.trim() || 'object';
  return l.charAt(0).toUpperCase() + l.slice(1);
}

function measureLabel(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): string {
  return formatLength(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), 8);
}

/** Door widths read better in inches (32"), long openings in feet. */
export function widthText(inches: number): string {
  return inches < 60 ? `${+inches.toFixed(2)}"` : formatLength(inches);
}
