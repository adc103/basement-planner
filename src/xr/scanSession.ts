import { Matrix4, Vector3, type Object3D, type World } from '@iwsdk/core';
import { lensCamera } from '../core/camCalib.js';
import { poseAt } from '../core/poseTrack.js';
import { splatDataset, zipStore, type TrainingView } from '../core/splatDataset.js';
import type { DepthFrame } from '../core/scanIngest.js';
import { DepthSampler } from './depthSampler.js';
import { RoomMesh } from './roomMesh.js';
import { ScanPhotos } from './scanPhotos.js';
import { ScanRecorder } from './scanRecorder.js';

/** Seconds between the camera's capture time stamp and the head pose that matches it (fit on real captures). */
const PHOTO_LAG = 0.03;
const SAMPLE_EVERY = 0.25; // s between depth frames fused into the mesh
/** Photos taken while the head turns faster than this are blurred and land poorly: kept in the recording, not painted. */
const MAX_TURN = 45; // degrees per second
/**
 * Photos: as often as the view changes enough to add something (splats want many views
 * of every surface from different places), but not more than about twice a second.
 */
const PHOTO_MIN_GAP = 0.45; // s
const PHOTO_MOVE = 0.12; // m the head moved since the last photo
const PHOTO_TURN = 8; // degrees it turned
const PHOTO_MAX_GAP = 2; // s: one anyway, even standing still

/**
 * Scanning: the depth sensor builds the room mesh while you look around, and
 * camera photos paint it. The mesh is evidence (snapping walls onto it, seeing
 * through walls), never a source of new walls. Every frame and photo is also
 * kept so a scan can be saved and reviewed off the headset.
 */
export class ScanSession {
  scanning = false;
  /** This session's photos as splat-training views (sharp ones only), by colorize id. */
  readonly views = new Map<number, TrainingView>();
  /** Whether the last depth frame came through (null before the first). */
  depthOk: boolean | null = null;
  readonly sampler: DepthSampler;
  readonly mesh: RoomMesh;
  readonly photos: ScanPhotos;
  readonly recorder = new ScanRecorder();
  private loaded: Promise<void>;
  private lastSample = 0;
  private lastPhoto = 0;
  private lastPhotoView: Float32Array | null = null;
  private viewKey = 0;
  /** Photos kept this session, and when one was last skipped for turning too fast (s). */
  photosTaken = 0;
  lastBlurry = -Infinity;
  /** Called for each photo kept (a tick on the controller, as Hyperscape does). */
  onPhoto: (() => void) | null = null;
  private scanT0 = -1;
  private rootInv = new Matrix4();
  private viewM = new Matrix4();
  private tmp = new Vector3();

  constructor(
    private world: World,
    private root: Object3D,
  ) {
    this.sampler = new DepthSampler(world);
    this.mesh = new RoomMesh(root);
    this.mesh.onPhotoPlaced = (id, camToRoot) => {
      const v = this.views.get(id);
      if (v) v.camToRoot = camToRoot;
      else this.placed.set(id, camToRoot);
    };
    this.photos = new ScanPhotos(world);
    this.loaded = this.recorder.load();
  }

  async start(): Promise<void> {
    await this.loaded;
    this.scanning = true;
    this.mesh.setActive(true);
    void this.photos.start();
    this.depthOk = null;
  }

  stop(): void {
    this.scanning = false;
    this.photos.stop();
    this.mesh.setActive(false);
    this.mesh.save();
    void this.recorder.save();
  }

  /** Erase the mesh, its colors and the recording. */
  clear(): void {
    this.recorder.clear();
    this.mesh.clear();
    this.views.clear();
    this.placed.clear();
    this.photosTaken = 0;
    this.lastPhotoView = null;
  }

  /** This scan as a splat training set (zip), or null with no photos yet. */
  splatData(): Uint8Array | null {
    const views = [...this.views.values()];
    if (views.length < 8) return null;
    return zipStore(splatDataset(views, this.mesh.seedPoints()));
  }

  /** What on-device splat training starts from: the sharp photos and the colored surface. */
  splatInput(): { views: TrainingView[]; seed: { pos: Float32Array; rgb: Uint8Array; normals: Float32Array } } | null {
    const all = [...this.views.values()];
    if (all.length < 8) return null;
    // At most 400, spread over the whole scan (memory: each is decoded for training).
    const step = Math.max(1, all.length / 400);
    const views: TrainingView[] = [];
    for (let i = 0; i < all.length && views.length < 400; i += step) views.push(all[Math.floor(i)]);
    return { views, seed: this.mesh.seedPoints(150_000, true) };
  }

  /** One depth frame into the room mesh and the recording. */
  ingest(f: DepthFrame): void {
    this.mesh.push(f);
    this.recorder.add(f);
  }

