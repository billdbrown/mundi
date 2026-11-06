/**
 * Primundi's fog of war on the planet: a storm bank lying on every cell not yet revealed.
 *
 * Drawn as a volume, marched per pixel through a shell from just under sea level to above the
 * highest peaks. Where the fog lies comes from an equirectangular texture (one texel ≈ 3 km at the
 * equator), filled per cell: R the fog before the current reveal, G after it, B the ground's height
 * so the march stops at the land. A reveal animates between the two with a patchy dissolve, so the
 * cloud thins and sinks unevenly instead of snapping off.
 *
 * Lightning flickers inside the bank (flash()); the game decides when and plays the thunder.
 */
import * as THREE from 'three';
import type { World } from '../world.ts';
import { SEA, type SurfaceQueries } from '../surface.ts';

const W = 1536, H = 768;
/** The shell, planet radii: under the sea floor's top to above every peak and the cloud deck. */
export const FOG_R0 = SEA - 0.004, FOG_R1 = SEA + 0.026;
/** How deep the bank stands over the ground, radii (~5 km). Less than a hex is wide, so a clearing
 * can be seen into from the side. */
const FOG_DEPTH = 0.0085;

let noiseTex: THREE.Data3DTexture | null = null;
/** Tileable value noise, 64³, three octaves baked in: the cloud's texture. Made once. */
export function noiseTexture(): THREE.Data3DTexture {
  if (noiseTex) return noiseTex;
  const n = 64, lat = (s: number) => {
    const g = new Float32Array(s * s * s);
    let x = 0x9e3779b9;
    for (let i = 0; i < g.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; g[i] = ((x >>> 0) % 10000) / 10000; }
    return g;
  };
  const sample = (g: Float32Array, s: number, x: number, y: number, z: number) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    const at = (a: number, b: number, c: number) => g[(((c % s) + s) % s) * s * s + (((b % s) + s) % s) * s + (((a % s) + s) % s)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(l(l(at(i, j, k), at(i + 1, j, k), sx), l(at(i, j + 1, k), at(i + 1, j + 1, k), sx), sy),
      l(l(at(i, j, k + 1), at(i + 1, j, k + 1), sx), l(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), sx), sy), sz);
  };
  const g8 = lat(8), g16 = lat(16), g32 = lat(32);
  const data = new Uint8Array(n * n * n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = 0.55 * sample(g8, 8, x / 8, y / 8, z / 8) + 0.3 * sample(g16, 16, x / 4, y / 4, z / 4) + 0.15 * sample(g32, 32, x / 2, y / 2, z / 2);
    data[(z * n + y) * n + x] = Math.round(v * 255);
  }
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RedFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return (noiseTex = t);
}

const VERT = /* glsl */`
varying vec3 vPos;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */`
precision highp sampler3D;
uniform sampler2D tFog;
uniform sampler3D tNoise;
uniform vec3 uCam, uSun, uFlashDir;
uniform float uTime, uMix, uFlash, uR0, uR1, uDepth;
varying vec3 vPos;
const float PI = 3.14159265;

