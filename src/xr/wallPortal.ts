import { DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Plane, PlaneGeometry, Vector3, Vector4, type Object3D } from '@iwsdk/core';
import type { Plan } from '../core/plan.js';
import { INCH_M } from '../core/units.js';
import type { RoomMesh } from './roomMesh.js';
import { surfaceOccludable } from './surfaceOcclusion.js';

/**
 * See through a real wall: the wall becomes a window onto the room behind it,
 * drawn from the scanned room mesh at 1:1. A dark backdrop covers the real
 * wall; the far room's mesh is clipped to the window as seen from your eye and
 * to what lies beyond the wall's far face. Your hands and anything standing in
 * front of the wall still show over it.
 */
interface Portal {
  wallId: string;
  group: Group;
  backdrop: Mesh;
  mat: MeshStandardMaterial;
  planes: Plane[];
  /** Occlusion compares against the wall's near face (world plane). */
  occl: { value: Vector4 };
  mirrors: Map<string, Mesh>;
}

const MAX = 4;

export class WallPortals {
  readonly group = new Group();
  private portals = new Map<string, Portal>();
  private v = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private eye = new Vector3();
  private n = new Vector3();

  constructor(
    private planRoot: Object3D,
    private mesh: RoomMesh,
  ) {
    this.group.name = 'wall-portals';
    planRoot.add(this.group);
  }

  get ids(): string[] {
    return [...this.portals.keys()];
  }

  has(id: string): boolean {
    return this.portals.has(id);
  }

  /** Open or close a wall. Returns whether it is open now (false if at the limit). */
  toggle(id: string): boolean {
    const p = this.portals.get(id);
    if (p) {
      this.close(p);
      return false;
    }
    if (this.portals.size >= MAX) return false;
    const planes = [new Plane(), new Plane(), new Plane(), new Plane(), new Plane()];
    const occl = { value: new Vector4() };
    const mat = surfaceOccludable(
      new MeshStandardMaterial({ color: 0xe3ddd2, roughness: 0.92, metalness: 0, side: DoubleSide }),
      0.12,
      occl,
    );
    mat.opacity = 1;
    mat.clippingPlanes = planes;
    const backMat = surfaceOccludable(new MeshBasicMaterial({ color: 0x12161b, side: DoubleSide, depthWrite: false }), 0.12);
    backMat.opacity = 0.97;
    const backdrop = new Mesh(new PlaneGeometry(1, 1), backMat);
    backdrop.renderOrder = 30;
    backdrop.raycast = () => {};
    const group = new Group();
    group.add(backdrop);
    this.group.add(group);
    this.portals.set(id, { wallId: id, group, backdrop, mat, planes, occl, mirrors: new Map() });
    return true;
  }

  private close(p: Portal): void {
    this.group.remove(p.group);
    p.backdrop.geometry.dispose();
    (p.backdrop.material as MeshBasicMaterial).dispose();
    p.mat.dispose();
    this.portals.delete(p.wallId);
  }

  clear(): void {
    for (const p of [...this.portals.values()]) this.close(p);
  }

  /** Per frame: follow the plan, the eye and the latest mesh. */
  update(plan: Plan, eyeWorld: Vector3): void {
    if (!this.portals.size) return;
    this.planRoot.updateWorldMatrix(true, false);
    const eye = this.planRoot.worldToLocal(this.eye.copy(eyeWorld));
    for (const p of [...this.portals.values()]) {
      const w = plan.walls.find((x) => x.id === p.wallId);
      const a = w && plan.nodes.find((n) => n.id === w.a);
      const b = w && plan.nodes.find((n) => n.id === w.b);
      if (!w || !a || !b) {
        this.close(p);
        continue;
      }
      // Wall frame in plan-root meters (x, y up, z).
      const ax = a.x * INCH_M;
      const az = a.y * INCH_M;
      const bx = b.x * INCH_M;
      const bz = b.y * INCH_M;
      const L = Math.hypot(bx - ax, bz - az) || 1e-6;
      const dx = (bx - ax) / L;
      const dz = (bz - az) / L;
      let nx = -dz;
      let nz = dx;
      // Normal points from the wall toward the eye.
      if ((eye.x - ax) * nx + (eye.z - az) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const half = (w.thickness / 2) * INCH_M;
      const H = w.height * INCH_M;
      // Backdrop on the near face, just proud of it.
      const off = half + 0.004;
      p.backdrop.position.set((ax + bx) / 2 + nx * off, H / 2, (az + bz) / 2 + nz * off);
      p.backdrop.rotation.set(0, Math.atan2(nx, nz), 0);
      p.backdrop.scale.set(L, H, 1);

      // Window corners on the near face (local), then world.
      const corners = [
        [ax + nx * half, 0, az + nz * half],
        [bx + nx * half, 0, bz + nz * half],
        [bx + nx * half, H, bz + nz * half],
        [ax + nx * half, H, az + nz * half],
      ].map((c, i) => this.planRoot.localToWorld(this.v[i].set(c[0], c[1], c[2])));
      const E = eyeWorld;
      const center = this.tmp2.set(0, 0, 0);
      for (const c of corners) center.add(c);
      center.multiplyScalar(0.25);
      // Four planes through the eye and each window edge, keeping the inside.
      for (let i = 0; i < 4; i++) {
        const P = corners[i];
        const Q = corners[(i + 1) % 4];
        const pl = p.planes[i];
        pl.setFromCoplanarPoints(E, P, Q);
        if (pl.distanceToPoint(center) < 0) pl.negate();
      }
      // Keep only what is beyond the wall's far face (plus a little).
      const far = -(half + 0.04);
      this.n.set(-nx, 0, -nz).transformDirection(this.planRoot.matrixWorld);
      const farPt = this.planRoot.localToWorld(this.tmp.set((ax + bx) / 2 + nx * far, 0, (az + bz) / 2 + nz * far));
      p.planes[4].setFromNormalAndCoplanarPoint(this.n, farPt);
      // Occlusion: only real things in front of the near face hide the view.
      const nearPt = this.planRoot.localToWorld(this.tmp.set((ax + bx) / 2 + nx * half, 0, (az + bz) / 2 + nz * half));
      const nw = this.n.set(nx, 0, nz).transformDirection(this.planRoot.matrixWorld);
      p.occl.value.set(nw.x, nw.y, nw.z, -nw.dot(nearPt));

      // Mirror the room mesh's chunks with this window's material.
      const seen = new Set<string>();
      for (const [key, src] of this.mesh.chunks()) {
        seen.add(key);
        let m = p.mirrors.get(key);
        if (!m) {
          m = new Mesh(src.geometry, p.mat);
          m.raycast = () => {};
          m.renderOrder = 31;
          p.group.add(m);
          p.mirrors.set(key, m);
        } else if (m.geometry !== src.geometry) m.geometry = src.geometry;
      }
      for (const [key, m] of p.mirrors) {
        if (seen.has(key)) continue;
        p.group.remove(m);
        p.mirrors.delete(key);
      }
    }
  }
}
