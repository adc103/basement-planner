import {
  CameraSource,
  CameraState,
  CameraUtils,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  XRMesh,
  XRPlane,
  type Entity,
  type World,
} from '@iwsdk/core';

export const PROBE_KEY = 'basement-planner:camera-probe:v1';

export interface ProbeRow {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface ProbeResult {
  at: string;
  userAgent: string;
  rows: ProbeRow[];
  /** Small JPEG data URL of one captured frame. */
  thumb: string | null;
}

/**
 * One-shot feasibility test for "see through walls": can this headset's browser
 * give us the passthrough camera during an AR session, how fast, with what
 * metadata, and are depth / room mesh / WebGPU available?
 */
export class CameraProbe {
  running = false;
  private preview: Mesh | null = null;

  constructor(
    private world: World,
    private meshQuery: () => Iterable<Entity>,
    private planeQuery: () => Iterable<Entity>,
  ) {}

  async run(onProgress: (msg: string) => void): Promise<ProbeResult> {
    this.running = true;
    const rows: ProbeRow[] = [];
    const add = (name: string, ok: boolean | null, detail: string) => rows.push({ name, ok, detail });
    let thumb: string | null = null;
    let entity: Entity | null = null;
    try {
      const session = this.world.session;
      add('AR session running', !!session, session ? `mode ${(session as unknown as { mode?: string }).mode ?? 'immersive-ar'}` : 'not in AR');
      const feats = (session as unknown as { enabledFeatures?: string[] })?.enabledFeatures ?? [];
      add('Session features', feats.length > 0, feats.join(', ') || 'none reported');
      add('Depth sensing', feats.includes('depth-sensing'), feats.includes('depth-sensing') ? `usage ${(session as unknown as { depthUsage?: string }).depthUsage ?? '?'}, format ${(session as unknown as { depthDataFormat?: string }).depthDataFormat ?? '?'}` : 'not granted');

      // The standard WebXR camera feature: lens details and pose with every frame, if the browser has it.
      const camAccess = feats.includes('camera-access');
      let viewCam = 'no frame';
      if (session) {
        viewCam = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('no frame in 2 s'), 2000);
          session.requestAnimationFrame((_t, frame) => {
            clearTimeout(timer);
            const ref = this.world.renderer.xr.getReferenceSpace();
            const pose = ref ? frame.getViewerPose(ref) : null;
            const cams = (pose?.views ?? []).map((v) => (v as unknown as { camera?: { width: number; height: number } }).camera).filter(Boolean);
            resolve(cams.length ? `${cams.length} camera image(s) attached to views, ${cams[0]!.width}x${cams[0]!.height}` : `${pose?.views.length ?? 0} views, no camera attached`);
          });
        });
      }
      add('WebXR camera-access (lens + pose)', camAccess && viewCam.includes('attached to views'), `${camAccess ? 'granted' : 'not granted'}; ${viewCam}`);
      const gpuBinding = (globalThis as unknown as { XRGPUBinding?: { prototype: Record<string, unknown> } }).XRGPUBinding;
      add(
        'WebGPU in WebXR',
        gpuBinding ? true : false,
        gpuBinding ? `XRGPUBinding present; depth for WebGPU: ${'getDepthInformation' in gpuBinding.prototype ? 'getDepthInformation available' : 'no getDepthInformation'}` : 'XRGPUBinding not exposed',
      );

      // Room mesh / planes.
      let meshVerts = 0;
      let meshes = 0;
      for (const e of this.meshQuery()) {
        meshes++;
        const raw = e.getValue(XRMesh, '_mesh') as unknown as { vertices?: Float32Array } | undefined;
        meshVerts = Math.max(meshVerts, (raw?.vertices?.length ?? 0) / 3);
      }
      let planes = 0;
      for (const _ of this.planeQuery()) planes++;
      add('Room mesh', meshVerts > 100, `${meshes} meshes, largest ${meshVerts} vertices; ${planes} planes`);

      // WebGPU.
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      let adapter = false;
      try {
        adapter = !!(await gpu?.requestAdapter());
      } catch {
        adapter = false;
      }
      add('WebGPU', adapter, gpu ? (adapter ? 'adapter available' : 'navigator.gpu present, no adapter') : 'not exposed');

      // Cameras.
      onProgress('Asking for camera permission...');
      add('MediaDevices API', !!navigator.mediaDevices?.getUserMedia, navigator.mediaDevices ? 'present' : 'missing');
      const devices = await CameraUtils.getDevices(true).catch((e: unknown) => {
        add('Camera permission', false, String(e));
        return [];
      });
      add('Cameras listed', devices.length > 0, devices.map((d) => `${d.label || '(no label)'} [${d.facing}]`).join(' | ') || 'none');
      const pick =
        devices.find((d) => /passthrough|left|back|rear|world/i.test(d.label)) ?? devices.find((d) => d.facing === 'back') ?? devices[0];
      if (!pick) throw new Error('no camera');

