/**
 * Shadows cast by the terrain: ridges darken the valleys beside them, dunes their lee, most of
 * all at low sun.
 *
 * Around the middle of the view, the land's height is captured from straight above (the terrain
 * mesh, plus the high-detail ground patch where it is drawn) into a height map. A pass over that
 * map marches from each texel toward the sun, and wherever the land rises above the ray the
 * texel is in shadow, softly at the edges (the sun is a disc). The ground, the patch and the
 * plants read the result and dim their direct sunlight by it; ambient light is untouched.
 *
 * The region grows with height above the ground (from a little past the horizon when low, to a
 * continent from high up), in steps, and stays put until the view moves well off its centre, so
 * shadow edges don't swim. The height map is retaken when the region moves; the shadows are
 * recomputed when the sun moves.
 */
import * as THREE from 'three';
import type { EroRequest, EroResult } from './eroworker.ts';

const SIZE = 1024;
const STEPS = 64;

export interface ShadowUniforms {
  uShC: { value: THREE.Vector3 };
  uShE: { value: THREE.Vector3 };
  uShN: { value: THREE.Vector3 };
  uShR: { value: number };
  uShMap: { value: THREE.Texture | null };
  /** The height map itself (x50), for things that look at the land's shape nearby (coasts). */
  uShH: { value: THREE.Texture | null };
  /** Water map: r near rivers (a few km), g the wider valley floor (tens of km), b the sea blurred a few km (0.5 at the shore), a the sea blurred ~40 km (delta scale). */
  uShRiv: { value: THREE.Texture | null };
  uShOn: { value: number };
  /**
   * Analytical erosion (analyticerosion.ts) of the height map, in its own frame (it arrives a
   * moment after the capture it was worked from): r carving, g log2 drainage area.
   */
  uEroMap: { value: THREE.Texture | null };
  uEroC: { value: THREE.Vector3 };
  uEroE: { value: THREE.Vector3 };
  uEroN: { value: THREE.Vector3 };
  uEroR: { value: number };
  uEroOn: { value: number };
}

/** One set, shared by everything that receives terrain shadows. */
export const shadowUniforms: ShadowUniforms = {
  uShC: { value: new THREE.Vector3(0, 0, 1) }, uShE: { value: new THREE.Vector3(1, 0, 0) }, uShN: { value: new THREE.Vector3(0, 1, 0) },
  uShR: { value: 0.1 }, uShMap: { value: null }, uShH: { value: null }, uShRiv: { value: null }, uShOn: { value: 0 },
  uEroMap: { value: null }, uEroC: { value: new THREE.Vector3(0, 0, 1) }, uEroE: { value: new THREE.Vector3(1, 0, 0) }, uEroN: { value: new THREE.Vector3(0, 1, 0) }, uEroR: { value: 0.1 }, uEroOn: { value: 0 },
};

/**
 * terrainShadow(p): 1 in sunlight, toward 0 in the terrain's shadow, at world point p.
 * groundRiver(p): the water map there (0 outside the region). groundUv(p, fade): the region's
 * texture coordinate, with fade 0 outside and at its edge.
 */
