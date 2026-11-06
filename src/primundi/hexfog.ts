/**
 * Primundi's fog in the hex view: a storm bank standing on every neighbouring hex not yet
 * revealed, so the tile can't be used to peek at what's around it.
 *
 * The same idea as the planet's fog (fog.ts): a volume marched per pixel, with where the fog lies
 * baked into a texture over the backdrop (R before the current reveal, G after, B the ground's
 * height so the march stops at the land). Here it also writes its depth, at the first dense
 * cloud, so a nearer hill, tree or house on the tile still hides the bank behind it.
 *
 * Local map coordinates throughout (x east, y north, metres); drawn as three.js (x, h, −y).
 */
import * as THREE from 'three';
import type { LocalMap } from '../hexlocal.ts';

const RES = 256;

const VERT = /* glsl */`
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp sampler3D;
uniform sampler2D tFog;
uniform sampler3D tNoise;
uniform vec3 uCam, uSun, uFlashPos;
uniform vec3 uBoxMin, uBoxMax;
uniform float uTime, uMix, uFlash, uHalf, uGLo, uGHi, uDepth, uScale;
uniform mat4 uMVP;
varying vec3 vPos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 ro = uCam, rd = normalize(vPos - uCam);
  // The ray's stretch inside the box.
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float tA = max(max(max(tn.x, tn.y), tn.z), 0.0), tB = min(min(tf.x, tf.y), tf.z);
  if (tB <= tA) discard;
  const int N = 48;
  float dt = (tB - tA) / float(N);
  float t = tA + dt * hash(gl_FragCoord.xy);
  float T = 1.0, tHit = -1.0;
  vec3 col = vec3(0.0);
  vec3 drift = vec3(uTime * 0.012, 0.0, uTime * 0.007);
  float day = smoothstep(-0.12, 0.25, uSun.y);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * t;
    vec2 m = vec2(p.x, -p.z);                       // map x, y
    vec3 q = p * uScale;
    float nLow = textureLod(tNoise, q + drift * uScale * 40.0, 0.0).r;
    vec2 w = m + (vec2(nLow, textureLod(tNoise, q + 0.37, 0.0).r) - 0.5) * uHalf * 0.12;
    vec4 f = textureLod(tFog, w / (2.0 * uHalf) + 0.5, 0.0);
    float ground = uGLo + f.b * (uGHi - uGLo);
    float above = p.y - ground;
    if (above < 0.0) break;
    float k = clamp(uMix * 1.5 - nLow * 0.5, 0.0, 1.0);
    float fog = mix(f.r, f.g, k);
    float n = textureLod(tNoise, q * 3.7 + drift * uScale * 90.0, 0.0).r;
    float top = uDepth * (0.3 + 0.7 * smoothstep(0.2, 0.95, fog)) * (0.75 + 0.45 * nLow);
    float dens = smoothstep(0.05, 0.9, fog) * smoothstep(top, top * 0.8, above) * smoothstep(0.3, 0.6, n * 0.65 + nLow * 0.55);
    if (dens > 0.001) {
      float a = 1.0 - exp(-dens * dt * 6.0 / uDepth * 8.0);
      if (tHit < 0.0 && a > 0.04) tHit = t;
      float hf = clamp(above / max(top, 1.0), 0.0, 1.0);
      float lit = mix(0.15, 1.0, hf * hf) * (0.35 + 0.65 * n) * (1.15 - 0.5 * nLow);
      vec3 c = mix(vec3(0.04, 0.05, 0.06), mix(vec3(0.1, 0.11, 0.13), vec3(0.5, 0.52, 0.56), clamp(lit, 0.0, 1.0)), day);
      float dl = length(p - uFlashPos) / (uDepth * 0.9);
      c += vec3(0.75, 0.82, 1.0) * uFlash * 3.0 * exp(-dl * dl) * (1.0 - hf * 0.5);
      col += T * a * c;
      T *= 1.0 - a;
      if (T < 0.015) break;
    }
    t += dt;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002 || tHit < 0.0) discard;
  // Depth at the first dense cloud: whatever is nearer on the tile hides the bank.
  vec4 clip = uMVP * vec4(ro + rd * tHit, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(col / alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

let sharedNoise: THREE.Data3DTexture | null = null;

export class HexFog {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture;
  private data = new Uint8Array(RES * RES * 4);
  private texCell = new Int32Array(RES * RES);
  private seenNow = new Set<number>();
  private seenNext = new Set<number>();
  private anim = -1;
  private fogged: number[] = [];
  private flashT = -1;
  private nextFlash = 3;
  /** A strike happened: how near the tile (0..1), for the thunder. */
  onStrike: ((near: number) => void) | null = null;

  constructor(noise: THREE.Data3DTexture) {
    sharedNoise = noise;
    this.tex = new THREE.DataTexture(this.data, RES, RES, THREE.RGBAFormat);
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tFog: { value: this.tex }, tNoise: { value: sharedNoise },
        uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(0, 1, 0) },
        uFlashPos: { value: new THREE.Vector3() }, uFlash: { value: 0 },
        uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
        uTime: { value: 0 }, uMix: { value: 1 }, uHalf: { value: 1 }, uGLo: { value: 0 }, uGHi: { value: 1 },
        uDepth: { value: 1 }, uScale: { value: 1 }, uMVP: { value: new THREE.Matrix4() },
      },
      transparent: true, depthTest: true, depthWrite: false, side: THREE.BackSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'primundi-fog';
    this.mesh.visible = false;
  }

  /**
   * Lay the fog over a backdrop map. `ground(x, y)` is the drawn ground (the tile's own inside it),
   * `seen` the revealed cells; any other cell in the backdrop is fogged.
   */
  set(ctx: LocalMap, tileWidth: number, ground: (x: number, y: number) => number, seen: Iterable<number>) {
    const half = ctx.size / 2, R = RES;
    this.seenNow = new Set(seen); this.seenNext = new Set(this.seenNow); this.anim = -1;
    // Each texel's nearest cell centre.
    const n = ctx.cells.length;
    let lo = Infinity, hi = -Infinity;
    const gh = new Float32Array(R * R);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const x = -half + (i + 0.5) / R * ctx.size, y = -half + (j + 0.5) / R * ctx.size;
      let best = -1, bd = Infinity;
      for (let k = 0; k < n; k++) { const d = (ctx.cellXY[k * 2] - x) ** 2 + (ctx.cellXY[k * 2 + 1] - y) ** 2; if (d < bd) { bd = d; best = k; } }
      this.texCell[j * R + i] = best >= 0 ? ctx.cells[best] : -1;
      const g = ground(x, y);
      gh[j * R + i] = g; lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
    for (let p = 0; p < R * R; p++) this.data[p * 4 + 2] = Math.round((gh[p] - lo) / Math.max(1, hi - lo) * 255);
    this.fogged = [];
    for (let k = 0; k < n; k++) if (!this.seenNext.has(ctx.cells[k])) this.fogged.push(k);
    this.ctx = ctx;
    this.fill();
    const depth = tileWidth * 0.32;
    const u = this.mat.uniforms;
    u.uHalf.value = half; u.uGLo.value = lo; u.uGHi.value = hi; u.uDepth.value = depth;
    u.uScale.value = 1 / (tileWidth * 1.4);
    u.uBoxMin.value.set(-half, lo - 5, -half); u.uBoxMax.value.set(half, hi + depth * 1.3, half);
    this.mesh.geometry.dispose();
    const box = new THREE.BoxGeometry(ctx.size, hi + depth * 1.3 - lo + 5, ctx.size);
    box.translate(0, (lo - 5 + hi + depth * 1.3) / 2, 0);
    this.mesh.geometry = box;
    this.mesh.visible = this.fogged.length > 0;
  }
  private ctx: LocalMap | null = null;

  private fill() {
    const d = this.data, tc = this.texCell;
    for (let p = 0; p < RES * RES; p++) {
      const c = tc[p];
      d[p * 4] = c < 0 || !this.seenNow.has(c) ? 255 : 0;
      d[p * 4 + 1] = c < 0 || !this.seenNext.has(c) ? 255 : 0;
    }
    this.tex.needsUpdate = true;
  }

  /** More cells revealed: the bank over them clears, animated. */
  reveal(cells: Iterable<number>) {
    if (this.anim >= 0) this.seenNow = new Set(this.seenNext);
    let any = false;
    for (const c of cells) if (!this.seenNext.has(c)) { this.seenNext.add(c); any = true; }
    if (!any || !this.ctx) return;
    this.fogged = this.fogged.filter((k) => !this.seenNext.has(this.ctx!.cells[k]));
    this.anim = 0; this.mat.uniforms.uMix.value = 0;
    this.fill();
  }

  /** Per frame. `cam` in the fog's own (local) space; `mvp` maps local to clip. */
  update(cam: THREE.Vector3, mvp: THREE.Matrix4, sun: THREE.Vector3, dt: number, time: number) {
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam); u.uMVP.value.copy(mvp); u.uSun.value.copy(sun); u.uTime.value = time;
    if (this.anim >= 0) {
      this.anim += dt / 3.2;
      const e = Math.min(1, this.anim);
      u.uMix.value = e * e * (3 - 2 * e);
      if (this.anim >= 1) { this.seenNow = new Set(this.seenNext); this.anim = -1; this.fill(); u.uMix.value = 1; }
    }
    // Lightning now and then, somewhere in a fogged neighbour.
    if (!this.ctx || !this.fogged.length || !this.mesh.visible) { u.uFlash.value = 0; return; }
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      const k = this.fogged[Math.floor(Math.random() * this.fogged.length)];
      const x = this.ctx.cellXY[k * 2], y = this.ctx.cellXY[k * 2 + 1];
      u.uFlashPos.value.set(x, u.uGLo.value + u.uDepth.value * 0.4, -y);
      this.flashT = 0;
      this.nextFlash = 7 + Math.random() * 16;
      const near = 1 - Math.min(1, Math.hypot(x, y) / (this.ctx.size * 0.5));
      this.onStrike?.(near);
    }
    if (this.flashT >= 0) {
      this.flashT += dt;
      u.uFlash.value = flicker(this.flashT);
      if (this.flashT > 0.7) { this.flashT = -1; u.uFlash.value = 0; }
    }
  }
}

/** A strike's brightness over its first 0.7 s: two or three quick flickers. */
export function flicker(t: number): number {
  const pulse = (c: number, w: number, a: number) => a * Math.exp(-(((t - c) / w) ** 2));
  return Math.min(1, pulse(0.03, 0.03, 1) + pulse(0.16, 0.04, 0.6) + pulse(0.33, 0.06, 0.8) + pulse(0.5, 0.08, 0.25));
}
