import { Vector3, type World } from '@iwsdk/core';
import type { SpatialPanel } from './ui/spatialPanel.js';

/**
 * Keeps the main menu on the left wrist (or pinned in the world).
 * Hands: shown when the left palm faces you. Controllers: always above the left controller.
 */
export type MenuMode = 'wrist' | 'float' | 'pinned';

export class WristMenu {
  mode: MenuMode = 'wrist';
  get pinned(): boolean {
    return this.mode === 'pinned';
  }
  /** Manual override for controllers (X button). */
  hiddenByUser = false;
  private palmFacing = false;
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  private head = new Vector3();
  private wrist = new Vector3();
  private tmpD = new Vector3();

  constructor(
    private world: World,
    private panels: SpatialPanel[],
    /** Height of the panel center above the wrist, meters. */
    private lift = 0.16,
  ) {}

  update(): void {
    const world = this.world;
    const cam = world.camera;
    cam.getWorldPosition(this.head);
    if (this.mode !== 'wrist') {
      // Pinned: stays put. Float: the Follower component moves it.
      this.panels[0].setVisible(!this.hiddenByUser);
      return;
    }
    const source = world.input.xr.getPrimaryInputSource('left');
    if (!source || !world.session || this.hiddenByUser) {
      this.panels[0].setVisible(false);
      return;
    }
    let show = true;
    const grip = world.player.gripSpaces.left;
    grip.getWorldPosition(this.wrist);
    if (source.hand) {
      show = this.palmTowardHead(source.hand);
    }
    this.panels[0].setVisible(show);
    if (!show) return;
    this.place(this.panels[0], this.wrist, source.hand ? this.lift : this.lift + 0.03);
  }

  /** Place a panel above a point, facing the head (upright). */
  place(panel: SpatialPanel, at: Vector3, up: number): void {
    const root = panel.root;
    const pos = this.tmpA.copy(at);
    pos.y += up;
    // Nudge toward the head a little so the hand doesn't cover the panel.
    const toHead = this.tmpB.copy(this.head).sub(pos);
    toHead.y = 0;
    if (toHead.lengthSq() > 1e-6) toHead.normalize();
    pos.addScaledVector(toHead, 0.03);
    root.parent?.worldToLocal(pos);
    root.position.copy(pos);
    // Face the head: yaw toward it plus a tilt.
    const worldPos = root.getWorldPosition(this.tmpC);
    const dx = this.head.x - worldPos.x;
    const dz = this.head.z - worldPos.z;
    const yaw = Math.atan2(dx, dz);
    const dy = this.head.y - worldPos.y;
    const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
    root.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  /** Hysteresis on whether the left palm faces the head. */
  private palmTowardHead(hand: XRHand): boolean {
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    if (!frame || !ref || !frame.getJointPose) return this.palmFacing;
    const wj = hand.get('wrist');
    const ij = hand.get('index-finger-metacarpal');
    const pj = hand.get('pinky-finger-metacarpal');
    if (!wj || !ij || !pj) return this.palmFacing;
    const w = frame.getJointPose(wj, ref);
    const i = frame.getJointPose(ij, ref);
    const p = frame.getJointPose(pj, ref);
    if (!w || !i || !p) return this.palmFacing;
    const W = this.tmpA.set(w.transform.position.x, w.transform.position.y, w.transform.position.z);
    const toI = this.tmpB.set(i.transform.position.x, i.transform.position.y, i.transform.position.z).sub(W);
    const toP = this.tmpC.set(p.transform.position.x, p.transform.position.y, p.transform.position.z).sub(W);
    // Left hand: palm normal = (pinky - wrist) x (index - wrist).
    const normal = toP.cross(toI).normalize();
    const toHead = this.tmpD.copy(this.head).sub(W).normalize();
    const d = normal.dot(toHead);
    if (this.palmFacing && d < 0.25) this.palmFacing = false;
    else if (!this.palmFacing && d > 0.5) this.palmFacing = true;
    return this.palmFacing;
  }

  /** Pin the menu where it is now (or go back to the wrist). */
  togglePin(): void {
    this.mode = this.mode === 'pinned' ? 'wrist' : 'pinned';
  }
}
