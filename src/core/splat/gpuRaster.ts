/**
 * The per-pixel part of splat training on the GPU (WebGPU compute): one workgroup per
 * 16x16 tile renders its pixels front to back, compares them with the photo, and walks
 * back to front adding each Gaussian's screen-space gradient. Same math as `rasterize`
 * in gs.ts (the CPU reference, which the tests hold it to).
 *
 * Within a tile the gradients are summed in fixed point (workgroup atomics), scaled by
 * each Gaussian's own pixel size so every value stays in range; across tiles they are
 * added as floats (compare-and-swap), once per Gaussian per tile.
 */
import { G2, TILE, type Bins, type Projected } from './gs.js';

const BATCH = 128;
const FIXED = 4096;
/** Per projected Gaussian in the upload: x, y, conic a, b, c, r, g, b, alpha, size (px). */
const PS = 10;

const WGSL = /* wgsl */ `
struct Params { w: u32, h: u32, tilesX: u32, count: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> proj: array<f32>;
@group(0) @binding(2) var<storage, read> ranges: array<u32>;
@group(0) @binding(3) var<storage, read> list: array<u32>;
@group(0) @binding(4) var<storage, read> photo: array<u32>;
@group(0) @binding(5) var<storage, read_write> grads: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> image: array<u32>;
@group(0) @binding(7) var<storage, read_write> loss: array<f32>;

const BATCH = ${BATCH}u;
const FIXED = ${FIXED}.0;

var<workgroup> sXY: array<vec2f, ${BATCH}>;
var<workgroup> sCon: array<vec3f, ${BATCH}>;
var<workgroup> sCol: array<vec4f, ${BATCH}>;
var<workgroup> sSize: array<f32, ${BATCH}>;
var<workgroup> sK: array<u32, ${BATCH}>;
var<workgroup> acc: array<atomic<i32>, ${BATCH * G2}>;

fn addf(i: u32, v: f32) {
  var old = atomicLoad(&grads[i]);
  loop {
    let r = atomicCompareExchangeWeak(&grads[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

fn load(slot: u32, pos: u32, end: u32) {
  if (pos < end) {
    let k = list[pos];
    let o = k * ${PS}u;
    sK[slot] = k;
    sXY[slot] = vec2f(proj[o], proj[o + 1u]);
    sCon[slot] = vec3f(proj[o + 2u], proj[o + 3u], proj[o + 4u]);
    sCol[slot] = vec4f(proj[o + 5u], proj[o + 6u], proj[o + 7u], proj[o + 8u]);
    sSize[slot] = proj[o + 9u];
  }
}

fn fx(v: f32) -> i32 { return i32(round(v * FIXED)); }

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let tile = wg.y * P.tilesX + wg.x;
  let px = wg.x * 16u + lid.x;
  let py = wg.y * 16u + lid.y;
  let inside = px < P.w && py < P.h;
  let a0 = ranges[2u * tile];
  let a1 = ranges[2u * tile + 1u];
  let nb = (a1 - a0 + BATCH - 1u) / BATCH;
  let f = vec2f(f32(px) + 0.5, f32(py) + 0.5);

  // Front to back.
  var T = 1.0;
  var C = vec3f(0.0);
  var last = 0u; // one past the last list position that was blended
  var done = !inside;
  for (var b = 0u; b < nb; b++) {
    workgroupBarrier();
    if (li < BATCH) { load(li, a0 + b * BATCH + li, a1); }
    workgroupBarrier();
    let n = min(BATCH, a1 - a0 - b * BATCH);
    for (var j = 0u; j < n; j++) {
      if (done) { break; }
      let d = f - sXY[j];
      let c = sCon[j];
      let power = -0.5 * (c.x * d.x * d.x + c.z * d.y * d.y) - c.y * d.x * d.y;
      if (power > 0.0) { continue; }
      let al = min(0.99, sCol[j].w * exp(power));
      if (al < 1.0 / 255.0) { continue; }
      let nT = T * (1.0 - al);
      if (nT < 1e-4) { done = true; break; }
      C += sCol[j].xyz * (al * T);
      T = nT;
      last = a0 + b * BATCH + j + 1u;
    }
  }

  var dC = vec3f(0.0);
  if (inside) {
    let pi = py * P.w + px;
    let t = photo[pi];
    let tc = vec3f(f32(t & 255u), f32((t >> 8u) & 255u), f32((t >> 16u) & 255u)) / 255.0;
    let valid = (t >> 24u) > 0u;
    let e = C - tc;
    if (valid) { dC = sign(e); loss[pi] = abs(e.x) + abs(e.y) + abs(e.z); } else { loss[pi] = 0.0; }
    let q = vec3u(clamp(C, vec3f(0.0), vec3f(1.0)) * 255.0 + 0.5);
    image[pi] = q.x | (q.y << 8u) | (q.z << 16u) | (255u << 24u);
  }

  // Back to front.
  var Tb = T;
  var S = vec3f(0.0);
  for (var bb = 0u; bb < nb; bb++) {
    let b = nb - 1u - bb;
    workgroupBarrier();
    if (li < BATCH) { load(li, a0 + b * BATCH + li, a1); }
    for (var z = li; z < BATCH * ${G2}u; z += 256u) { atomicStore(&acc[z], 0); }
    workgroupBarrier();
    let base = a0 + b * BATCH;
    let n = min(BATCH, a1 - base);
    if (inside && (dC.x != 0.0 || dC.y != 0.0 || dC.z != 0.0)) {
      for (var jj = 0u; jj < n; jj++) {
        let j = n - 1u - jj;
        if (base + j >= last) { continue; }
        let d = f - sXY[j];
        let c = sCon[j];
        let power = -0.5 * (c.x * d.x * d.x + c.z * d.y * d.y) - c.y * d.x * d.y;
        if (power > 0.0) { continue; }
        let g = exp(power);
        let raw = sCol[j].w * g;
        let al = min(0.99, raw);
        if (al < 1.0 / 255.0) { continue; }
        Tb = Tb / (1.0 - al);
        let col = sCol[j].xyz;
        let dCol = Tb * al * dC;
        let dAl = dot(col * Tb - S / (1.0 - al), dC);
        S += col * (al * Tb);
        let o = j * ${G2}u;
        atomicAdd(&acc[o + 5u], fx(dCol.x));
        atomicAdd(&acc[o + 6u], fx(dCol.y));
        atomicAdd(&acc[o + 7u], fx(dCol.z));
        if (raw > 0.99) { continue; }
        atomicAdd(&acc[o + 8u], fx(g * dAl));
        let dPow = al * dAl;
        let s = sSize[j];
        atomicAdd(&acc[o + 0u], fx(dPow * (c.x * d.x + c.y * d.y) * s));
        atomicAdd(&acc[o + 1u], fx(dPow * (c.z * d.y + c.y * d.x) * s));
        let s2 = 1.0 / (s * s);
        atomicAdd(&acc[o + 2u], fx(dPow * (-0.5 * d.x * d.x) * s2));
        atomicAdd(&acc[o + 3u], fx(dPow * (-d.x * d.y) * s2));
        atomicAdd(&acc[o + 4u], fx(dPow * (-0.5 * d.y * d.y) * s2));
      }
    }
    workgroupBarrier();
    if (li < n) {
      let k = sK[li];
      let s = sSize[li];
      var unscale = array<f32, ${G2}>(1.0 / s, 1.0 / s, s * s, s * s, s * s, 1.0, 1.0, 1.0, 1.0);
      for (var q = 0u; q < ${G2}u; q++) {
        let v = atomicLoad(&acc[li * ${G2}u + q]);
        if (v != 0) { addf(k * ${G2}u + q, f32(v) / FIXED * unscale[q]); }
      }
    }
  }
}
`;

