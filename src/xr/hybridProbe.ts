/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DepthSampler } from './depthSampler.js';

/**
 * Can a separate WebGPU device do the scanning math beside the WebGL AR
 * session? Quest gives depth only to WebGL sessions, so the plan reads a
 * small depth image back each scan tick and fuses it on WebGPU.
 * Runs ~20 s inside AR: baseline, fusion at scan rate, fusion every frame.
 */
const N = 128;

export interface HybridRow {
  name: string;
  ok: boolean | null;
  detail: string;
}

export class HybridProbe {
  running = false;
  private device: any = null;
  private pipeline: any = null;
  private bind: any = null;
  private depthTex: any = null;
  private uni: any = null;
  private out: any = null;
  private staging: any = null;
  private meters: Float32Array;
  private phase = 0;
  private t0 = -1;
  private frames = 0;
  private frameNo = 0;
  private fps: number[] = [];
  private readMs = 0;
  private reads = 0;
  private gpuMs = 0;
  private gpuRuns = 0;
  private mapMs = 0;
  private maps = 0;
  private busy = false;
  private done: ((rows: HybridRow[]) => void) | null = null;
  private rows: HybridRow[] = [];
  private readonly phases = [
    { name: 'App frame rate, no fusion', secs: 5, every: 0 },
    { name: 'App frame rate, fusion at scan rate', secs: 10, every: 10 },
    { name: 'App frame rate, fusion every frame', secs: 5, every: 1 },
  ];

  constructor(private sampler: DepthSampler) {
    this.meters = new Float32Array(sampler.width * sampler.height);
  }

  async start(): Promise<HybridRow[]> {
    this.rows = [];
    const nav: any = navigator;
    if (!nav.gpu) return [{ name: 'WebGPU beside WebGL', ok: false, detail: 'navigator.gpu missing' }];
    try {
      const adapter = await nav.gpu.requestAdapter();
      this.device = await adapter.requestDevice();
    } catch (e) {
      return [{ name: 'WebGPU beside WebGL', ok: false, detail: `no device: ${(e as Error).message}` }];
    }
    const d = this.device;
    const W = this.sampler.width;
    const H = this.sampler.height;
    const vox = d.createBuffer({ size: N * N * N * 4, usage: 0x80 });
    this.out = d.createBuffer({ size: 65536, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
    this.staging = d.createBuffer({ size: 65536, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
    this.uni = d.createBuffer({ size: 16, usage: 0x40 | 0x8 });
    this.depthTex = d.createTexture({ size: [W, H], format: 'r32float', usage: 0x4 | 0x2 });
    const module = d.createShaderModule({
      code: `
        @group(0) @binding(0) var<storage, read_write> tsdf: array<f32>;
        @group(0) @binding(1) var depth: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> u: vec4<f32>;
        @group(0) @binding(3) var<storage, read_write> outv: array<f32>;
        @compute @workgroup_size(4, 4, 4)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let n = ${N}u;
          if (id.x >= n || id.y >= n || id.z >= n) { return; }
          let p = (vec3<f32>(id) / f32(n) - vec3<f32>(0.5, 0.5, 0.0)) * 5.0 + vec3<f32>(0.0, 0.0, 0.3);
          let uv = p.xy / p.z * 0.5 + vec2<f32>(0.5, 0.5);
          if (any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { return; }
          let d = textureLoad(depth, vec2<i32>(uv * u.xy), 0).r;
          if (d <= 0.0) { return; }
          let sdf = clamp((d - p.z) / 0.08, -1.0, 1.0);
          let i = id.x + id.y * n + id.z * n * n;
          tsdf[i] = mix(tsdf[i], sdf, 0.1);
          if (i < 16384u) { outv[i] = tsdf[i]; }
        }`,
    });
    this.pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.bind = d.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: vox } },
        { binding: 1, resource: this.depthTex.createView() },
        { binding: 2, resource: { buffer: this.uni } },
        { binding: 3, resource: { buffer: this.out } },
      ],
    });
    this.rows.push({ name: 'WebGPU device beside WebGL AR', ok: true, detail: 'created' });
    this.running = true;
    this.phase = 0;
    this.t0 = -1;
    this.frames = 0;
    this.fps = [];
    return new Promise((resolve) => (this.done = resolve));
  }

  /** Call every XR frame while running. */
  tick(time: number): void {
    if (!this.running) return;
    if (this.t0 < 0) this.t0 = time;
    const p = this.phases[this.phase];
    this.frames++;
    this.frameNo++;
    if (p.every && this.frameNo % p.every === 0 && !this.busy) this.fuse();
    if (time - this.t0 >= p.secs) {
      this.fps[this.phase] = this.frames / (time - this.t0);
      this.phase++;
      this.frames = 0;
      this.t0 = time;
      if (this.phase >= this.phases.length) this.finish();
    }
  }

  private fuse(): void {
    const d = this.device;
    const W = this.sampler.width;
    const H = this.sampler.height;
    const t0 = performance.now();
    if (!this.sampler.readMeters(this.meters)) return;
    this.readMs += performance.now() - t0;
    this.reads++;
    d.queue.writeTexture({ texture: this.depthTex }, this.meters, { bytesPerRow: W * 4 }, [W, H]);
    d.queue.writeBuffer(this.uni, 0, new Float32Array([W, H, 0, 0]));
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(N / 4, N / 4, N / 4);
    pass.end();
    // Every few runs, bring a "mesh piece" back to the CPU, as the scene would need.
    const bringBack = this.gpuRuns % 4 === 0;
    if (bringBack) enc.copyBufferToBuffer(this.out, 0, this.staging, 0, 65536);
    d.queue.submit([enc.finish()]);
    const g0 = performance.now();
    this.busy = true;
    d.queue.onSubmittedWorkDone().then(async () => {
      this.gpuMs += performance.now() - g0;
      this.gpuRuns++;
      if (bringBack) {
        const m0 = performance.now();
        await this.staging.mapAsync(1 /* READ */);
        this.staging.unmap();
        this.mapMs += performance.now() - m0;
        this.maps++;
      }
      this.busy = false;
    });
  }

  private finish(): void {
    this.running = false;
    const r = this.rows;
    const f = this.fps;
    r.push({ name: 'Depth readback from WebGL', ok: this.reads > 0, detail: this.reads ? `${(this.readMs / this.reads).toFixed(2)} ms per read (${this.sampler.width}x${this.sampler.height})` : `no depth read (${this.sampler.lastError ?? 'depth not ready'})` });
    r.push({ name: 'WebGPU fusion pass (128^3 voxels)', ok: this.gpuRuns > 0, detail: this.gpuRuns ? `${(this.gpuMs / this.gpuRuns).toFixed(1)} ms to finish, ${this.gpuRuns} runs` : 'never finished' });
    r.push({ name: 'Mesh piece back to the scene', ok: this.maps > 0, detail: this.maps ? `${(this.mapMs / this.maps).toFixed(1)} ms for 64 KB` : 'not measured' });
    this.phases.forEach((p, i) => {
      if (f[i] !== undefined) r.push({ name: p.name, ok: f[i] >= 70, detail: `${f[i].toFixed(0)} fps` });
    });
    const ok = this.reads > 0 && this.gpuRuns > 0 && (f[1] ?? 0) >= 70;
    r.push({
      name: 'Verdict',
      ok,
      detail: ok ? 'WebGL depth + WebGPU fusion works on this headset' : this.reads === 0 ? 'No depth read: test again in AR with depth on' : 'Fusion costs frames: run fusion in WebGL2 instead',
    });
    this.device?.destroy();
    this.device = null;
    this.done?.(r);
  }
}