vec2 equi(vec3 d) { return vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 ro = uCam, rd = normalize(vPos - uCam);
  float b = dot(ro, rd), c1 = dot(ro, ro) - uR1 * uR1, h1 = b * b - c1;
  if (h1 < 0.0) discard;
  float s1 = sqrt(h1), tA = max(0.0, -b - s1), tB = -b + s1;
  float c0 = dot(ro, ro) - uR0 * uR0, h0 = b * b - c0;
  if (h0 > 0.0) { float tg = -b - sqrt(h0); if (tg > 0.0) tB = min(tB, tg); }
  if (tB <= tA) discard;
  const int N = 48;
  float len = tB - tA, dt = len / float(N);
  float t = tA + dt * hash(gl_FragCoord.xy);
  float T = 1.0;
  vec3 col = vec3(0.0);
  float span = uR1 - uR0;
  vec3 drift = vec3(uTime * 0.0011, 0.0, uTime * 0.0007);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * t;
    float r = length(p);
    vec3 d = p / r;
    // Coarse noise, also for warping the fog's outline and the reveal's patches.
    float nLow = textureLod(tNoise, p * 9.0 + drift * 0.5, 0.0).r;
    vec3 wd = normalize(d + (vec3(nLow, textureLod(tNoise, p * 9.0 + 0.37, 0.0).r, textureLod(tNoise, p * 9.0 + 0.71, 0.0).r) - 0.5) * 0.012);
    vec4 f = textureLod(tFog, equi(wd), 0.0);
    float above = r - (uR0 + f.b * span);
    if (above < 0.0) break;
    float k = clamp(uMix * 1.5 - nLow * 0.5, 0.0, 1.0);
    float fog = mix(f.r, f.g, k);
    float n = textureLod(tNoise, p * 34.0 + drift, 0.0).r;
    // The bank's top: high in its heart, sinking toward its edge and as it clears.
    float top = uDepth * (0.35 + 0.65 * smoothstep(0.2, 0.95, fog)) * (0.7 + 0.55 * nLow);
    float dens = smoothstep(0.05, 0.9, fog) * smoothstep(top, top * 0.72, above) * smoothstep(0.32, 0.6, n * 0.65 + nLow * 0.55);
    if (dens > 0.001) {
      float a = 1.0 - exp(-dens * dt * 700.0);
      float hf = clamp(above / top, 0.0, 1.0);
      // Lit from above: dark storm grey low in the bank, pale on its sunny tops.
      float sunUp = dot(d, uSun);
      float day = smoothstep(-0.25, 0.35, sunUp);
      // Thick, low cloud is dark; the billows' tops catch the light.
      float lit = mix(0.15, 1.0, hf * hf) * (0.35 + 0.65 * n) * (1.15 - 0.5 * nLow);
      vec3 c = mix(vec3(0.04, 0.05, 0.06), mix(vec3(0.1, 0.11, 0.13), vec3(0.5, 0.52, 0.56), clamp(lit, 0.0, 1.0)), day);
      // Lightning: a bluish glow low in the cloud around the strike.
      float ang = acos(clamp(dot(d, uFlashDir), -1.0, 1.0));
      c += vec3(0.75, 0.82, 1.0) * uFlash * 3.2 * exp(-ang * ang / 0.00035) * (1.0 - hf * 0.6);
      col += T * a * c;
      T *= 1.0 - a;
      if (T < 0.015) break;
    }
    t += dt;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(col / alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class PlanetFog {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture;
  private data = new Uint8Array(W * H * 4);
  private pixCell = new Int32Array(W * H);
  /** Fog per cell now (0 clear, 1 fogged), and where the current reveal is going. */
  private now: Float32Array;
  private next: Float32Array;
  private anim = -1;
  /** Seconds a reveal takes. */
  static REVEAL_S = 3.2;

  constructor(world: World, surface: SurfaceQueries) {
    const g = world.grid, P = g.centers, N = g.count;
    this.now = new Float32Array(N).fill(1);
    this.next = new Float32Array(N).fill(1);
    // Which cell each texel falls in: walk from the last texel's cell to the nearest centre.
    let c = 0;
    const score = (k: number, x: number, y: number, z: number) => P[k * 3] * x + P[k * 3 + 1] * y + P[k * 3 + 2] * z;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H) * Math.PI - Math.PI / 2, cl = Math.cos(lat), y = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W) * Math.PI * 2 - Math.PI, x = cl * Math.sin(lon), z = cl * Math.cos(lon);
        for (let guard = 0; guard < 400; guard++) {
          let best = c, bs = score(c, x, y, z);
          for (const nb of g.neighbors[c]) { const s = score(nb, x, y, z); if (s > bs) { bs = s; best = nb; } }
          if (best === c) break;
          c = best;
        }
        this.pixCell[j * W + i] = c;
      }
    }
    const span = FOG_R1 - FOG_R0, ground = new Uint8Array(N);
    for (let k = 0; k < N; k++) ground[k] = Math.round(THREE.MathUtils.clamp((Math.max(surface.centerH(k), SEA) - FOG_R0) / span, 0, 1) * 255);
    for (let p = 0; p < W * H; p++) this.data[p * 4 + 2] = ground[this.pixCell[p]];
    this.tex = new THREE.DataTexture(this.data, W, H, THREE.RGBAFormat);
    this.tex.wrapS = THREE.RepeatWrapping;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.fill();

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tFog: { value: this.tex }, tNoise: { value: noiseTexture() },
        uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(0, 0, 1) },
        uFlashDir: { value: new THREE.Vector3(0, 1, 0) }, uFlash: { value: 0 },
        uTime: { value: 0 }, uMix: { value: 1 }, uR0: { value: FOG_R0 }, uR1: { value: FOG_R1 }, uDepth: { value: FOG_DEPTH },
      },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(FOG_R1, 96, 48), this.mat);
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'primundi-fog';
  }

  private fill() {
    const d = this.data, pc = this.pixCell, a = this.now, b = this.next;
    for (let p = 0; p < W * H; p++) { const k = pc[p]; d[p * 4] = a[k] * 255; d[p * 4 + 1] = b[k] * 255; }
    this.tex.needsUpdate = true;
  }

  fogged(cell: number) { return this.next[cell] > 0.5; }

  /** Clear these cells: animated unless `instant` (loading a save). */
  reveal(cells: Iterable<number>, instant = false) {
    if (this.anim >= 0) this.now.set(this.next);   // a reveal in progress finishes at once
    let any = false;
    for (const c of cells) if (this.next[c] > 0) { this.next[c] = 0; any = true; }
    if (!any) return;
    if (instant) { this.now.set(this.next); this.anim = -1; this.mat.uniforms.uMix.value = 1; }
    else { this.anim = 0; this.mat.uniforms.uMix.value = 0; }
    this.fill();
  }

  /** A lightning flash at this direction (unit vector, planet space), brightness 0..1. */
  setFlash(dir: THREE.Vector3, k: number) {
    this.mat.uniforms.uFlashDir.value.copy(dir);
    this.mat.uniforms.uFlash.value = k;
  }

  /** Per frame: the camera (planet space), the sun's direction, seconds since the last frame. */
  update(cam: THREE.Vector3, sun: THREE.Vector3, dt: number, time: number) {
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam);
    u.uSun.value.copy(sun);
    u.uTime.value = time;
    if (this.anim >= 0) {
      this.anim += dt / PlanetFog.REVEAL_S;
      const e = Math.min(1, this.anim);
      u.uMix.value = e * e * (3 - 2 * e);
      if (this.anim >= 1) { this.now.set(this.next); this.anim = -1; this.fill(); u.uMix.value = 1; }
    }
  }
}
