import { Matrix4, Vector3, type Object3D, type World } from '@iwsdk/core';
import { lensCamera } from '../core/camCalib.js';
import { poseAt } from '../core/poseTrack.js';
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
 * Scanning: the depth sensor builds the room mesh while you look around, and
 * camera photos paint it. The mesh is evidence (snapping walls onto it, seeing
 * through walls), never a source of new walls. Every frame and photo is also
 * kept so a scan can be saved and reviewed off the headset.
 */
export class ScanSession {
  scanning = false;
  /** Whether the last depth frame came through (null before the first). */
  depthOk: boolean | null = null;
  readonly sampler: DepthSampler;
  readonly mesh: RoomMesh;
  readonly photos: ScanPhotos;
  readonly recorder = new ScanRecorder();
  private loaded: Promise<void>;
  private lastSample = 0;
  private lastPhoto = 0;
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
    // A camera photo about once a second paints the mesh.
    if (time - this.lastPhoto < 1 || !this.photos.ready) return;
    this.lastPhoto = time;
    const pose = { t: f.t, viewToRoot: f.viewToRoot, proj: f.proj };
    const toScan = (ms: number) => ms / 1000 + this.clockOffset - this.scanT0;
    // The head poses up to now, copied before the photo is encoded (which takes a while):
    // the camera captured this frame a few tens of milliseconds ago.
    const track = this.poseRing
      .filter((e) => e.ms > 0 && toScan(e.ms) > pose.t - 0.6)
      .map((e) => ({ t: toScan(e.ms), m: Float32Array.from(e.m) }))
      .sort((x, y) => x.t - y.t);
    void this.photos.snap().then((r) => {
      if (!r) return;
      const captured = Number.isFinite(r.capturedMs) ? toScan(r.capturedMs) : NaN;
      this.recorder.addPhoto({ ...pose, jpeg: r.jpeg, captured, track });
      const lens = this.photos.lens;
      if (!lens) return;
      // From where the camera was when it captured the frame: between the two head poses
      // around that moment, not the nearest one.
      const tc = (Number.isFinite(captured) ? captured : pose.t) - PHOTO_LAG;
      const at = poseAt(track, tc);
      if (at && at.turnDegPerS > MAX_TURN) return;
      const view = at ? at.m : pose.viewToRoot;
      this.mesh.colorize({ rgba: r.rgba, w: 640, h: 480, ...lensCamera(lens, view, 640, 480) });
    });
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
