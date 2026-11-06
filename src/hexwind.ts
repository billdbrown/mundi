/**
 * Wind in the hex view (2026-11-06): plants sway with it, gusts roll across the map in waves, and
 * now and then a wind line (a thin white streak that curls as it goes) drifts past through the air.
 * One clock and one direction for all of it, so the grass, the trees and the lines agree.
 */
import * as THREE from 'three';

/** Shared by every material that moves with the wind. Direction is on the map (x east, y north). */
export const wind = {
  uWindT: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  /** 0 calm .. 1 a stiff breeze. */
  uWindK: { value: 0.6 },
};

/**
 * GLSL: how far the wind pushes a point of a plant, in the plant's own units (one unit tall).
 * p: the plant's base on the map (three.js x, z); y: height up the plant, 0..1; leaf: 0..1 (leaves
 * flutter, bark only bends); stiff: how much the plant resists (big trees more than grass).
 */
export const SWAY_GLSL = /* glsl */`
  uniform float uWindT, uWindK; uniform vec2 uWindDir;
  vec3 windSway(vec2 p, float y, float leaf, float stiff) {
    vec2 d = vec2(uWindDir.x, -uWindDir.y);
    float along = dot(p, d), across = dot(p, vec2(-d.y, d.x));
    // Gusts: broad bands moving downwind, bent so their fronts aren't straight lines.
    float gust = 0.5 + 0.5 * sin(along * 0.035 - uWindT * 1.7 + sin(across * 0.021 + uWindT * 0.3) * 2.2);
    gust = gust * gust;
    float ph = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) * 6.283;
    float bend = (0.35 + 0.9 * gust + 0.18 * sin(uWindT * 1.9 + ph)) * uWindK / stiff;
    float h2 = y * y;
    vec3 o = vec3(d.x, 0.0, d.y) * bend * h2 * 0.06;
    o.y -= bend * bend * h2 * 0.012;
    // Leaves flutter: small and quick, out of step with each other.
    float fl = leaf * h2 * (0.4 + gust) * uWindK / stiff;
    o += vec3(sin(uWindT * 7.0 + ph + y * 9.0), sin(uWindT * 6.1 + ph * 1.7) * 0.5, cos(uWindT * 7.7 + ph + y * 7.0)) * fl * 0.012;
    return o;
  }`;

/** The vertex hook: moves `transformed` (model space) by the wind, for an instanced plant. */
const SWAY_VERTEX = /* glsl */`
  #include <begin_vertex>
  #ifdef USE_INSTANCING
  {
    vec3 base = instanceMatrix[3].xyz;
    float sc = length(instanceMatrix[1].xyz);
    // Bigger plants are stiffer: a 1 m bush bends more of its height than an 18 m pine.
    float stiff = 0.7 + sqrt(max(sc, 0.1)) * 0.35;
    #ifdef USE_COLOR_ALPHA
      float leaf = color.a;
    #else
      float leaf = 1.0;
    #endif
    transformed += windSway(base.xz, clamp(position.y, 0.0, 1.2), leaf, stiff);
  }
  #endif`;

/** Make a plant material sway (call before any other hook is chained onto it). */
export function swayMaterial(mat: THREE.Material) {
  const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, wind);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SWAY_GLSL)
      .replace('#include <begin_vertex>', SWAY_VERTEX);
  };
  mat.customProgramCacheKey = () => (key ? key() : '') + '|sway';
}

/** The depth material for a swaying plant's shadow, so the shadow sways too. */
export const swayDepth = new THREE.MeshDepthMaterial();
swayMaterial(swayDepth);

/**
 * Wind lines: thin white streaks drifting downwind through the air near where the camera looks,
 * each living a few seconds, fading in and out, with a lazy wave and now and then a curl.
 * Positions are spawned on the CPU (they need the ground's height); the shape is drawn in the shader.
 */
