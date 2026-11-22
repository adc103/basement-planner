import { ConeGeometry, Group, Mesh, MeshBasicMaterial, Vector3, type Object3D, type World } from '@iwsdk/core';
import type { Plan } from '../core/plan.js';
import { INCH_M } from '../core/units.js';
import { PlanView } from './planView.js';

/**
 * The dollhouse: a small copy of the whole basement plan in front of you, for
 * the overview you can't get standing inside it. It follows every edit and
 * shows where you are. Turn it, size it, or bring it back from the menu.
 */
export class Dollhouse {
  readonly group = new Group();
  private view = new PlanView();
  private you: Mesh;
  private turn = 0;
  scale = 1 / 24;
  shown = false;
  private center = { x: 0, y: 0 };
  private tmp = new Vector3();

  constructor(
    private world: World,
    /** The life-size plan root: your position is read against it. */
    private planRoot: Object3D,
  ) {
    this.group.name = 'dollhouse';
    this.view.mode = 'solid';
    this.view.showLabels = false;
    this.view.root.name = 'dollhouse-plan';
    this.group.add(this.view.root);
    this.you = new Mesh(new ConeGeometry(0.006, 0.02, 12).rotateX(Math.PI), new MeshBasicMaterial({ color: 0xff3b30 }));
    this.group.add(this.you);
    this.group.visible = false;
    this.group.traverse((o) => (o.raycast = () => {}));
  }

  get mounted(): boolean {
    return !!this.group.parent;
  }

  mount(parent: Object3D): void {
    parent.add(this.group);
  }

  /** Show it in front of you at table height, or hide it. */
  toggle(plan: Plan): boolean {
    this.shown = !this.shown;
    this.group.visible = this.shown;
    if (this.shown) {
      this.rebuild(plan);
      this.bringHere();
    }
    return this.shown;
  }

  bringHere(): void {
    const head = this.world.player.head;
    const p = head.getWorldPosition(this.tmp);
    const dir = new Vector3(0, 0, -1).applyQuaternion(head.getWorldQuaternion(this.group.quaternion.clone()));
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    // Table height, an arm's length ahead, facing you.
    const parentInv = this.group.parent ? this.group.parent.matrixWorld.clone().invert() : null;
    const at = p.clone().addScaledVector(dir, 0.55);
    at.y = Math.max(0.6, p.y - 0.55);
    if (parentInv) at.applyMatrix4(parentInv);
    this.group.position.copy(at);
    this.turn = Math.atan2(-dir.x, -dir.z);
    this.applyPose();
  }

  rotate(deg: number): void {
    this.turn += (deg * Math.PI) / 180;
    this.applyPose();
  }

  resize(f: number): void {
    this.scale = Math.min(1 / 6, Math.max(1 / 96, this.scale * f));
    this.applyPose();
  }

  private applyPose(): void {
    this.group.rotation.set(0, this.turn, 0);
    const s = this.scale;
    this.view.root.scale.setScalar(s);
    this.view.root.position.set(-this.center.x * INCH_M * s, 0, -this.center.y * INCH_M * s);
  }

  rebuild(plan: Plan): void {
    if (!this.shown) return;
    this.view.rebuild(plan);
    // Center on the drawn plan (or the scanned floor).
    const xs = plan.nodes.map((n) => n.x);
    const ys = plan.nodes.map((n) => n.y);
    if (xs.length) this.center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    this.view.root.traverse((o) => (o.raycast = () => {}));
    this.applyPose();
  }

  /** Per frame: put the "you" marker where you stand in the real plan. */
  update(): void {
    if (!this.shown) return;
    const head = this.world.player.head.getWorldPosition(this.tmp);
    const local = this.planRoot.worldToLocal(head);
    const s = this.scale;
    this.you.position.set((local.x - this.center.x * INCH_M) * s, 0.012, (local.z - this.center.y * INCH_M) * s);
  }
}