export const SHADOW_GLSL = /* glsl */`
  uniform vec3 uShC, uShE, uShN;
  uniform float uShR, uShOn;
  uniform sampler2D uShMap, uShH, uShRiv, uEroMap;
  uniform vec3 uEroC, uEroE, uEroN;
  uniform float uEroR, uEroOn;
  /** The analytical erosion at p: x carving (radians), y log2 drainage area; z its weight. */
  vec3 groundCarve(vec3 p) {
    if (uEroOn <= 0.0 || dot(p, uEroC) < 0.5) return vec3(0.0);
    vec2 lat = vec2(dot(p, uEroE), dot(p, uEroN)) / uEroR;
    float w = smoothstep(1.0, 0.8, max(abs(lat.x), abs(lat.y))) * uEroOn;
    if (w <= 0.0) return vec3(0.0);
    return vec3(texture(uEroMap, lat * 0.5 + 0.5).rg, w);
  }
  vec2 groundUv(vec3 p, out float fade) {
    fade = 0.0;
    if (uShOn < 0.5 || dot(p, uShC) < 0.5) return vec2(0.5);
    vec2 lat = vec2(dot(p, uShE), dot(p, uShN)) / uShR;
    fade = smoothstep(1.0, 0.85, max(abs(lat.x), abs(lat.y)));
    return lat * 0.5 + 0.5;
  }
  float terrainShadow(vec3 p) {
    float edge;
    vec2 uv = groundUv(p, edge);
    if (edge <= 0.0) return 1.0;
    return mix(1.0, texture(uShMap, uv).r, edge);
  }
  /** 1 well out to sea, ~0.5 at the shore, 0 a few km inland; and the uv, for neighbours. */
  float groundCoast(vec3 p) {
    float edge;
    vec2 uv = groundUv(p, edge);
    if (edge <= 0.0) return -1.0;
    return texture(uShRiv, uv).b;
  }
  /** The whole water map at p (zero outside the region). */
  vec4 groundWater(vec3 p) {
    float edge;
    vec2 uv = groundUv(p, edge);
    if (edge <= 0.0) return vec4(0.0);
    return texture(uShRiv, uv);
  }
  vec2 groundRiver(vec3 p) {
    float edge;
    vec2 uv = groundUv(p, edge);
    if (edge <= 0.0) return vec2(0.0);
    return texture(uShRiv, uv).rg * edge;
  }
`;

/**
 * Patch three's light loop so the sun's direct light is dimmed by terrainShadow(world). Not to
 * nothing: shadowed ground is lit by the sky, so a little bluish light stays (black shadows lost
 * all detail).
 */
