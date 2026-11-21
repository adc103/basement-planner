import {
  BoxGeometry,
  CylinderGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  ShapeUtils,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { dist, norm, perp, sub, type Vec2 } from '../core/geom2d.js';
import type { GuideLine, SnapKind } from '../core/snapping.js';
import { INCH_M } from '../core/units.js';
import { TextLabel } from './labels.js';
import { appendPrism, planToLocal } from './planView.js';

export const SNAP_COLORS: Record<SnapKind, number> = {
  endpoint: 0x31d158,
  midpoint: 0x2fd5d5,
  intersection: 0xffd60a,
  edge: 0xff3b8f,
  angle: 0x5aa9ff,
  perpendicular: 0x5aa9ff,
  extension: 0xbf8cff,
  follow: 0xff9f0a,
  grid: 0xffffff,
  free: 0xb0b0b0,
};

export const SNAP_NAMES: Record<SnapKind, string> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  intersection: 'Intersection',
  edge: 'On wall',
  angle: 'Angle',
  perpendicular: 'Perpendicular',
  extension: 'Aligned',
  follow: 'Off foundation',
  grid: '',
  free: 'Free',
};

const MAX_DASHES = 600;
const DASH_M = 0.05;
const GAP_M = 0.035;

/** Transient drawing aids, all in the plan root's local frame. */
export class Preview {
  readonly root = new Group();
  private cursor: Mesh;
  private cursorMat: MeshBasicMaterial;
  private dot: Mesh;
  private dashes: InstancedMesh;
  private dashCount = 0;
  private rubber: Mesh;
  private rubberMat = new MeshBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.3, depthWrite: false, side: DoubleSide });
  private openingBox: Mesh;
  private openingMat = new MeshBasicMaterial({ color: 0x31d158, transparent: true, opacity: 0.35, depthWrite: false });
  readonly lengthLabel = new TextLabel('', { height: 0.07, bg: 'rgba(10,60,140,0.9)' });
  readonly snapLabel = new TextLabel('', { height: 0.035, bg: 'rgba(0,0,0,0.7)' });
  readonly hintLabel = new TextLabel('', { height: 0.04, bg: 'rgba(0,0,0,0.75)' });
  private markers: Mesh[] = [];
  private m = new Matrix4();
  private color = new Color();
  private up = new Vector3(0, 1, 0);
  private tapeMat = new MeshBasicMaterial({ color: 0xffd60a, depthTest: false, transparent: true });
  private tape: Mesh;
  private surfaceDisc: Mesh;
  private floorFill: Mesh;
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private q = new Quaternion();
  private s = new Vector3();
  private p = new Vector3();

  constructor() {
    this.root.name = 'preview';
    this.cursorMat = new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: DoubleSide });
    this.cursor = new Mesh(new RingGeometry(0.018, 0.028, 32).rotateX(-Math.PI / 2), this.cursorMat);
    this.cursor.renderOrder = 30;
    this.dot = new Mesh(new RingGeometry(0, 0.005, 16).rotateX(-Math.PI / 2), this.cursorMat);
    this.dot.renderOrder = 30;
    this.dashes = new InstancedMesh(
      new BoxGeometry(1, 0.002, 1),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
      MAX_DASHES,
    );
    this.dashes.count = 0;
    this.dashes.renderOrder = 29;
    this.dashes.frustumCulled = false;
    this.rubber = new Mesh(new BufferGeometry(), this.rubberMat);
    this.rubber.renderOrder = 25;
    this.openingBox = new Mesh(new BoxGeometry(1, 1, 1), this.openingMat);
    this.openingBox.renderOrder = 26;
    // Tape line: a unit cylinder stretched between two points.
    this.tape = new Mesh(new CylinderGeometry(0.004, 0.004, 1, 8, 1).translate(0, 0.5, 0).rotateX(Math.PI / 2), this.tapeMat);
    this.tape.renderOrder = 31;
    this.surfaceDisc = new Mesh(
      new RingGeometry(0.025, 0.04, 32),
      new MeshBasicMaterial({ color: 0x31d158, depthTest: false, transparent: true, side: DoubleSide }),
    );
    this.surfaceDisc.renderOrder = 31;
    this.floorFill = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide }),
    );
    this.floorFill.renderOrder = 3;
    for (const o of [this.cursor, this.dot, this.dashes, this.rubber, this.openingBox, this.tape, this.surfaceDisc, this.floorFill]) {
      o.raycast = () => {};
      this.root.add(o);
    }
    for (const l of [this.lengthLabel, this.snapLabel, this.hintLabel]) this.root.add(l.sprite);
    this.clear();
  }

  clear(): void {
    this.cursor.visible = false;
    this.dot.visible = false;
    this.dashes.count = 0;
    this.rubber.visible = false;
    this.openingBox.visible = false;
    this.lengthLabel.sprite.visible = false;
    this.snapLabel.sprite.visible = false;
    this.hintLabel.sprite.visible = false;
    this.tape.visible = false;
    this.surfaceDisc.visible = false;
    this.floorFill.visible = false;
    this.dashCount = 0;
  }

  /**
   * Highlight a floor polygon. Pass `keep` to re-show the last polygon without
   * rebuilding it (the caller tracks whether it changed).
   */
  showFloorPoly(poly: Vec2[] | null, keep = false): void {
    if (keep) {
      this.floorFill.visible = true;
      return;
    }
    if (!poly || poly.length < 3) {
      this.floorFill.visible = false;
      return;
    }
    const pos: number[] = [];
    const contour = poly.map((p) => new Vector2(p.x * INCH_M, p.y * INCH_M));
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      for (const t of [i, j, k]) pos.push(contour[t].x, 0.006, contour[t].y);
    }
    this.floorFill.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.floorFill.geometry = g;
    this.floorFill.visible = true;
  }

  /** Cursor at a 3D plan point (z = height in inches). */
  showCursorAt(p: { x: number; y: number; z: number }, kind: SnapKind, fine: boolean): void {
    this.showCursor(p, kind, fine);
    if (p.z > 0.5) {
      planToLocal(p, p.z, this.cursor.position);
      this.dot.position.copy(this.cursor.position);
      planToLocal(p, p.z + 4, this.snapLabel.sprite.position);
    }
  }

  /** Yellow tape line between two 3D plan points with a length label. */
  showMeasureLine(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, text: string): void {
    const A = planToLocal(a, a.z + 0.2, this.tmpA);
    const B = planToLocal(b, b.z + 0.2, this.tmpB);
    const l = A.distanceTo(B);
    if (l < 1e-3) return;
    this.tape.position.copy(A);
    this.lengthLabel.sprite.position.copy(A).add(B).multiplyScalar(0.5);
    const dir = B.sub(A).normalize();
    this.tape.quaternion.setFromUnitVectors(this.up.set(0, 0, 1), dir);
    this.up.set(0, 1, 0);
    this.tape.scale.set(1, 1, l);
    this.tape.visible = true;
    this.lengthLabel.setText(text);
    this.lengthLabel.sprite.position.y += 0.06;
    this.lengthLabel.sprite.visible = true;
  }

  /** Ring on a real surface, facing along its normal (plan-space horizontal normal). */
  showSurfaceCursor(p: { x: number; y: number; z: number }, n: Vec2): void {
    planToLocal(p, p.z, this.surfaceDisc.position);
    this.tmpA.set(n.x, 0, n.y).normalize();
    this.surfaceDisc.quaternion.setFromUnitVectors(this.tmpB.set(0, 0, 1), this.tmpA);
    this.surfaceDisc.visible = true;
  }

  showCursor(p: Vec2, kind: SnapKind, fine: boolean): void {
    planToLocal(p, 0.15, this.cursor.position);
    this.dot.position.copy(this.cursor.position);
    this.cursorMat.color.set(SNAP_COLORS[kind]);
    this.cursor.scale.setScalar(fine ? 0.5 : 1);
    this.cursor.visible = true;
    this.dot.visible = true;
    const name = SNAP_NAMES[kind] + (fine ? ' (fine)' : '');
    if (name) {
      this.snapLabel.setText(name);
      planToLocal(p, 4, this.snapLabel.sprite.position);
      this.snapLabel.sprite.visible = true;
    }
  }

  beginGuides(): void {
    this.dashCount = 0;
  }

  /** Dashed floor line between two plan points. */
  addDashedLine(a: Vec2, b: Vec2, color = 0xffffff): void {
    const l = dist(a, b) * INCH_M;
    if (l < 1e-3) return;
    const d = norm(sub(b, a));
    const ang = Math.atan2(d.y, d.x);
    this.q.setFromAxisAngle(this.up, -ang);
    const step = DASH_M + GAP_M;
    const n = Math.min(Math.floor(l / step) + 1, MAX_DASHES - this.dashCount);
    for (let i = 0; i < n; i++) {
      const t0 = i * step;
      const len = Math.min(DASH_M, l - t0);
      const center = (t0 + len / 2) / INCH_M;
      planToLocal({ x: a.x + d.x * center, y: a.y + d.y * center }, 0.1, this.p);
      this.s.set(len, 1, 0.006);
      this.m.compose(this.p, this.q, this.s);
      this.dashes.setMatrixAt(this.dashCount, this.m);
      this.dashes.setColorAt(this.dashCount, this.color.set(color));
      this.dashCount++;
    }
  }

  showGuides(guides: GuideLine[], point: Vec2): void {
    for (const g of guides) {
      // Draw from the guide's origin to the point, plus a short overshoot.
      const d = norm(sub(point, g.origin));
      const over = { x: point.x + d.x * 18, y: point.y + d.y * 18 };
      const color = g.kind === 'follow' ? SNAP_COLORS.follow : g.kind === 'extension' ? SNAP_COLORS.extension : SNAP_COLORS.angle;
      this.addDashedLine(g.origin, dist(g.origin, point) < 1 ? point : over, color);
    }
  }

  endGuides(): void {
    this.dashes.count = this.dashCount;
    this.dashes.instanceMatrix.needsUpdate = true;
    if (this.dashes.instanceColor) this.dashes.instanceColor.needsUpdate = true;
  }

  /** Translucent preview of the wall being drawn. */
  showRubberWall(a: Vec2, b: Vec2, thickness: number, height: number, label: string): void {
    const l = dist(a, b);
    if (l < 0.5) {
      this.rubber.visible = false;
      this.lengthLabel.sprite.visible = false;
      return;
    }
    const d = norm(sub(b, a));
    const n = perp(d);
    const h = thickness / 2;
    // Ends extend half a thickness past the points, matching placed walls.
    const a2 = { x: a.x - d.x * h, y: a.y - d.y * h };
    const b2 = { x: b.x + d.x * h, y: b.y + d.y * h };
    const poly = [
      { x: a2.x - n.x * h, y: a2.y - n.y * h },
      { x: b2.x - n.x * h, y: b2.y - n.y * h },
      { x: b2.x + n.x * h, y: b2.y + n.y * h },
      { x: a2.x + n.x * h, y: a2.y + n.y * h },
    ];
    const pos: number[] = [];
    appendPrism(pos, poly, 0, height);
    this.rubber.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.rubber.geometry = g;
    this.rubber.visible = true;
    this.lengthLabel.setText(label);
    planToLocal({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.min(height + 4, 60), this.lengthLabel.sprite.position);
    this.lengthLabel.sprite.visible = true;
  }

  /** Box preview of an opening in a wall (plan center, along-wall direction). */
  showOpening(center: Vec2, dir: Vec2, width: number, height: number, sill: number, thickness: number, ok: boolean): void {
    const ang = Math.atan2(dir.y, dir.x);
    this.openingBox.rotation.set(0, -ang, 0);
    this.openingBox.scale.set(width * INCH_M, height * INCH_M, (thickness + 1) * INCH_M);
    planToLocal(center, sill + height / 2, this.openingBox.position);
    this.openingMat.color.set(ok ? 0x31d158 : 0xff453a);
    this.openingBox.visible = true;
  }

  showHint(text: string, at: Vec2, z = 30): void {
    this.hintLabel.setText(text);
    planToLocal(at, z, this.hintLabel.sprite.position);
    this.hintLabel.sprite.visible = true;
  }

  occludableMaterials() {
    return [this.rubberMat, this.openingMat];
  }

  /** Persistent little markers (alignment clicks). */
  setMarkers(points: Vec2[]): void {
    while (this.markers.length < points.length) {
      const mk = new Mesh(
        new RingGeometry(0.03, 0.045, 32).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: 0xff9f0a, depthTest: false, transparent: true, side: DoubleSide }),
      );
      mk.renderOrder = 31;
      mk.raycast = () => {};
      this.root.add(mk);
      this.markers.push(mk);
    }
    this.markers.forEach((mk, i) => {
      mk.visible = i < points.length;
      if (mk.visible) planToLocal(points[i], 0.2, mk.position);
    });
  }
}
