import {
  DepthSensingSystem,
  GLSL3,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type World,
} from '@iwsdk/core';
import { unprojectDepth } from '../core/scanMap.js';

/** Depth readback grid (per sample). Low resolution is plenty for walls and ceilings. */
const W = 80;
const H = 60;
/** Trust range of the headset depth, meters. */
const MIN_M = 0.35;
const MAX_M = 4.5;

/**
 * Reads the headset's depth (the texture IWSDK's DepthSensingSystem already
 * keeps for occlusion) back to the CPU at low resolution and turns it into
 * world-space points. Depth is packed into 8-bit RGBA so it works on any GPU.
 */
export class DepthSampler {
  private rt = new WebGLRenderTarget(W, H);
  private scene = new Scene();
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: ShaderMaterial;
  private buf = new Uint8Array(W * H * 4);
  private viewM = new Matrix4();
  private tmp = new Vector3();
  lastError: string | null = null;

  constructor(private world: World) {
    this.mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {
        uDepth: { value: null },
        uIsGPU: { value: true },
        uRaw: { value: 0.001 },
        uNear: { value: 0 },
      },
      vertexShader: `
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        precision highp sampler2DArray;
        uniform sampler2DArray uDepth;
        uniform bool uIsGPU;
        uniform float uRaw;
        uniform float uNear;
        in vec2 vUv;
        out vec4 outColor;
        void main() {
          vec2 uv = uIsGPU ? vUv : vec2(vUv.x, 1.0 - vUv.y);
          float t = texture(uDepth, vec3(uv, 0.0)).r;
          float m = uIsGPU ? uRaw * uNear / (1.0 - t) : t * uRaw;
          float mm = clamp(floor(m * 1000.0 + 0.5), 0.0, 65535.0);
          outColor = vec4(floor(mm / 256.0) / 255.0, mod(mm, 256.0) / 255.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.mat));
  }

  /** Readback size, for consumers of {@link readMeters}. */
  readonly width = W;
  readonly height = H;

  /**
   * Read the current depth image as meters (row 0 = bottom), W x H.
   * Returns false when depth isn't available this frame.
   */
  readMeters(out: Float32Array): boolean {
    if (!this.renderPass()) return false;
    for (let i = 0, k = 0; i < W * H; i++, k += 4) out[i] = (this.buf[k] * 256 + this.buf[k + 1]) / 1000;
    return true;
  }

  /** Render the packed-depth pass and read it into `buf`. */
  private renderPass(): boolean {
    const world = this.world;
    const frame = world.xrFrame;
    const ds = world.getSystem(DepthSensingSystem) as unknown as
      | { getDepthTextureArray(): unknown; gpuDepthData: Array<{ depthNear?: number }>; rawValueToMeters: number }
      | undefined;
    if (!frame || !ds) return false;
    const tex = ds.getDepthTextureArray();
    if (!tex) return false;
    const u = this.mat.uniforms;
    u.uDepth.value = tex;
    u.uIsGPU.value = ds.gpuDepthData.length > 0;
    u.uRaw.value = ds.rawValueToMeters || 0.001;
    u.uNear.value = ds.gpuDepthData[0]?.depthNear ?? 0;
    const r = world.renderer;
    const xrOn = r.xr.enabled;
    const prev = r.getRenderTarget();
    try {
      r.xr.enabled = false;
      r.setRenderTarget(this.rt);
      r.render(this.scene, this.cam);
      r.readRenderTargetPixels(this.rt, 0, 0, W, H, this.buf);
    } catch (e) {
      this.lastError = (e as Error).message;
      return false;
    } finally {
      r.setRenderTarget(prev);
      r.xr.enabled = xrOn;
    }
    return true;
  }

  /**
   * Read the current depth image with its view: depth in mm (row 0 = bottom),
   * projection, and the view's world transform. Null when depth isn't ready.
   */
  capture(): { depthMM: Uint16Array; proj: Float32Array; viewWorld: Float32Array } | null {
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    if (!frame || !ref) return null;
    const view = frame.getViewerPose(ref)?.views[0];
    if (!view || !this.renderPass()) return null;
    const depthMM = new Uint16Array(W * H);
    for (let i = 0, k = 0; i < W * H; i++, k += 4) depthMM[i] = this.buf[k] * 256 + this.buf[k + 1];
    return { depthMM, proj: new Float32Array(view.projectionMatrix), viewWorld: new Float32Array(view.transform.matrix) };
  }

  /**
   * Sample the current frame. Calls `emit(x, y, z)` with world-space points.
   * Returns the number of points, or -1 when depth isn't available.
   */
  sample(emit: (x: number, y: number, z: number) => void, stride = 1): number {
    const world = this.world;
    const frame = world.xrFrame;
    const ref = world.xrReferenceSpace;
    const ds = world.getSystem(DepthSensingSystem) as unknown as {
      getDepthTextureArray(): unknown;
      gpuDepthData: Array<{ depthNear?: number }>;
      cpuDepthData: unknown[];
      rawValueToMeters: number;
    } | undefined;
    if (!frame || !ref || !ds) return -1;
    const tex = ds.getDepthTextureArray();
    if (!tex) return -1;
    const pose = frame.getViewerPose(ref);
    const view = pose?.views[0];
    if (!view) return -1;

    const isGPU = ds.gpuDepthData.length > 0;
    const u = this.mat.uniforms;
    u.uDepth.value = tex;
    u.uIsGPU.value = isGPU;
    u.uRaw.value = ds.rawValueToMeters || 0.001;
    u.uNear.value = ds.gpuDepthData[0]?.depthNear ?? 0;

    const r = world.renderer;
    const xrOn = r.xr.enabled;
    const prev = r.getRenderTarget();
    try {
      r.xr.enabled = false; // render our small pass with our own camera
      r.setRenderTarget(this.rt);
      r.render(this.scene, this.cam);
      r.readRenderTargetPixels(this.rt, 0, 0, W, H, this.buf);
    } catch (e) {
      this.lastError = (e as Error).message;
      return -1;
    } finally {
      r.setRenderTarget(prev);
      r.xr.enabled = xrOn;
    }

    this.viewM.fromArray(view.transform.matrix);
    const P = view.projectionMatrix;
    let n = 0;
    for (let j = 0; j < H; j += stride) {
      for (let i = 0; i < W; i += stride) {
        const k = (j * W + i) * 4;
        const m = (this.buf[k] * 256 + this.buf[k + 1]) / 1000;
        if (m < MIN_M || m > MAX_M) continue;
        const p = unprojectDepth((i + 0.5) / W, (j + 0.5) / H, m, P);
        this.tmp.set(p.x, p.y, p.z).applyMatrix4(this.viewM);
        emit(this.tmp.x, this.tmp.y, this.tmp.z);
        n++;
      }
    }
    return n;
  }
}
