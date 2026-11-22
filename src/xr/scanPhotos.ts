import { CameraSource, CameraState, CameraUtils, type Entity, type World } from '@iwsdk/core';
import type { LensData } from '../core/camCalib.js';

/**
 * Passthrough camera photos during a scan, once a second, kept with the
 * depth view's pose. They're the raw material for working out where the
 * camera points (the browser doesn't say) and then coloring the room mesh.
 */
export class ScanPhotos {
  private entity: Entity | null = null;
  private canvas = document.createElement('canvas');
  private busy = false;
  state: 'off' | 'starting' | 'on' | 'unavailable' = 'off';
  /** When the newest video frame was captured (performance.now ms), from the browser's frame metadata. */
  private lastCaptureMs = NaN;
  label = '';
  /**
   * The camera track's settings. With the browser's experimental flags on, the Quest
   * adds lensCalibration [fx, fy, cx, cy, skew], lensRotation and lensTranslation:
   * the factory calibration needed to line photos up with the scan.
   */
  settings: Record<string, unknown> | null = null;

  /** The factory lens calibration, when the browser reports it. */
  get lens(): LensData | null {
    const s = this.settings as Partial<LensData> | null;
    return s?.lensCalibration && s.lensRotation && s.lensTranslation ? (s as LensData) : null;
  }

  constructor(private world: World) {
    this.canvas.width = 640;
    this.canvas.height = 480;
  }

  async start(): Promise<void> {
    if (this.entity || this.state === 'starting') return;
    this.state = 'starting';
    try {
      const devices = await CameraUtils.getDevices(false);
      // The room-facing passthrough cameras show up as "facing back".
      const pick = devices.find((d) => d.facing === 'back') ?? null;
      if (!pick) {
        this.state = 'unavailable';
        return;
      }
      this.label = pick.label;
      const e = this.world.createEntity();
      e.addComponent(CameraSource, { deviceId: pick.deviceId, width: 1280, height: 960, frameRate: 30 });
      this.entity = e;
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        const st = e.getValue(CameraSource, 'state');
        if (st === CameraState.Active) {
          this.state = 'on';
          const stream = e.getValue(CameraSource, 'stream') as MediaStream | null;
          const s = { ...(stream?.getVideoTracks()[0]?.getSettings() ?? {}) } as Record<string, unknown>;
          delete s.deviceId;
          delete s.groupId;
          this.settings = s;
          this.watchFrames();
          return;
        }
        if (st === CameraState.Error) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      this.stop();
      this.state = 'unavailable';
    } catch {
      this.stop();
      this.state = 'unavailable';
    }
  }

  stop(): void {
    this.entity?.dispose();
    this.entity = null;
    if (this.state !== 'unavailable') this.state = 'off';
  }

  /** Follow video frames to know when the current one was captured. */
  private watchFrames(): void {
    type Meta = { captureTime?: number; expectedDisplayTime?: number; presentationTime?: number };
    const v = this.entity?.getValue(CameraSource, 'videoElement') as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, m: Meta) => void) => number }) | null;
    if (!v?.requestVideoFrameCallback) return;
    const cb = (_now: number, m: Meta) => {
      if (!this.entity) return;
      this.lastCaptureMs = m.captureTime ?? m.presentationTime ?? NaN;
      v.requestVideoFrameCallback!(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  /** Ready to take a photo now? */
  get ready(): boolean {
    return this.state === 'on' && !!this.entity && !this.busy;
  }

  /** A 640x480 JPEG of the current camera frame and when it was captured (performance.now ms), or null. */
  async snap(): Promise<{ jpeg: Uint8Array; capturedMs: number; rgba: Uint8ClampedArray } | null> {
    if (!this.ready) return null;
    const frame = CameraUtils.captureFrame(this.entity!);
    if (!frame) return null;
    const capturedMs = this.lastCaptureMs;
    this.busy = true;
    try {
      const ctx = this.canvas.getContext('2d')!;
      ctx.drawImage(frame, 0, 0, 640, 480);
      const rgba = ctx.getImageData(0, 0, 640, 480).data;
      const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/jpeg', 0.82));
      return blob ? { jpeg: new Uint8Array(await blob.arrayBuffer()), capturedMs, rgba } : null;
    } finally {
      this.busy = false;
    }
  }
}