export class WindLines {
  readonly mesh: THREE.Mesh;
  private readonly n: number;
  private readonly origin: Float32Array;
  private readonly params: Float32Array;
  private readonly oAttr: THREE.InstancedBufferAttribute;
  private readonly pAttr: THREE.InstancedBufferAttribute;
  private readonly born: Float32Array;
  readonly uniforms = { uTime: wind.uWindT, uWindDir: wind.uWindDir, uScale: { value: 1 }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.32 } };

  constructor(n = 16, seg = 40) {
    this.n = n;
    // A strip of seg segments; s runs 0..1 along it, side -1 / 1 across.
    const pos = new Float32Array((seg + 1) * 2 * 3), idx: number[] = [];
    for (let k = 0; k <= seg; k++) for (let sd = 0; sd < 2; sd++) { pos[(k * 2 + sd) * 3] = k / seg; pos[(k * 2 + sd) * 3 + 1] = sd * 2 - 1; }
    for (let k = 0; k < seg; k++) { const o = k * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.origin = new Float32Array(n * 3);
    this.params = new Float32Array(n * 4);
    this.born = new Float32Array(n).fill(-1e9);
    this.oAttr = new THREE.InstancedBufferAttribute(this.origin, 3);
    this.pAttr = new THREE.InstancedBufferAttribute(this.params, 4);
    g.setAttribute('origin', this.oAttr);
    g.setAttribute('params', this.pAttr);
    g.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec3 origin;
        attribute vec4 params;   // birth time, life (s), curl (0 none), seed
        uniform float uTime, uScale; uniform vec2 uWindDir;
        varying float vA;
        vec3 path(float s, float seed, float curl, float L) {
          vec2 d = vec2(uWindDir.x, -uWindDir.y), q = vec2(-d.y, d.x);
          vec3 p = vec3(d.x, 0.0, d.y) * s * L;
          p += vec3(q.x, 0.0, q.y) * sin(s * 4.0 + seed * 6.28) * L * 0.06;
          p.y += sin(s * 3.0 + seed * 11.0) * L * 0.035;
          // A curl: a loop around the line's way, part way along.
          float c = curl * smoothstep(0.35, 0.5, s) * (1.0 - smoothstep(0.62, 0.75, s));
          float a = (s - 0.35) / 0.4 * 6.283;
          p += (vec3(d.x, 0.0, d.y) * -sin(a) + vec3(0.0, 1.0, 0.0) * (1.0 - cos(a))) * c * L * 0.07;
          return p;
        }
        void main() {
          float age = (uTime - params.x) / params.y;
          float L = 24.0 * uScale;
          // The visible part: a short stretch sliding along the path as the line ages.
          float head = age * 1.35, tail = head - 0.38;
          float s = mix(tail, head, position.x);
          vec3 p = origin + path(s, params.w, params.z, L) + vec3(uWindDir.x, 0.0, -uWindDir.y) * age * L * 0.25;
          vec3 p2 = origin + path(s + 0.01, params.w, params.z, L) + vec3(uWindDir.x, 0.0, -uWindDir.y) * age * L * 0.25;
          vec4 wp = modelMatrix * vec4(p, 1.0), wp2 = modelMatrix * vec4(p2, 1.0);
          vec3 t = normalize(wp2.xyz - wp.xyz), toCam = normalize(cameraPosition - wp.xyz);
          vec3 side = normalize(cross(t, toCam));
          float w = 0.07 * uScale * sin(3.14159 * position.x) * length(modelMatrix[0].xyz);
          wp.xyz += side * position.y * w;
          vA = sin(3.14159 * clamp(age, 0.0, 1.0)) * smoothstep(0.0, 0.25, position.x) * (s >= 0.0 && s <= 1.0 ? 1.0 : 0.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity; varying float vA;
        void main() { if (vA <= 0.001) discard; gl_FragColor = vec4(uColor, vA * uOpacity); }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'windlines';
    this.mesh.renderOrder = 5;
  }

  /**
   * Respawn the lines that have run their course, around (cx, cy) on the map within radius r,
   * at a height over the ground (ground(x, y)), scaled to how far off the camera is.
   */
  update(now: number, cx: number, cy: number, r: number, scale: number, ground: (x: number, y: number) => number, rate = 1) {
    this.uniforms.uScale.value = scale;
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      const life = this.params[i * 4 + 1];
      if (now - this.born[i] < life) continue;
      // Not all at once: a line rests a while before it comes back.
      if (Math.random() > 0.02 * rate) continue;
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
      const x = cx + Math.cos(a) * d - wind.uWindDir.value.x * r * 0.3, y = cy + Math.sin(a) * d - wind.uWindDir.value.y * r * 0.3;
      const h = ground(x, y) + (2 + Math.random() * 10) * scale;
      this.origin.set([x, h, -y], i * 3);
      const lf = 2.6 + Math.random() * 1.8;
      this.params.set([now, lf, Math.random() < 0.25 ? 1 : 0, Math.random()], i * 4);
      this.born[i] = now;
      dirty = true;
    }
    if (dirty) { this.oAttr.needsUpdate = true; this.pAttr.needsUpdate = true; }
  }

  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

/** Cloud shadows: soft patches of shade drifting downwind over the land (2026-11-06). */
export const clouds = {
  /** World (three.js scene) to map coordinates: the inverse of the map group's matrix. */
  uToMap: { value: new THREE.Matrix4() },
  /** 0 clear .. 1 overcast-ish; how dark the shade is. */
  uCloudCover: { value: 0.5 },
  uCloudDark: { value: 0.45 },
};

const CLOUD_GLSL = /* glsl */`
  uniform mat4 uToMap; uniform float uCloudCover, uCloudDark;
  uniform float uWindT; uniform vec2 uWindDir;
  float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y);
  }
  float cloudShade(vec3 worldPos) {
    vec2 p = (uToMap * vec4(worldPos, 1.0)).xz;
    // Clouds a few hundred metres across (the map is drawn 10x small), drifting at ~5 m/s.
    vec2 q = p * 0.0042 - vec2(uWindDir.x, -uWindDir.y) * uWindT * 0.022;
    float n = cNoise(q) * 0.6 + cNoise(q * 2.3 + 5.2) * 0.28 + cNoise(q * 5.1 + 1.7) * 0.12;
    float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.16, n);
    return 1.0 - c * uCloudDark;
  }`;

/** Shade a lit material's sunlight by the drifting clouds. Chain after the aerial hook. */
export function cloudMaterial(mat: THREE.Material) {
  const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, clouds, { uWindT: wind.uWindT, uWindDir: wind.uWindDir });
    let f = sh.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin);
    // (uWindT/uWindDir may be declared already, by the sway in the vertex shader only: fragment
    // shaders are separate, so declaring them here again is fine.)
    f = f.replace('#include <common>', '#include <common>\n' + CLOUD_GLSL)
      .replace('getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudShade(cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz);');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => (key ? key() : '') + '|cloud';
  mat.needsUpdate = true;
}