export interface RasterResult {
  /** Per projected Gaussian, the G2 screen-space gradients. */
  grad: Float32Array;
  /** Summed L1 over the photo's valid pixels (only when asked). */
  loss?: number;
  /** The render as RGBA bytes (only when asked). */
  image?: Uint8Array;
}

/** Grows a GPU buffer as needed. */
class Buf {
  buf: GPUBuffer | null = null;
  size = 0;
  constructor(private dev: GPUDevice, private usage: number) {}
  ensure(bytes: number): GPUBuffer {
    bytes = Math.max(16, Math.ceil(bytes / 4) * 4);
    if (!this.buf || this.size < bytes) {
      this.buf?.destroy();
      this.size = Math.ceil(bytes * 1.25 / 256) * 256;
      this.buf = this.dev.createBuffer({ size: this.size, usage: this.usage });
    }
    return this.buf;
  }
}

export class GpuRaster {
  private pipeline: GPUComputePipeline;
  private params: GPUBuffer;
  private b: Record<'proj' | 'ranges' | 'list' | 'target' | 'grads' | 'image' | 'loss' | 'readGrad' | 'readImage' | 'readLoss', Buf>;
  private upload = new Float32Array(0);

  private constructor(private dev: GPUDevice) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const R = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const RW = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.b = {
      proj: new Buf(dev, S), ranges: new Buf(dev, S), list: new Buf(dev, S), target: new Buf(dev, S),
      grads: new Buf(dev, RW), image: new Buf(dev, RW), loss: new Buf(dev, RW),
      readGrad: new Buf(dev, R), readImage: new Buf(dev, R), readLoss: new Buf(dev, R),
    };
    this.params = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
  }

  static async create(gpu: GPU | undefined = (globalThis.navigator as Navigator | undefined)?.gpu): Promise<GpuRaster | null> {
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const dev = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 512 << 20),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 << 20),
        maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 8),
      },
    });
    return new GpuRaster(dev);
  }

  destroy(): void {
    for (const b of Object.values(this.b)) b.buf?.destroy();
    this.params.destroy();
    this.dev.destroy();
  }

  /** Upload a camera's photo (RGBA bytes; alpha 0 marks pixels to ignore). */
  async run(p: Projected, bins: Bins, w: number, h: number, target: Uint8Array | Uint8ClampedArray, want: { loss?: boolean; image?: boolean } = {}): Promise<RasterResult> {
    const dev = this.dev;
    const n = Math.max(1, p.count);
    if (this.upload.length < n * PS) this.upload = new Float32Array(Math.ceil(n * 1.25) * PS);
    const up = this.upload;
    for (let k = 0; k < p.count; k++) {
      const o = k * PS;
      up[o] = p.mean2d[k * 2];
      up[o + 1] = p.mean2d[k * 2 + 1];
      up[o + 2] = p.conic[k * 3];
      up[o + 3] = p.conic[k * 3 + 1];
      up[o + 4] = p.conic[k * 3 + 2];
      up[o + 5] = p.color[k * 3];
      up[o + 6] = p.color[k * 3 + 1];
      up[o + 7] = p.color[k * 3 + 2];
      up[o + 8] = p.alpha[k];
      up[o + 9] = Math.sqrt(Math.max(p.cov2d[k * 3], p.cov2d[k * 3 + 2]));
    }
    const proj = this.b.proj.ensure(n * PS * 4);
    const ranges = this.b.ranges.ensure(bins.ranges.byteLength);
    const list = this.b.list.ensure(Math.max(4, bins.list.byteLength));
    const tgt = this.b.target.ensure(w * h * 4);
    const grads = this.b.grads.ensure(n * G2 * 4);
    const image = this.b.image.ensure(w * h * 4);
    const loss = this.b.loss.ensure(w * h * 4);
    dev.queue.writeBuffer(proj, 0, up.buffer, 0, p.count * PS * 4);
    dev.queue.writeBuffer(ranges, 0, bins.ranges.buffer as ArrayBuffer, bins.ranges.byteOffset, bins.ranges.byteLength);
    if (bins.list.byteLength) dev.queue.writeBuffer(list, 0, bins.list.buffer as ArrayBuffer, bins.list.byteOffset, bins.list.byteLength);
    dev.queue.writeBuffer(tgt, 0, target.buffer as ArrayBuffer, target.byteOffset, w * h * 4);
    dev.queue.writeBuffer(this.params, 0, new Uint32Array([w, h, bins.tilesX, p.count]));
    const enc = dev.createCommandEncoder();
    enc.clearBuffer(grads, 0, Math.ceil((n * G2 * 4) / 4) * 4);
    const pass = enc.beginComputePass();
    const pipe = this.pipeline;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [this.params, proj, ranges, list, tgt, grads, image, loss].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }));
    pass.dispatchWorkgroups(bins.tilesX, bins.tilesY);
    pass.end();
    const gBytes = p.count * G2 * 4;
    const rg = this.b.readGrad.ensure(gBytes);
    if (gBytes) enc.copyBufferToBuffer(grads, 0, rg, 0, gBytes);
    const ri = want.image ? this.b.readImage.ensure(w * h * 4) : null;
    if (ri) enc.copyBufferToBuffer(image, 0, ri, 0, w * h * 4);
    const rl = want.loss ? this.b.readLoss.ensure(w * h * 4) : null;
    if (rl) enc.copyBufferToBuffer(loss, 0, rl, 0, w * h * 4);
    dev.queue.submit([enc.finish()]);
    const out: RasterResult = { grad: new Float32Array(p.count * G2) };
    await Promise.all([
      gBytes ? rg.mapAsync(GPUMapMode.READ, 0, gBytes).then(() => { out.grad.set(new Float32Array(rg.getMappedRange(0, gBytes))); rg.unmap(); }) : null,
      ri?.mapAsync(GPUMapMode.READ, 0, w * h * 4).then(() => { out.image = new Uint8Array(ri.getMappedRange(0, w * h * 4).slice(0)); ri.unmap(); }),
      rl?.mapAsync(GPUMapMode.READ, 0, w * h * 4).then(() => { const a = new Float32Array(rl.getMappedRange(0, w * h * 4)); let s = 0; for (let i = 0; i < w * h; i++) s += a[i]; out.loss = s; rl.unmap(); }),
    ]);
    return out;
  }
}

export { TILE };
