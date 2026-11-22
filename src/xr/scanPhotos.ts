import { CameraSource, CameraState, CameraUtils, type Entity, type World } from '@iwsdk/core';

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
  label = '';

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

  /** A 640x480 JPEG of the current camera frame, or null. */
  async snap(): Promise<Uint8Array | null> {
    if (this.state !== 'on' || !this.entity || this.busy) return null;
    const frame = CameraUtils.captureFrame(this.entity);
    if (!frame) return null;
    this.busy = true;
    try {
      const ctx = this.canvas.getContext('2d')!;
      ctx.drawImage(frame, 0, 0, 640, 480);
      const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/jpeg', 0.82));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } finally {
      this.busy = false;
    }
  }
}