      onProgress(`Opening ${pick.label || 'camera'}...`);
      entity = this.world.createEntity();
      entity.addComponent(CameraSource, { deviceId: pick.deviceId, width: 1280, height: 960, frameRate: 30 });
      const t0 = performance.now();
      while (performance.now() - t0 < 10000) {
        const st = entity.getValue(CameraSource, 'state');
        if (st === CameraState.Active || st === CameraState.Error) break;
        await sleep(100);
      }
      const state = entity.getValue(CameraSource, 'state');
      add('Camera stream during AR', state === CameraState.Active, `state ${state} after ${Math.round(performance.now() - t0)} ms (${pick.label})`);
      if (state !== CameraState.Active) throw new Error('camera not active');

      const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null;
      const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      const settings = (track?.getSettings?.() ?? {}) as Record<string, unknown>;
      add('Resolution', !!video?.videoWidth, `${video?.videoWidth}x${video?.videoHeight}`);
      add('Track settings', true, Object.entries(settings).map(([k, v]) => `${k}=${fmt(v)}`).join(', '));
      let caps: Record<string, unknown> = {};
      try {
        caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const extra = Object.keys(caps).filter((k) => !['width', 'height', 'frameRate', 'aspectRatio', 'deviceId', 'groupId', 'facingMode', 'resizeMode'].includes(k));
      add('Extra camera metadata', extra.length > 0 ? true : null, extra.length ? extra.map((k) => `${k}=${fmt(caps[k])}`).join(', ') : 'none beyond the basics');

      // Frame rate and capture timing.
      onProgress('Measuring frame rate...');
      const timing = await measureFrames(video!, 2000);
      add('Frame rate', timing.fps >= 10, `${timing.fps.toFixed(1)} fps${timing.latencyMs !== null ? `, capture-to-display ${timing.latencyMs.toFixed(0)} ms` : ''}`);

      // One frame: show it in the room and keep a thumbnail.
      const canvas = CameraUtils.captureFrame(entity);
      add('Frame capture', !!canvas, canvas ? `${canvas.width}x${canvas.height}` : 'captureFrame returned null');
      if (canvas) {
        const lum = averageLuma(canvas);
        add('Frame shows the room', lum > 8, `average brightness ${lum.toFixed(0)}/255${lum <= 8 ? ' (black: camera blocked?)' : ''}`);
        thumb = toThumb(canvas, 480);
        this.showPreview(canvas);
      }
    } catch (e) {
      add('Stopped', false, (e as Error).message);
    } finally {
      if (entity) entity.dispose();
      this.running = false;
    }
    const result: ProbeResult = { at: new Date().toISOString(), userAgent: navigator.userAgent, rows, thumb };
    try {
      localStorage.setItem(PROBE_KEY, JSON.stringify(result));
    } catch {
      /* thumbnail too large: drop it */
      try {
        localStorage.setItem(PROBE_KEY, JSON.stringify({ ...result, thumb: null }));
      } catch {
        /* ignore */
      }
    }
    return result;
  }

  /** Put the captured frame on a card in front of the user for a few seconds. */
  private showPreview(canvas: HTMLCanvasElement): void {
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const h = 0.25;
    this.preview?.removeFromParent();
    const mesh = new Mesh(new PlaneGeometry(h * aspect, h), new MeshBasicMaterial({ map: tex }));
    const cam = this.world.camera;
    const pos = cam.getWorldPosition(new Vector3());
    const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(mesh.quaternion));
    mesh.position.copy(pos).addScaledVector(fwd, 0.7);
    mesh.lookAt(pos);
    this.world.scene.add(mesh);
    this.preview = mesh;
    setTimeout(() => {
      mesh.removeFromParent();
      tex.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
      mesh.geometry.dispose();
    }, 8000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return `${+v.toFixed(3)}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function measureFrames(video: HTMLVideoElement, ms: number): Promise<{ fps: number; latencyMs: number | null }> {
  type Meta = { presentationTime?: number; captureTime?: number; expectedDisplayTime?: number };
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, m: Meta) => void) => number };
  if (!v.requestVideoFrameCallback) {
    // Fallback: count currentTime changes.
    let frames = 0;
    let last = v.currentTime;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await sleep(5);
      if (v.currentTime !== last) {
        frames++;
        last = v.currentTime;
      }
    }
    return { fps: (frames * 1000) / ms, latencyMs: null };
  }
  return new Promise((resolve) => {
    let frames = 0;
    const lat: number[] = [];
    const t0 = performance.now();
    const tick = (now: number, m: Meta) => {
      frames++;
      if (m.captureTime && m.expectedDisplayTime) lat.push(m.expectedDisplayTime - m.captureTime);
      if (now - t0 < ms) v.requestVideoFrameCallback!(tick);
      else resolve({ fps: (frames * 1000) / (now - t0), latencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null });
    };
    v.requestVideoFrameCallback!(tick);
  });
}

function averageLuma(c: HTMLCanvasElement): number {
  const s = document.createElement('canvas');
  s.width = 32;
  s.height = 24;
  const g = s.getContext('2d')!;
  g.drawImage(c, 0, 0, 32, 24);
  const d = g.getImageData(0, 0, 32, 24).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

function toThumb(c: HTMLCanvasElement, w: number): string {
  const s = document.createElement('canvas');
  s.width = w;
  s.height = Math.round((w * c.height) / c.width);
  s.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height);
  return s.toDataURL('image/jpeg', 0.7);
}
