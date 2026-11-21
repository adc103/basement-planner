import { DepthSensingSystem, Vector2, type Material, type World } from '@iwsdk/core';

/**
 * Depth occlusion for planned surfaces that sit ON real surfaces: real walls,
 * the floor finish, the ceiling. Standard occlusion compares against the real
 * depth at the same spot, which for these is the surface itself, so they
 * flicker and nothing shows in front of them. Here the comparison gets a
 * margin: only things clearly in front (your arms, a chair) hide them.
 */
const shared = {
  uSoDepth: { value: null as unknown },
  uSoEnabled: { value: false },
  uSoGPU: { value: true },
  uSoRaw: { value: 0.001 },
  uSoNear: { value: 0 },
  uSoViewport: { value: new Vector2(1, 1) },
};

let on = true;

export function setSurfaceOcclusion(enabled: boolean): void {
  on = enabled;
}

/** Patch a material to fade where something real is more than `bias` meters in front of it. */
export function surfaceOccludable<T extends Material>(m: T, bias = 0.1): T {
  m.transparent = true;
  const prev = m.onBeforeCompile?.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, shared, { uSoBias: { value: bias } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'varying float vSoDepth;\n#include <common>')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvSoDepth = -(modelViewMatrix * vec4(position, 1.0)).z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uSoDepth;
uniform bool uSoEnabled;
uniform bool uSoGPU;
uniform float uSoRaw;
uniform float uSoNear;
uniform vec2 uSoViewport;
uniform float uSoBias;
varying float vSoDepth;
#ifndef VIEW_ID
#define VIEW_ID 0
#endif
float soMeters(vec2 uv) {
  float t = texture(uSoDepth, vec3(uv, float(VIEW_ID))).r;
  return uSoGPU ? uSoRaw * uSoNear / (1.0 - t) : t * uSoRaw;
}
float soSample(vec2 uv, float d) { return smoothstep(0.0, 0.04, soMeters(uv) - d); }`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
if (uSoEnabled) {
  vec2 suv = gl_FragCoord.xy / uSoViewport;
  vec2 duv = uSoGPU ? suv : vec2(suv.x, 1.0 - suv.y);
  float d = vSoDepth - uSoBias;
  vec2 px = 8.0 / uSoViewport;
  float a = soSample(duv, d) * 0.4 + (soSample(duv + vec2(px.x, 0.0), d) + soSample(duv - vec2(px.x, 0.0), d)
    + soSample(duv + vec2(0.0, px.y), d) + soSample(duv - vec2(0.0, px.y), d)) * 0.15;
  if (a < 0.01) discard;
  diffuseColor.a *= a;
}`,
      );
  };
  m.customProgramCacheKey = () => `so${bias}`;
  m.needsUpdate = true;
  return m;
}

/** Per frame: feed the current depth texture to every patched material. */
export function updateSurfaceOcclusion(world: World): void {
  const ds = world.getSystem(DepthSensingSystem) as unknown as
    | { getDepthTextureArray(): unknown; gpuDepthData: Array<{ depthNear?: number }>; rawValueToMeters: number }
    | undefined;
  const tex = ds && world.session ? ds.getDepthTextureArray() : undefined;
  shared.uSoEnabled.value = on && !!tex;
  if (!tex || !ds) {
    shared.uSoDepth.value = null;
    return;
  }
  shared.uSoDepth.value = tex;
  shared.uSoGPU.value = ds.gpuDepthData.length > 0;
  shared.uSoRaw.value = ds.rawValueToMeters || 0.001;
  shared.uSoNear.value = ds.gpuDepthData[0]?.depthNear ?? 0;
  world.renderer.getDrawingBufferSize(shared.uSoViewport.value);
}