  /** Head (left view) pose every frame while scanning, for photo timing. */
  private poseRing = Array.from({ length: 90 }, () => ({ ms: 0, m: new Float32Array(16) }));
  private poseAt = 0;
  /** Scan clock (seconds) minus performance.now() seconds. */
  private clockOffset = 0;
  private ringM = new Matrix4();

  private recordPose(time: number): void {
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    const view = frame && ref ? frame.getViewerPose(ref)?.views[0] : undefined;
    if (!view) return;
    const now = performance.now();
    this.clockOffset = time - now / 1000;
    this.root.updateWorldMatrix(true, false);
    this.rootInv.copy(this.root.matrixWorld).invert();
    this.ringM.fromArray(view.transform.matrix).premultiply(this.rootInv);
    const e = this.poseRing[this.poseAt];
    this.poseAt = (this.poseAt + 1) % this.poseRing.length;
    e.ms = now;
    e.m.set(this.ringM.elements);
  }

  /** Per frame while in XR. */
  tick(time: number): void {
    this.mesh.tick(time);
    if (!this.scanning) return;
    if (this.photos.state === 'on') this.recordPose(time);
    if (time - this.lastSample < SAMPLE_EVERY) return;
    this.lastSample = time;
    const f = this.captureFrame(time);
    this.depthOk = !!f;
    if (!f) return;
    this.ingest(f);
    if (!this.photos.ready || time - this.lastPhoto < PHOTO_MIN_GAP) return;
    if (time - this.lastPhoto < PHOTO_MAX_GAP && !this.viewChanged(f.viewToRoot)) return;
    const pose = { t: f.t, viewToRoot: f.viewToRoot, proj: f.proj };
    const toScan = (ms: number) => ms / 1000 + this.clockOffset - this.scanT0;
    // The head poses up to now: the camera captured this frame a few tens of milliseconds ago.
    const track = this.poseRing
      .filter((e) => e.ms > 0 && toScan(e.ms) > pose.t - 0.6)
      .map((e) => ({ t: toScan(e.ms), m: Float32Array.from(e.m) }))
      .sort((x, y) => x.t - y.t);
    const lens = this.photos.lens;
    const r = this.photos.snap();
    if (!r) return;
    const captured = Number.isFinite(r.capturedMs) ? toScan(r.capturedMs) : NaN;
    // From where the camera was when it captured the frame: between the two head poses
    // around that moment, not the nearest one.
    const tc = (Number.isFinite(captured) ? captured : pose.t) - PHOTO_LAG;
    const at = poseAt(track, tc);
    const sharp = !at || at.turnDegPerS <= MAX_TURN;
    if (!sharp) this.lastBlurry = time;
    else {
      this.lastPhoto = time;
      this.lastPhotoView = Float32Array.from(f.viewToRoot);
    }
    let key = 0;
    let cam: ReturnType<typeof lensCamera> | null = null;
    if (lens && sharp) {
      cam = lensCamera(lens, at ? at.m : pose.viewToRoot, 640, 480);
      // Painted and lined up in the fusion worker when it keeps up; otherwise it still
      // counts toward coverage and training (with the head pose's camera).
      key = this.mesh.photosInFlight < 2 ? this.mesh.colorize({ rgba: r.rgba, w: 640, h: 480, ...cam }) : 0;
      if (!key) {
        this.mesh.markSeen({ w: 640, h: 480, ...cam });
        key = -++this.viewKey;
      }
      this.photosTaken++;
      this.onPhoto?.();
    }
    void r.jpeg.then((jpeg) => {
      if (!jpeg) return;
      this.recorder.addPhoto({ ...pose, jpeg, captured, track });
      if (!cam) return;
      // Kept for splat training, with the camera as the worker lines it up.
      const placed = this.placed.get(key);
      this.placed.delete(key);
      this.views.set(key, { jpeg, w: 640, h: 480, camToRoot: placed ?? Array.from(cam.camToRoot), fx: cam.fx, fy: cam.fy, cx: cam.cx, cy: cam.cy });
    });
  }

  /** Lined-up cameras that arrived before their photo's JPEG did. */
  private placed = new Map<number, number[]>();

  /** Has the head moved or turned enough since the last photo to see something new? */
  private viewChanged(m: Float32Array): boolean {
    const p = this.lastPhotoView;
    if (!p) return true;
    const moved = Math.hypot(m[12] - p[12], m[13] - p[13], m[14] - p[14]);
    const cos = (m[8] * p[8] + m[9] * p[9] + m[10] * p[10]) / (Math.hypot(m[8], m[9], m[10]) * Math.hypot(p[8], p[9], p[10]) || 1);
    return moved >= PHOTO_MOVE || Math.acos(Math.min(1, cos)) * (180 / Math.PI) >= PHOTO_TURN;
  }

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
}