export function shadowLights(fragmentShader: string, world: string): string {
  const chunk = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix(vec3(0.16, 0.2, 0.28), vec3(1.0), terrainShadow(${world}));`);
  return fragmentShader.replace('#include <lights_fragment_begin>', chunk);
}

const heightVertex = /* glsl */`
  varying float vH;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vH = length(w.xyz) - 1.0;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const heightFragment = /* glsl */`
  varying float vH;
  void main() { gl_FragColor = vec4(vH * 50.0, 0.0, 0.0, 1.0); }`;

const shadowFragment = /* glsl */`
  uniform vec3 uSun, uC, uE, uN;
  uniform sampler2D uHeight, uEroMap;
  uniform vec3 uEroC, uEroE, uEroN;
  uniform float uEroR, uEroOn;
  // Height at shadow-map coordinate q (lat), less the analytical erosion's carving.
  float landH(vec2 uv, vec2 q) {
    float h = max(texture(uHeight, uv).r, 0.0) / 50.0;
    if (uEroOn > 0.0) {
      vec3 p = normalize(uC + uE * q.x + uN * q.y);
      vec2 el = vec2(dot(p, uEroE), dot(p, uEroN)) / uEroR;
      if (max(abs(el.x), abs(el.y)) < 1.0) h -= texture(uEroMap, el * 0.5 + 0.5).r * uEroOn;
    }
    return h;
  }
  uniform float uR, uTexel;
  varying vec2 vUv;
  void main() {
    vec2 lat = (vUv * 2.0 - 1.0) * uR;
    vec3 up = normalize(uC + uE * lat.x + uN * lat.y);
    float cosZ = dot(uSun, up);
    // Night side, or sun overhead: nothing to do.
    if (cosZ < -0.05) { gl_FragColor = vec4(1.0); return; }
    vec3 st = uSun - up * cosZ;
    float sl = length(st);
    if (sl < 1e-4) { gl_FragColor = vec4(1.0); return; }
    vec2 dir = vec2(dot(st, uE), dot(st, uN));
    dir /= max(length(dir), 1e-6);
    float tanE = cosZ / sl;                   // how fast a ray toward the sun rises
    float h0 = landH(vUv, lat);
    // Far enough that a ray climbing at the sun's angle clears the highest ground (~0.02).
    float L = clamp((0.02 - h0) / max(tanE, 0.03), 4.0 * uTexel * uR, 2.0 * uR);
    float lit = 1.0;
    for (int i = 1; i <= ${STEPS}; i++) {
      float f = float(i) / ${STEPS}.0;
      float t = L * f * f + uTexel * uR * 1.5 * f;
      vec2 q = lat + dir * t;
      vec2 uv = q / uR * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float ht = landH(uv, q);
      // The ray's height above the sphere: rising at the sun's angle, and the sphere curving
      // away beneath it.
      float hr = h0 + 0.00004 + tanE * t + 0.5 * t * t;
      // Soft edges: the sun is a disc (exaggerated, like the relief, to ~3 degrees).
      lit = min(lit, (hr - ht) / (t * 0.05));
    }
    gl_FragColor = vec4(vec3(smoothstep(-1.0, 1.0, lit)), 1.0);
  }`;

/**
 * Water map blur, two passes (across then down): r a narrow Gaussian (the green strip right along
 * a river), g a wide one (its valley floor). Steps are in texels, so widths stay fixed on the
 * ground whatever the region's size.
 */
const blurFragment = /* glsl */`
  uniform sampler2D uSrc, uHeight;
  uniform vec2 uDir;
  uniform float uNear, uWide, uCoast, uSeaWide, uFirst;
  varying vec2 vUv;
  void main() {
    float n = 0.0, w = 0.0, s = 0.0, sw = 0.0, k = 0.0;
    for (int i = -6; i <= 6; i++) {
      float f = float(i) / 3.0, g = exp(-0.5 * f * f);
      vec4 a = texture(uSrc, vUv + uDir * float(i) * uNear / 3.0);
      vec4 b = texture(uSrc, vUv + uDir * float(i) * uWide / 3.0);
      vec2 cu = vUv + uDir * float(i) * uCoast / 3.0;
      // The sea, from the height map (below sea level) on the first pass.
      float c = uFirst > 0.5 ? step(texture(uHeight, cu).r, 0.0) : texture(uSrc, cu).b;
      vec2 du = vUv + uDir * float(i) * uSeaWide / 3.0;
      float c2 = uFirst > 0.5 ? step(texture(uHeight, du).r, 0.0) : texture(uSrc, du).a;
      n += g * a.r;
      w += g * (uFirst > 0.5 ? b.r : b.g);
      s += g * c;
      sw += g * c2;
      k += g;
    }
    gl_FragColor = vec4(n / k, w / k, s / k, sw / k);
  }`;

export class TerrainShadow {
  private height = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  private shadow = new THREE.WebGLRenderTarget(SIZE, SIZE, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 0.5);
  private heightScene = new THREE.Scene();
  private heightMat = new THREE.ShaderMaterial({ vertexShader: heightVertex, fragmentShader: heightFragment });
  private terrainCopy = new THREE.Mesh();
  private extras: THREE.Object3D[] = [];
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private shadowMat: THREE.ShaderMaterial;
  private source: THREE.Mesh | null = null;
  private centre = new THREE.Vector3(0, 0, 1);
  private radius = 0;
  private lastSun = new THREE.Vector3();
  private heightDirty = true;
  private u = shadowUniforms;
  // Analytical erosion: one job at a time in a worker; the result fades in.
  private eroWorker: Worker | null = null;
  private eroBusy = false;
  private eroWanted = false;
  private eroId = 0;
  private eroTex: THREE.DataTexture | null = null;
  private eroFadeStart = 0;
  private needCast = false;
  /** TEMPORARY A/B: analytical erosion on or off (render.ts eroSwitch). */
  setErosion(on: boolean) {
    this.eroEnabled = on;
    if (!on) { this.u.uEroOn.value = 0; this.eroFadeStart = 0; this.eroId++; }
    this.heightDirty = true;
  }
  private eroEnabled = true;
  // Water map: rivers drawn from above, then blurred two ways (blurFragment).
  private riverRaw = new THREE.WebGLRenderTarget(512, 512, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private riverTmp = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private riverMap = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private riverScene = new THREE.Scene();
  private riverMats = [1, 0.45].map((v) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(v, v, v), side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  }));
  private blurScene = new THREE.Scene();
  private blurMat: THREE.ShaderMaterial;

  constructor() {
    this.u.uShMap.value = this.shadow.texture;
    this.u.uShH.value = this.height.texture;
    this.u.uShRiv.value = this.riverMap.texture;
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: null }, uHeight: { value: this.height.texture }, uDir: { value: new THREE.Vector2() }, uNear: { value: 1 }, uWide: { value: 4 }, uCoast: { value: 1 }, uSeaWide: { value: 6 }, uFirst: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: blurFragment,
      depthTest: false, depthWrite: false,
    });
    const bq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    bq.frustumCulled = false;
    this.blurScene.add(bq);
    this.terrainCopy.matrixAutoUpdate = false;
    this.terrainCopy.frustumCulled = false;
    this.heightScene.add(this.terrainCopy);
    this.shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        uHeight: { value: this.height.texture }, uSun: { value: new THREE.Vector3() },
        uC: this.u.uShC, uE: this.u.uShE, uN: this.u.uShN, uR: { value: 0.1 }, uTexel: { value: 2 / SIZE },
        uEroMap: this.u.uEroMap, uEroC: this.u.uEroC, uEroE: this.u.uEroE, uEroN: this.u.uEroN, uEroR: this.u.uEroR, uEroOn: this.u.uEroOn,
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: shadowFragment,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shadowMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** The terrain to cast shadows, or null for none. */
  setTerrain(terrain: THREE.Mesh | null) {
    this.source = terrain;
    this.heightDirty = true;
    this.u.uEroOn.value = 0;
    this.eroId++;                    // results for the old terrain are stale
    if (!terrain) this.u.uShOn.value = 0;
  }

  /** Read back the height map just captured and send it to the erosion worker. */
  private startErosion(renderer: THREE.WebGLRenderer, c: THREE.Vector3, e: THREE.Vector3, n: THREE.Vector3, r: number) {
    if (typeof Worker === 'undefined' || !this.eroEnabled) return;
    if (this.eroBusy) { this.eroWanted = true; return; }
    this.eroBusy = true;
    this.eroWanted = false;
    this.eroWorker ??= this.makeWorker();
    const id = ++this.eroId, half = new Uint16Array(SIZE * SIZE * 4);
    const frame = { c: c.toArray(), e: e.toArray(), nn: n.toArray(), r };
    renderer.readRenderTargetPixelsAsync(this.height, 0, 0, SIZE, SIZE, half).then(() => {
      const req: EroRequest = { id, half, size: SIZE, ...frame };
      this.eroWorker!.postMessage(req, [half.buffer]);
    }).catch(() => { this.eroBusy = false; });
    this.pendingFrame = frame;
  }
  private pendingFrame: { c: number[]; e: number[]; nn: number[]; r: number } | null = null;
  private makeWorker(): Worker {
    const w = new Worker(new URL('./eroworker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<EroResult>) => {
      this.eroBusy = false;
      const { id, n, packed } = ev.data;
      if (id === this.eroId && this.pendingFrame) {
        if (!this.eroTex || this.eroTex.image.width !== n) {
          this.eroTex?.dispose();
          this.eroTex = new THREE.DataTexture(packed, n, n, THREE.RGFormat, THREE.HalfFloatType);
          this.eroTex.minFilter = this.eroTex.magFilter = THREE.LinearFilter;
          this.u.uEroMap.value = this.eroTex;
        } else {
          (this.eroTex.image.data as Uint16Array).set(packed);
        }
        this.eroTex.needsUpdate = true;
        const f = this.pendingFrame;
        this.u.uEroC.value.fromArray(f.c); this.u.uEroE.value.fromArray(f.e); this.u.uEroN.value.fromArray(f.nn);
        this.u.uEroR.value = f.r;
        // Fade in the first; later ones (the region moved on a little) swap straight in.
        if (this.u.uEroOn.value < 1) this.eroFadeStart = performance.now();
        this.needCast = true;
      }
      if (this.eroWanted) this.heightDirty = true;   // the view moved on meanwhile: go again
    };
    return w;
  }

  /**
   * Other things whose shape should cast shadows (the high-detail patch), drawn into the height
   * map with their own material's vertex code: a mesh whose material has a height variant.
   */
  setExtras(objs: THREE.Object3D[]) {
    for (const o of this.extras) this.heightScene.remove(o);
    this.extras = objs;
    for (const o of objs) this.heightScene.add(o);
    this.heightDirty = true;
  }
  /** Rivers, then streams (fainter), for the water map. */
  setRivers(rivers: THREE.Mesh | undefined, streams: THREE.Mesh | undefined) {
    this.riverScene.clear();
    [rivers, streams].forEach((m, k) => {
      if (!m) return;
      const copy = new THREE.Mesh(m.geometry, this.riverMats[k]);
      copy.matrixAutoUpdate = false;
      copy.frustumCulled = false;
      m.updateWorldMatrix(true, false);
      copy.matrix.copy(m.matrixWorld);
      copy.matrixWorld.copy(m.matrixWorld);
      this.riverScene.add(copy);
    });
    this.heightDirty = true;
  }

  /** Compile the shadow passes' shaders in the background (they first run on the way down). */
  prewarm(renderer: THREE.WebGLRenderer): Promise<unknown> {
    const prev = renderer.getRenderTarget();
    const jobs: Promise<unknown>[] = [];
    if (this.source) { this.terrainCopy.geometry = this.source.geometry; this.terrainCopy.material = this.heightMat; }
    renderer.setRenderTarget(this.height);
    jobs.push(renderer.compileAsync(this.heightScene, this.cam));
    renderer.setRenderTarget(this.riverRaw);
    jobs.push(renderer.compileAsync(this.riverScene, this.cam));
    renderer.setRenderTarget(this.riverTmp);
    jobs.push(renderer.compileAsync(this.blurScene, this.quadCam));
    renderer.setRenderTarget(this.shadow);
    jobs.push(renderer.compileAsync(this.quadScene, this.quadCam));
    renderer.setRenderTarget(prev);
    return Promise.all(jobs);
  }

  /** Something casting shadows changed shape (the patch recentred). */
  invalidate() { this.heightDirty = true; }

  /**
   * Each frame. centre: direction of the middle of the view; dist: camera distance from the
   * planet's centre; sun: direction to the sun (world).
   */
  update(renderer: THREE.WebGLRenderer, centre: THREE.Vector3, dist: number, sun: THREE.Vector3, active: boolean) {
    const on = active && !!this.source && dist < 2.4;
    this.u.uShOn.value = on ? 1 : 0;
    if (!on) return;
    // Region half-width: a little past the horizon when low, wider from high up; in steps.
    const alt = Math.max(0.002, dist - 1);
    const want = Math.min(0.7, Math.max(1.3 * alt, 0.8 * Math.sqrt(2 * alt)));
    const r = 0.04 * Math.pow(1.25, Math.round(Math.log(want / 0.04) / Math.log(1.25)));
    const c = centre.clone().normalize();
    if (this.heightDirty || r !== this.radius || c.angleTo(this.centre) > r * 0.15) this.captureHeight(renderer, c, r);
    // A new erosion result fades in over half a second (the shadows follow it).
    if (this.eroFadeStart > 0) {
      const k = Math.min(1, (performance.now() - this.eroFadeStart) / 500);
      this.u.uEroOn.value = k;
      if (k >= 1) this.eroFadeStart = 0;
      this.needCast = true;
    }
    if (this.heightDirty || this.needCast || sun.dot(this.lastSun) < Math.cos(0.0015)) this.castShadows(renderer, sun);
    this.heightDirty = false;
    this.needCast = false;
  }

  private captureHeight(renderer: THREE.WebGLRenderer, c: THREE.Vector3, r: number) {
    this.centre.copy(c);
    this.radius = r;
    let e = new THREE.Vector3(c.z, 0, -c.x);
    if (e.lengthSq() < 1e-8) e = new THREE.Vector3(1, 0, 0);
    e.normalize();
    const n = new THREE.Vector3().crossVectors(c, e);
    this.u.uShC.value.copy(c); this.u.uShE.value.copy(e); this.u.uShN.value.copy(n);
    this.u.uShR.value = r;
    this.shadowMat.uniforms.uR.value = r;
    const cam = this.cam;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.position.copy(c).multiplyScalar(1.1);
    cam.up.copy(n);
    cam.lookAt(0, 0, 0);
    cam.far = 1.1;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const src = this.source!;
    src.updateWorldMatrix(true, false);
    this.terrainCopy.geometry = src.geometry;
    this.terrainCopy.material = this.heightMat;
    this.terrainCopy.matrix.copy(src.matrixWorld);
    this.terrainCopy.matrixWorld.copy(src.matrixWorld);
    const prev = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.height);
    renderer.clear();
    renderer.render(this.heightScene, cam);
    this.startErosion(renderer, c, e, n, r);
    // The water map: rivers from above, blurred across then down. Widths in radians: ~5 km for
    // the strip along the water, ~25 km for the valley floor (on an Earth-sized world).
    renderer.setRenderTarget(this.riverRaw);
    renderer.clear();
    renderer.render(this.riverScene, cam);
    const texel = (2 * r) / 512, b = this.blurMat.uniforms;
    b.uNear.value = Math.max(1, 0.0014 / texel) / 512;
    b.uWide.value = Math.max(1, 0.004 / texel) / 512;
    b.uCoast.value = Math.max(0.7, 0.0005 / texel) / 512;
    b.uSeaWide.value = Math.max(1, 0.006 / texel) / 512;
    b.uSrc.value = this.riverRaw.texture; b.uDir.value.set(1, 0); b.uFirst.value = 1;
    renderer.setRenderTarget(this.riverTmp);
    renderer.render(this.blurScene, this.quadCam);
    b.uSrc.value = this.riverTmp.texture; b.uDir.value.set(0, 1); b.uFirst.value = 0;
    renderer.setRenderTarget(this.riverMap);
    renderer.render(this.blurScene, this.quadCam);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  private castShadows(renderer: THREE.WebGLRenderer, sun: THREE.Vector3) {
    this.lastSun.copy(sun);
    (this.shadowMat.uniforms.uSun.value as THREE.Vector3).copy(sun).normalize();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadow);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
  }

  /** The height map's material for a mesh whose vertices are placed by its own code. */
  static heightMaterial(vertexHead: string, vertexBody: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `${vertexHead}
        varying float vH;
        void main() {
          ${vertexBody}
          vec4 w = modelMatrix * vec4(transformed, 1.0);
          vH = length(w.xyz) - 1.0;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: heightFragment,
    });
  }

  dispose() {
    this.height.dispose(); this.shadow.dispose();
    this.riverRaw.dispose(); this.riverTmp.dispose(); this.riverMap.dispose(); this.blurMat.dispose();
    for (const m of this.riverMats) m.dispose();
    this.heightMat.dispose(); this.shadowMat.dispose();
  }
}
