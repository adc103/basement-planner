/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * One-page check: can this headset run the scanner on WebGPU?
 * 1. A WebGPU immersive-ar session through three.js's WebGPURenderer.
 * 2. The headset's depth inside that session (GPU or CPU path).
 * 3. Depth uploaded to the GPU + a TSDF-sized compute pass, at frame rate.
 * Results float in front of you in the headset and are kept for the page.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  MeshNormalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

type Mode = 'gpu' | 'cpu';
type Row = [string, string, 'ok' | 'bad' | 'warn' | ''];
const STORE = 'basement-planner:gpu-xr-check:v1';
const N = 128; // voxels per side: 128^3 = 2.1M, about a 5 m cube at 4 cm

const $ = (id: string) => document.getElementById(id)!;
const logEl = $('log');
const log = (s: string) => {
  logEl.textContent += `${s}\n`;
};

function loadAll(): Record<string, Row[]> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}');
  } catch {
    return {};
  }
}

function show(): void {
  const all = loadAll();
  const t = $('results');
  t.innerHTML = '';
  for (const [mode, rows] of Object.entries(all)) {
    const h = document.createElement('tr');
    h.innerHTML = `<td colspan="2"><b>Run: ${mode === 'gpu' ? 'GPU depth' : mode === 'cpu' ? 'CPU depth' : mode}</b></td>`;
    t.appendChild(h);
    for (const [k, v, cls] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${k}</td><td class="${cls}">${v}</td>`;
      t.appendChild(tr);
    }
  }
}

function summary(): string {
  const all = loadAll();
  return Object.entries(all)
    .map(([m, rows]) => [`[${m}]`, ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n'))
    .join('\n\n');
}

// --- Static checks before any session ---------------------------------------
async function staticChecks(): Promise<Row[]> {
  const rows: Row[] = [];
  const nav: any = navigator;
  rows.push(['WebGPU (navigator.gpu)', nav.gpu ? 'yes' : 'no', nav.gpu ? 'ok' : 'bad']);
  rows.push(['XRGPUBinding', typeof (globalThis as any).XRGPUBinding !== 'undefined' ? 'yes' : 'no', typeof (globalThis as any).XRGPUBinding !== 'undefined' ? 'ok' : 'bad']);
  if (nav.gpu) {
    try {
      const ad = await nav.gpu.requestAdapter({ xrCompatible: true });
      rows.push(['XR-compatible GPU adapter', ad ? 'yes' : 'no', ad ? 'ok' : 'bad']);
    } catch (e) {
      rows.push(['XR-compatible GPU adapter', `error: ${(e as Error).message}`, 'bad']);
    }
  }
  const ar = nav.xr ? await nav.xr.isSessionSupported('immersive-ar').catch(() => false) : false;
  rows.push(['immersive-ar supported', ar ? 'yes' : 'no', ar ? 'ok' : 'bad']);
  return rows;
}

// --- The XR run ---------------------------------------------------------------
async function run(mode: Mode): Promise<void> {
  logEl.textContent = '';
  const rows: Row[] = await staticChecks();
  const save = () => {
    const all = loadAll();
    all[mode] = rows;
    localStorage.setItem(STORE, JSON.stringify(all));
    show();
  };
  const nav: any = navigator;
  if (!nav.xr || !nav.gpu) {
    rows.push(['Session', 'skipped: no WebXR or WebGPU', 'bad']);
    save();
    return;
  }

  const renderer = new WebGPURenderer({ antialias: false, alpha: true });
  renderer.xr.enabled = true; // before init: asks for an XR-compatible adapter
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'none';
  try {
    await renderer.init();
  } catch (e) {
    rows.push(['WebGPU renderer', `failed: ${(e as Error).message}`, 'bad']);
    save();
    return;
  }
  const backend: any = (renderer as any).backend;
  rows.push(['Renderer backend', backend.isWebGPUBackend ? 'WebGPU' : 'WebGL fallback', backend.isWebGPUBackend ? 'ok' : 'bad']);
  const device: any = backend.device;

  let session: any;
  try {
    session = await nav.xr.requestSession('immersive-ar', {
      requiredFeatures: ['webgpu'],
      optionalFeatures: ['depth-sensing', 'local-floor', 'hand-tracking'],
      depthSensing: {
        usagePreference: mode === 'gpu' ? ['gpu-optimized', 'cpu-optimized'] : ['cpu-optimized', 'gpu-optimized'],
        dataFormatPreference: ['float32', 'luminance-alpha', 'unsigned-short'],
      },
    });
  } catch (e) {
    rows.push(['WebGPU AR session', `refused: ${(e as Error).message}`, 'bad']);
    save();
    return;
  }
  const feats: string[] = [...(session.enabledFeatures ?? [])];
  rows.push(['WebGPU AR session', 'started', 'ok']);
  rows.push(['Enabled features', feats.join(', ') || '(none listed)', '']);
  const hasDepth = feats.includes('depth-sensing');
  rows.push(['Depth sensing granted', hasDepth ? `yes (${session.depthUsage}, ${session.depthDataFormat})` : 'no', hasDepth ? 'ok' : 'bad']);
  save();

  try {
    renderer.xr.setReferenceSpaceType(feats.includes('local-floor') ? 'local-floor' : 'local');
    await renderer.xr.setSession(session);
  } catch (e) {
    rows.push(['three.js XR on WebGPU', `failed: ${(e as Error).message}`, 'bad']);
    save();
    session.end().catch(() => {});
    return;
  }
  rows.push(['three.js XR on WebGPU', 'rendering', 'ok']);

  // Scene: a spinning cube 1 m ahead, and a results panel that follows your head.
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 1, 0.01, 50);
  scene.add(camera);
  const cube = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshNormalMaterial());
  cube.position.set(0, 1.4, -1);
  scene.add(cube);
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;
  const tex = new CanvasTexture(canvas);
  const panel = new Mesh(new PlaneGeometry(0.64, 0.4), new MeshBasicMaterial({ map: tex, transparent: true }));
  panel.position.set(0, -0.08, -0.9);
  camera.add(panel);

  // GPU resources for the fusion-sized workload.
  const vox = device.createBuffer({ size: N * N * N * 4, usage: 0x80 /* STORAGE */ });
  let depthTex: any = null;
  let depthW = 0;
  let depthH = 0;
  const uni = device.createBuffer({ size: 32, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
  const module = device.createShaderModule({
    code: `
      @group(0) @binding(0) var<storage, read_write> tsdf: array<f32>;
      @group(0) @binding(1) var depth: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> u: vec4<f32>; // depth w, h, time
      @compute @workgroup_size(4, 4, 4)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let n = ${N}u;
        if (id.x >= n || id.y >= n || id.z >= n) { return; }
        // voxel -> a point in front of the eye; project with a simple pinhole
        let p = (vec3<f32>(id) / f32(n) - vec3<f32>(0.5, 0.5, 0.0)) * vec3<f32>(5.0, 5.0, 5.0) + vec3<f32>(0.0, 0.0, 0.3);
        let uv = p.xy / p.z * 0.5 + vec2<f32>(0.5, 0.5);
        if (any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { return; }
        let px = vec2<i32>(uv * u.xy);
        let d = textureLoad(depth, px, 0).r;
        if (d <= 0.0) { return; }
        let sdf = clamp((d - p.z) / 0.08, -1.0, 1.0);
        let i = id.x + id.y * n + id.z * n * n;
        tsdf[i] = mix(tsdf[i], sdf, 0.1);
      }`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  let bindGroup: any = null;
  const ensureDepthTex = (w: number, h: number) => {
    if (depthTex && w === depthW && h === depthH) return;
    depthTex?.destroy();
    depthW = w;
    depthH = h;
    depthTex = device.createTexture({ size: [w, h], format: 'r32float', usage: 0x4 | 0x2 /* TEXTURE_BINDING | COPY_DST */ });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: vox } },
        { binding: 1, resource: depthTex.createView() },
        { binding: 2, resource: { buffer: uni } },
      ],
    });
  };
  ensureDepthTex(160, 160); // synthetic depth until real depth arrives
  const meters = new Float32Array(1);
  let meterBuf = new Float32Array(160 * 160).fill(2);
  device.queue.writeTexture({ texture: depthTex }, meterBuf, { bytesPerRow: 160 * 4 }, [160, 160]);

  // Measurement phases: plain render, compute every frame, compute at 6 Hz-ish.
  const phases = [
    { name: 'Render only', secs: 6, every: 0 },
    { name: 'Fusion pass every frame', secs: 7, every: 1 },
    { name: 'Fusion pass every 8th frame', secs: 7, every: 8 },
  ];
  const fps: number[] = [];
  let phase = 0;
  let phaseT0 = -1;
  let frames = 0;
  let frameNo = 0;
  let depthSeen = 0;
  let depthNote = 'waiting';
  let gpuDepthNote = '';
  let centerM = NaN;
  let uploadMs = 0;
  let uploads = 0;
  let done = false;
  // Diagnostics: where the depth path stops.
  const diag = { loops: 0, noFrame: 0, noPose: 0, noView: 0, gpuNull: 0, thrown: 0, cpuTry: 0, cpuOk: 0, lastError: '' };
  let bindingInfo = '';

  const draw = () => {
    ctx.fillStyle = 'rgba(17,20,24,0.92)';
    ctx.fillRect(0, 0 , 1024, 640);
    ctx.fillStyle = '#e8edf2';
    ctx.font = '600 40px system-ui';
    ctx.fillText('WebGPU XR check', 32, 60);
    ctx.font = '30px system-ui';
    const lines = [
      `Mode: ${mode === 'gpu' ? 'GPU depth first' : 'CPU depth first'}  |  session: ${session.depthUsage ?? 'no depth'}`,
      `Depth: ${depthNote}${Number.isFinite(centerM) ? `  (center ${centerM.toFixed(2)} m)` : ''}`,
      gpuDepthNote ? `GPU depth: ${gpuDepthNote}` : '',
      `frames ${diag.loops}  no pose ${diag.noPose}  empty ${diag.gpuNull}  errors ${diag.thrown}`,
      ...phases.map((p, i) => `${p.name}: ${fps[i] !== undefined ? `${fps[i].toFixed(0)} fps` : i === phase && !done ? 'measuring...' : '-'}`),
      done ? 'Done. Press the Meta button and exit to see results.' : 'Look around your basement...',
    ].filter(Boolean);
    lines.forEach((l, i) => ctx.fillText(l, 32, 110 + i * 46));
    tex.needsUpdate = true;
  };

  const finish = () => {
    if (done) return;
    done = true;
    rows.push(['Depth frames received', `${depthSeen} (${depthNote})`, depthSeen > 0 ? 'ok' : 'bad']);
    rows.push([
      'Depth path diagnostics',
      `loops ${diag.loops}, no frame ${diag.noFrame}, no pose ${diag.noPose}, no view ${diag.noView}, empty ${diag.gpuNull}, errors ${diag.thrown}${diag.lastError ? ` (${diag.lastError})` : ''}, CPU getter ok ${diag.cpuOk}/${diag.cpuTry}`,
      '',
    ]);
    if (bindingInfo) rows.push(['XRGPUBinding', bindingInfo, '']);
    if (gpuDepthNote) rows.push(['GPU depth through XRGPUBinding', gpuDepthNote, gpuDepthNote.startsWith('texture') ? 'ok' : 'warn']);
    if (Number.isFinite(centerM)) rows.push(['Depth at view center', `${centerM.toFixed(2)} m`, 'ok']);
    if (uploads) rows.push(['Depth upload to GPU', `${(uploadMs / uploads).toFixed(2)} ms per frame (${depthW}x${depthH})`, uploadMs / uploads < 2 ? 'ok' : 'warn']);
    phases.forEach((p, i) => {
      const f = fps[i];
      if (f !== undefined) rows.push([p.name, `${f.toFixed(0)} fps`, f >= 70 ? 'ok' : f >= 55 ? 'warn' : 'bad']);
    });
    const verdict =
      depthSeen > 0 && (fps[2] ?? 0) >= 70
        ? 'WebGPU scanner is viable on this headset'
        : depthSeen === 0
          ? 'No depth in a WebGPU session: stay on WebGL for scanning'
          : 'Depth works but frame rate is short: fuse less often or use WebGL';
    rows.push(['Verdict', verdict, depthSeen > 0 && (fps[2] ?? 0) >= 70 ? 'ok' : 'warn']);
    save();
    draw();
  };

  session.addEventListener('end', () => {
    finish();
    renderer.setAnimationLoop(null);
    log('Session ended.');
  });

  renderer.setAnimationLoop((time: number, xrFrame?: any) => {
    // The WebGPU renderer hands the XR frame to the loop; getFrame() stays null here.
    const frame: any = xrFrame ?? renderer.xr.getFrame();
    const t = time / 1000;
    cube.rotation.y = t;
    if (phaseT0 < 0) phaseT0 = t;

    // Depth, whichever path the session picked. Count every way it can fail.
    diag.loops++;
    if (!frame) diag.noFrame++;
    if (frame && hasDepth) {
      const ref = renderer.xr.getReferenceSpace();
      const pose = ref ? frame.getViewerPose(ref) : null;
      if (!pose) diag.noPose++;
      const view = pose?.views?.[0];
      if (pose && !view) diag.noView++;
      if (view) {
        try {
          if (session.depthUsage === 'cpu-optimized') {
            const d = frame.getDepthInformation(view);
            if (!d) diag.gpuNull++;
            if (d) {
              depthSeen++;
              depthNote = `CPU ${d.width}x${d.height}`;
              centerM = d.getDepthInMeters(0.5, 0.5);
              const t0 = performance.now();
              ensureDepthTex(d.width, d.height);
              if (meterBuf.length !== d.width * d.height) meterBuf = new Float32Array(d.width * d.height);
              const src = session.depthDataFormat === 'float32' ? new Float32Array(d.data) : new Uint16Array(d.data);
              const k = d.rawValueToMeters;
              for (let i = 0; i < meterBuf.length; i++) meterBuf[i] = src[i] * k;
              device.queue.writeTexture({ texture: depthTex }, meterBuf, { bytesPerRow: d.width * 4 }, [d.width, d.height]);
              uploadMs += performance.now() - t0;
              uploads++;
            }
          } else {
            const binding: any = renderer.xr.getWebGPUBinding();
            if (!bindingInfo) {
              const proto = binding ? Object.getOwnPropertyNames(Object.getPrototypeOf(binding)) : [];
              bindingInfo = binding ? `methods: ${proto.filter((k) => k !== 'constructor').join(', ')}` : 'no binding';
            }
            if (!binding || typeof binding.getDepthInformation !== 'function') {
              gpuDepthNote = 'XRGPUBinding has no getDepthInformation';
              depthNote = 'not available on the GPU path';
            } else {
              let d: any = null;
              try {
                d = binding.getDepthInformation(view);
              } catch (e) {
                diag.thrown++;
                diag.lastError = (e as Error).message;
              }
              if (!d) {
                diag.gpuNull++;
                depthNote = 'GPU call returned nothing';
              } else {
                depthSeen++;
                const keys: string[] = [];
                for (const k in d) keys.push(k);
                gpuDepthNote = d.texture ? `texture ${d.width ?? d.texture.width}x${d.height ?? d.texture.height}, near ${d.depthNear ?? '?'}, image ${d.imageIndex ?? '?'}` : `object without texture (${keys.join(', ')})`;
                depthNote = 'GPU texture';
              }
            }
            // Does the CPU getter work alongside? (It should throw for a GPU session.)
            if (diag.cpuTry < 3) {
              diag.cpuTry++;
              try {
                if (frame.getDepthInformation(view)) diag.cpuOk++;
              } catch (e) {
                if (!diag.lastError) diag.lastError = `cpu getter: ${(e as Error).message}`;
              }
            }
          }
        } catch (e) {
          diag.thrown++;
          diag.lastError = (e as Error).message;
          depthNote = `error: ${diag.lastError}`;
        }
      }
    } else if (!hasDepth) depthNote = 'not granted';

    // Fusion-sized compute pass on the schedule of the current phase.
    const p = phases[phase];
    if (p && p.every && frameNo % p.every === 0 && bindGroup) {
      meters[0] = t;
      device.queue.writeBuffer(uni, 0, new Float32Array([depthW, depthH, t, 0]));
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(N / 4, N / 4, N / 4);
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    frameNo++;

    // Phase timing.
    if (!done && p) {
      frames++;
      if (t - phaseT0 >= p.secs) {
        fps[phase] = frames / (t - phaseT0);
        phase++;
        frames = 0;
        phaseT0 = t;
        if (phase >= phases.length) finish();
      }
    }
    if (frameNo % 30 === 0) draw();
    renderer.render(scene, camera);
  });
  draw();
  log(`Session started (${mode}).`);
}

$('start').textContent = 'Start (GPU depth)';
const cpuBtn = document.createElement('button');
cpuBtn.textContent = 'Start (CPU depth)';
$('start').after(cpuBtn);
$('start').addEventListener('click', () => void run('gpu').catch((e) => log(`Error: ${(e as Error).message}`)));
cpuBtn.addEventListener('click', () => void run('cpu').catch((e) => log(`Error: ${(e as Error).message}`)));
$('copy').addEventListener('click', async () => {
  const text = summary() || 'No results yet';
  try {
    await navigator.clipboard.writeText(text);
    log('Copied.');
  } catch {
    log(text);
  }
});
void staticChecks().then((rows) => {
  const all = loadAll();
  all['before any session'] = rows;
  localStorage.setItem(STORE, JSON.stringify(all));
  show();
});
