import { Vector3, type Object3D, type World } from '@iwsdk/core';

const KEY = 'basement-planner:ref-anchors:v1';

interface Saved {
  uuids: [string, string];
}

type AnchorLike = {
  anchorSpace: XRSpace;
  requestPersistentHandle?: () => Promise<string>;
  delete?: () => void;
};
type SessionLike = XRSession & {
  restorePersistentAnchor?: (uuid: string) => Promise<AnchorLike>;
  deletePersistentAnchor?: (uuid: string) => Promise<void>;
};

/**
 * Two persistent WebXR anchors placed on the plan's reference corners.
 *
 * The headset keeps anchors locked to the real room across sessions. When both
 * come back, their current positions are the two reference corners measured
 * again, so the plan re-aligns itself (the same math as clicking Align), with a
 * baseline as long as the corners are far apart, which beats a single anchor.
 */
export class RefAnchors {
  private anchors: AnchorLike[] = [];
  private pending: Array<{ x: number; y: number; z: number }> | null = null;
  private restoring = false;
  private restoredFor: XRSession | null = null;
  private tmp = new Vector3();
  /** Latest anchor positions in world space, or null until both are tracked. */
  readonly positions: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  status: 'none' | 'restoring' | 'tracking' | 'lost' | 'unsupported' = 'none';

  constructor(private world: World) {}

  get saved(): boolean {
    return !!this.load();
  }

  private load(): Saved | null {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? (JSON.parse(raw) as Saved) : null;
      return s?.uuids?.length === 2 ? s : null;
    } catch {
      return null;
    }
  }

  /** Place new anchors at two world points (the reference corners), replacing old ones. */
  place(p1: Vector3, p2: Vector3): void {
    this.pending = [p1, p2].map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  forget(): void {
    const session = this.world.session as SessionLike | undefined;
    const s = this.load();
    if (s && session?.deletePersistentAnchor) for (const u of s.uuids) session.deletePersistentAnchor(u).catch(() => {});
    for (const a of this.anchors) a.delete?.();
    this.anchors = [];
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    this.status = 'none';
  }

  /** Per frame: create pending anchors, restore saved ones, read poses. Returns true when both are tracked. */
  update(): boolean {
    const session = this.world.session as SessionLike | undefined;
    const frame = this.world.xrFrame as (XRFrame & { createAnchor?: (t: XRRigidTransform, s: XRSpace) => Promise<AnchorLike> }) | null;
    const ref = this.world.xrReferenceSpace;
    if (!session || !frame || !ref) return false;

    if (this.pending) {
      const pts = this.pending;
      this.pending = null;
      if (!frame.createAnchor) {
        this.status = 'unsupported';
        return false;
      }
      const old = this.load();
      Promise.all(pts.map((p) => frame.createAnchor!(new XRRigidTransform(p), ref)))
        .then(async (anchors) => {
          for (const a of this.anchors) a.delete?.();
          this.anchors = anchors;
          this.status = 'tracking';
          if (anchors.every((a) => a.requestPersistentHandle)) {
            const uuids = (await Promise.all(anchors.map((a) => a.requestPersistentHandle!()))) as [string, string];
            localStorage.setItem(KEY, JSON.stringify({ uuids } satisfies Saved));
            if (old && session.deletePersistentAnchor) for (const u of old.uuids) session.deletePersistentAnchor(u).catch(() => {});
          }
        })
        .catch((e) => {
          console.warn('[planner] could not create reference anchors', e);
          this.status = 'unsupported';
        });
    }

    if (this.restoredFor !== session && !this.restoring && !this.anchors.length) {
      const saved = this.load();
      this.restoredFor = session;
      if (saved && session.restorePersistentAnchor) {
        this.restoring = true;
        this.status = 'restoring';
        Promise.all(saved.uuids.map((u) => session.restorePersistentAnchor!(u)))
          .then((anchors) => {
            this.anchors = anchors;
            this.status = 'tracking';
          })
          .catch((e) => {
            console.warn('[planner] saved reference anchors not found', e);
            this.status = 'lost';
          })
          .finally(() => (this.restoring = false));
      }
    }

    if (this.anchors.length !== 2) return false;
    for (let i = 0; i < 2; i++) {
      const pose = frame.getPose(this.anchors[i].anchorSpace, ref);
      if (!pose) return false;
      const p = pose.transform.position;
      this.positions[i].set(p.x, p.y, p.z);
    }
    return true;
  }

  /** Anchor positions expressed in `space`'s local frame (e.g. the plan root's parent). */
  localPositions(space: Object3D): [{ x: number; z: number }, { x: number; z: number }] {
    space.updateWorldMatrix(true, false);
    return this.positions.map((p) => {
      const l = space.worldToLocal(this.tmp.copy(p));
      return { x: l.x, z: l.z };
    }) as [{ x: number; z: number }, { x: number; z: number }];
  }
}
