/**
 * Physically based sky and atmosphere, after Hillaire 2020 ("A Scalable and Production Ready
 * Sky and Atmosphere Rendering Technique"), with Bruneton & Neyret's transmittance mapping.
 *
 * Air scatters light: small molecules (Rayleigh) scatter blue far more than red, which makes the
 * sky blue and the sun red when its light crosses a lot of air; dust and droplets (Mie) scatter
 * all colours, mostly forward, which makes the glow round the sun and the pale haze over
 * distance; ozone absorbs a little red and orange. Lookup tables, worked out on the GPU:
 *
 *   transmittance (256x64, once): how much sunlight survives from a height to space, by angle;
 *   multiple scattering (32x32, once): light scattered more than once, which brightens and
 *     softens the sky (Hillaire's approximation);
 *   aerial perspective (32x32x32, every frame): for points in the camera's view, at depths
 *     out to the far side of the atmosphere, the light the air adds in front of them and how
 *     much of them shows through. Materials read it in one lookup (aerialApply).
 *
 * The sky itself (wherever no geometry is drawn) is ray-marched per pixel, including from orbit,
 * where it becomes the planet's thin blue limb.
 *
 * Earth's atmosphere scaled to Mundi's vertical exaggeration (~7x, as for the relief): scale
 * heights 7x Earth's proportion, so low views sit in thick air and clouds and peaks in thinner
 * air, as they should; scattering coefficients divided by the same factor, keeping the vertical
 * optical depth of Earth's air. The top is cut at 1.07 radii (eight scale heights up).
 *
 * Depth slices of the aerial-perspective table start where each ray enters the air: from orbit
 * all the air is in the last sliver before the ground, and slices spread from the camera jumped
 * across it in visible rings.
 */
import * as THREE from 'three';

const SCALE = 7;
const KM = SCALE / 6360;                     // one km of Earth's atmosphere, in planet radii
const PER_M = 6.36e6 / SCALE;                // per metre -> per planet radius, scaled
const v3 = (x: number, y: number, z: number) => `vec3(${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`;

/** The medium and the lookups, shared by every program that uses the atmosphere. */
export const ATMO_GLSL = /* glsl */`
  const float AT_RG = 1.0;
  const float AT_RT = 1.07;
  const vec3 AT_RAY = ${v3(5.802e-6 * PER_M, 13.558e-6 * PER_M, 33.1e-6 * PER_M)};
  const float AT_HR = ${(8 * KM).toFixed(6)};
  const float AT_MIE_S = ${(0.5 * 3.996e-6 * PER_M).toFixed(3)};
  const float AT_MIE_E = ${(0.5 * 4.44e-6 * PER_M).toFixed(3)};
  const float AT_HM = ${(1.2 * KM).toFixed(6)};
  const vec3 AT_OZONE = ${v3(0.65e-6 * PER_M, 1.881e-6 * PER_M, 0.085e-6 * PER_M)};
  const float AT_OZ_C = ${(25 * KM).toFixed(6)};
  const float AT_OZ_W = ${(15 * KM).toFixed(6)};
  const float AT_PI = 3.14159265;

  vec2 atSphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }
  /** Scattering by molecules (rgb) and particles (a), and extinction, at height h. */
  void atMedium(float h, out vec3 ray, out float mie, out vec3 ext) {
    h = max(h, 0.0);
    float dr = exp(-h / AT_HR), dm = exp(-h / AT_HM);
    float oz = max(0.0, 1.0 - abs(h - AT_OZ_C) / AT_OZ_W);
    ray = AT_RAY * dr;
    mie = AT_MIE_S * dm;
    ext = ray + vec3(AT_MIE_E * dm) + AT_OZONE * oz;
  }
  float atPhaseR(float c) { return 3.0 / (16.0 * AT_PI) * (1.0 + c * c); }
  float atPhaseM(float c) {
    const float g = 0.8;
    float k = 3.0 / (8.0 * AT_PI) * (1.0 - g * g) / (2.0 + g * g);
    return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  }
  // Transmittance LUT coordinates (Bruneton): height and distance to the top along mu.
  vec2 atTransUv(float r, float mu) {
    float H = sqrt(AT_RT * AT_RT - AT_RG * AT_RG);
    float rho = sqrt(max(r * r - AT_RG * AT_RG, 0.0));
    float d = max(0.0, -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + AT_RT * AT_RT, 0.0)));
    float dmin = AT_RT - r, dmax = rho + H;
    return vec2((d - dmin) / max(dmax - dmin, 1e-6), rho / H);
  }
`;

/** Lookups for programs that only read the precomputed tables. */
export const ATMO_LUT_GLSL = ATMO_GLSL + /* glsl */`
  uniform sampler2D uAtTrans, uAtMulti;
  vec3 atTrans(float r, float mu) { return texture(uAtTrans, atTransUv(min(r, AT_RT), mu)).rgb; }
  /** Sunlight reaching point p (planet's shadow included, a little soft). */
  vec3 atSunTrans(vec3 p, vec3 sun) {
    float r = max(length(p), AT_RG + 1e-5), mu = dot(p, sun) / r;
    float muH = -sqrt(max(0.0, 1.0 - AT_RG * AT_RG / (r * r)));
    return atTrans(r, mu) * smoothstep(muH - 0.004, muH + 0.006, mu);
  }
  vec3 atMulti(float r, float muS) {
    return texture(uAtMulti, vec2(muS * 0.5 + 0.5, clamp((r - AT_RG) / (AT_RT - AT_RG), 0.0, 1.0))).rgb;
  }
  /**
   * Ray-march light scattered toward ro along rd, over [t0, t1]. Returns in-scattered light (rgb,
   * for sun illuminance 1) and mean transmittance (a).
   */
  vec4 atMarch(vec3 ro, vec3 rd, float t0, float t1, vec3 sun, int steps) {
    vec3 L = vec3(0.0), T = vec3(1.0);
    float c = dot(rd, sun), pR = atPhaseR(c), pM = atPhaseM(c);
    float dt = (t1 - t0) / float(steps);
    for (int i = 0; i < 64; i++) {
      if (i >= steps) break;
      float t = t0 + (float(i) + 0.5) * dt;
      vec3 p = ro + rd * t;
      float r = length(p);
      vec3 ray, ext; float mie;
      atMedium(r - AT_RG, ray, mie, ext);
      vec3 sunT = atSunTrans(p, sun);
      vec3 ms = atMulti(r, dot(p, sun) / r);
      vec3 S = (ray * pR + mie * pM) * sunT + (ray + mie) * ms;
      vec3 sT = exp(-ext * dt);
      L += T * (S - S * sT) / max(ext, vec3(1e-6));
      T *= sT;
    }
    return vec4(L, dot(T, vec3(1.0 / 3.0)));
  }
`;

/** For materials: aerialApply(colour, distance) and atmoSunTint(world point). */
export const AERIAL_GLSL = /* glsl */`
  uniform sampler3D uAtAP;
  uniform sampler2D uAtTrans;
  uniform vec2 uAtScreen;
  uniform float uAtMax, uAtOn, uAtE;
  uniform vec3 uAtSun;
  /** c: lit colour; v: the point relative to the camera, view space. */
  vec3 aerialApply(vec3 c, vec3 v) {
    if (uAtOn < 0.5) return c;
    vec2 uv = gl_FragCoord.xy / uAtScreen;
    vec3 rd = (vec4(v, 0.0) * viewMatrix).xyz;
    float dist = length(rd);
    rd /= max(dist, 1e-9);
    // Where this ray enters the air.
    float b = dot(cameraPosition, rd), cc = dot(cameraPosition, cameraPosition) - 1.07 * 1.07, dd = b * b - cc;
    float tIn = dd > 0.0 ? max(-b - sqrt(dd), 0.0) : 0.0;
    float s = sqrt(clamp((dist - tIn) / uAtMax, 0.0, 1.0));
    vec4 ap = texture(uAtAP, vec3(uv, s - 0.5 / 32.0));
    float w = clamp(s * 32.0, 0.0, 1.0);
    return c * mix(1.0, ap.a, w) + ap.rgb * w * uAtE;
  }
  vec3 atmoSunTint(vec3 p) {
    if (uAtOn < 0.5) return vec3(1.0);
    float r = max(length(p), 1.00001), mu = dot(p, uAtSun) / r;
    float muH = -sqrt(max(0.0, 1.0 - 1.0 / (r * r)));
    float H = sqrt(1.07 * 1.07 - 1.0);
    // Relative to the noon sun at sea level, so daytime colours stay as they were.
    vec3 t = texture(uAtTrans, atTUv(min(r, 1.07), mu, H)).rgb;
    vec3 z = texture(uAtTrans, atTUv(1.00001, 1.0, H)).rgb;
    return min(t / max(z, vec3(1e-4)), vec3(1.15)) * smoothstep(muH - 0.004, muH + 0.006, mu);
  }
`;
// atTUv: a copy of atTransUv for materials (which don't include the full ATMO_GLSL).
const AT_TUV = /* glsl */`
  vec2 atTUv(float r, float mu, float H) {
    float RT = 1.07;
    float rho = sqrt(max(r * r - 1.0, 0.0));
    float d = max(0.0, -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + RT * RT, 0.0)));
    float dmin = RT - r, dmax = rho + H;
    return vec2((d - dmin) / max(dmax - dmin, 1e-6), rho / H);
  }
`;
export const AERIAL_FULL_GLSL = AT_TUV + AERIAL_GLSL;

const transFrag = ATMO_GLSL + /* glsl */`
  varying vec2 vUv;
  void main() {
    float H = sqrt(AT_RT * AT_RT - AT_RG * AT_RG);
    float rho = H * vUv.y, r = sqrt(rho * rho + AT_RG * AT_RG);
    float dmin = AT_RT - r, dmax = rho + H, d = dmin + vUv.x * (dmax - dmin);
    float mu = d < 1e-7 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
    vec3 ro = vec3(0.0, r, 0.0), rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
    float t1 = atSphere(ro, rd, AT_RT).y, dt = t1 / 40.0;
    vec3 od = vec3(0.0);
    for (int i = 0; i < 40; i++) {
      vec3 p = ro + rd * (float(i) + 0.5) * dt;
      vec3 ray, ext; float mie;
      atMedium(length(p) - AT_RG, ray, mie, ext);
      od += ext * dt;
    }
    gl_FragColor = vec4(exp(-od), 1.0);
  }`;

const multiFrag = ATMO_GLSL + /* glsl */`
  uniform sampler2D uAtTrans;
  varying vec2 vUv;
  vec3 tr(vec3 p, vec3 sun) {
    float r = length(p), mu = dot(p, sun) / r;
    float muH = -sqrt(max(0.0, 1.0 - AT_RG * AT_RG / (r * r)));
    return mu < muH ? vec3(0.0) : texture(uAtTrans, atTransUv(min(r, AT_RT), mu)).rgb;
  }
  void main() {
    float muS = vUv.x * 2.0 - 1.0, r = AT_RG + vUv.y * (AT_RT - AT_RG) + 1e-5;
    vec3 ro = vec3(0.0, r, 0.0), sun = vec3(0.0, muS, sqrt(max(0.0, 1.0 - muS * muS)));
    vec3 L2 = vec3(0.0), F = vec3(0.0);
    const int N = 8;
    for (int a = 0; a < N; a++) for (int b = 0; b < N; b++) {
      // Uniform directions on the sphere.
      float z = 1.0 - 2.0 * (float(a) + 0.5) / float(N), phi = 2.0 * AT_PI * (float(b) + 0.5) / float(N);
      vec3 rd = vec3(sqrt(1.0 - z * z) * cos(phi), z, sqrt(1.0 - z * z) * sin(phi));
      vec2 top = atSphere(ro, rd, AT_RT), gr = atSphere(ro, rd, AT_RG);
      float t1 = gr.x > 0.0 ? gr.x : top.y, dt = t1 / 20.0;
      vec3 T = vec3(1.0), L = vec3(0.0), f = vec3(0.0);
      for (int i = 0; i < 20; i++) {
        vec3 p = ro + rd * (float(i) + 0.5) * dt;
        vec3 ray, ext; float mie;
        atMedium(length(p) - AT_RG, ray, mie, ext);
        vec3 s = ray + mie, sT = exp(-ext * dt);
        vec3 S = s * tr(p, sun) / (4.0 * AT_PI);
        L += T * (S - S * sT) / max(ext, vec3(1e-6));
        f += T * (s - s * sT) / max(ext, vec3(1e-6));
        T *= sT;
      }
      // Light bounced off the ground (albedo 0.3).
      if (gr.x > 0.0) {
        vec3 g = ro + rd * gr.x;
        L += T * tr(g, sun) * max(dot(normalize(g), sun), 0.0) * 0.3 / AT_PI;
      }
      L2 += L; F += f;
    }
    L2 /= float(N * N); F /= float(N * N);
    gl_FragColor = vec4(L2 / max(vec3(1.0) - F, vec3(1e-3)), 1.0);
  }`;

const skyFrag = ATMO_LUT_GLSL + /* glsl */`
  uniform mat4 uInvProj, uCamWorld;
  uniform vec3 uSun;
  uniform float uE;
  varying vec2 vNdc;
  void main() {
    vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz), ro = cameraPosition;
    vec2 top = atSphere(ro, rd, AT_RT);
    vec3 L = vec3(0.0);
    float T = 1.0;
    if (top.y > 0.0) {
      vec2 gr = atSphere(ro, rd, AT_RG);
      float t0 = max(top.x, 0.0), t1 = gr.x > 0.0 ? gr.x : top.y;
      vec4 m = atMarch(ro, rd, t0, t1, uSun, 32);
      L = m.rgb; T = m.a;
      // The sun's disc (enlarged, like everything here) where nothing is in front of it.
      if (gr.x < 0.0) L += atTrans(min(length(ro), AT_RT), dot(normalize(ro), rd)) * smoothstep(0.9993, 0.9996, dot(rd, uSun)) * 40.0;
    } else {
      L += smoothstep(0.9993, 0.9996, dot(rd, uSun)) * vec3(40.0);
    }
    L *= uE;
    // Stars show through clear, dark sky only.
    float lum = dot(L, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(L, T * (1.0 - smoothstep(0.0, 0.04, lum)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const apFrag = ATMO_LUT_GLSL + /* glsl */`
  uniform mat4 uInvProj, uCamWorld;
  uniform vec3 uSun, uCam;
  uniform float uMax, uSlice;
  varying vec2 vUv;
  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
    vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz), ro = uCam;
    vec2 top = atSphere(ro, rd, AT_RT);
    if (top.y <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float t0 = max(top.x, 0.0);
    float t1 = min(top.y, t0 + uMax * pow((uSlice + 1.0) / 32.0, 2.0));
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    gl_FragColor = atMarch(ro, rd, t0, t1, uSun, 12);
  }`;

const quadVert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

export interface AtmoUniforms {
  uAtAP: { value: THREE.Texture | null };
  uAtTrans: { value: THREE.Texture | null };
  uAtScreen: { value: THREE.Vector2 };
  uAtMax: { value: number };
  uAtOn: { value: number };
  uAtE: { value: number };
  uAtSun: { value: THREE.Vector3 };
}
/** One set for every material that receives the atmosphere. */
export const atmoUniforms: AtmoUniforms = {
  uAtAP: { value: null }, uAtTrans: { value: null }, uAtScreen: { value: new THREE.Vector2(1, 1) },
  uAtMax: { value: 1 }, uAtOn: { value: 0 }, uAtE: { value: 4 }, uAtSun: { value: new THREE.Vector3(0, 0, 1) },
};

/**
 * Give a three.js built-in material (one with vViewPosition) the atmosphere: aerial perspective
 * after lighting, and, if tint, sunlight reddened by the air it crossed.
 */
export function applyAerial(mat: THREE.Material, tint: boolean) {
  const prev = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, atmoUniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${AERIAL_FULL_GLSL}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        gl_FragColor.rgb = aerialApply(gl_FragColor.rgb, -vViewPosition);`);
    if (tint) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin);
      sh.fragmentShader = sh.fragmentShader.replace('getDirectionalLightInfo( directionalLight, directLight );',
        `getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= atmoSunTint(cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz);`);
    }
  };
  mat.customProgramCacheKey = () => (key ? key() : '') + '|aerial' + (tint ? 't' : '');
  mat.needsUpdate = true;
}

export class Atmosphere {
  readonly sky: THREE.Mesh;
  private trans = new THREE.WebGLRenderTarget(256, 64, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  private multi = new THREE.WebGLRenderTarget(32, 32, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private ap = new THREE.WebGL3DRenderTarget(32, 32, 32, { type: THREE.HalfFloatType, depthBuffer: false });
  private quadScene = new THREE.Scene();
  private quad: THREE.Mesh;
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private apMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  private ready = false;
  private u = atmoUniforms;

  constructor() {
    this.ap.texture.minFilter = this.ap.texture.magFilter = THREE.LinearFilter;
    this.ap.texture.wrapS = this.ap.texture.wrapT = this.ap.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.u.uAtTrans.value = this.trans.texture;
    this.u.uAtAP.value = this.ap.texture;
    const lut = { uAtTrans: { value: this.trans.texture }, uAtMulti: { value: this.multi.texture } };
    this.apMat = new THREE.ShaderMaterial({
      uniforms: { ...lut, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uSun: this.u.uAtSun, uCam: { value: new THREE.Vector3() }, uMax: this.u.uAtMax, uSlice: { value: 0 } },
      vertexShader: quadVert, fragmentShader: apFrag, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.apMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    // The sky: a full-screen triangle at the far plane, drawn after the opaque scene, so only
    // pixels nothing covered run it; it adds its light and dims what's behind (stars).
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { ...lut, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uSun: this.u.uAtSun, uE: this.u.uAtE },
      vertexShader: 'varying vec2 vNdc; void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: skyFrag,
      depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.sky = new THREE.Mesh(tri, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1000;
    this.sky.visible = false;
  }

  // The one-off tables' programs, kept (not disposed) so a background compile of them sticks.
  private transMat = new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: transFrag, depthTest: false, depthWrite: false });
  private multiMat = new THREE.ShaderMaterial({ uniforms: { uAtTrans: { value: null } }, vertexShader: quadVert, fragmentShader: multiFrag, depthTest: false, depthWrite: false });

  private precompute(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    this.multiMat.uniforms.uAtTrans.value = this.trans.texture;
    for (const [m, target] of [[this.transMat, this.trans], [this.multiMat, this.multi]] as const) {
      this.quad.material = m;
      renderer.setRenderTarget(target);
      renderer.render(this.quadScene, this.quadCam);
    }
    this.quad.material = this.apMat;
    renderer.setRenderTarget(prev);
    this.ready = true;
  }

  /** Compile the passes' shaders in the background (each against the target it draws into). */
  /** The passes' shaders have been compiled once (they're cached from then on). */
  warmed = false;
  prewarm(renderer: THREE.WebGLRenderer): Promise<unknown> {
    if (this.warmed) return Promise.resolve();
    const prev = renderer.getRenderTarget(), jobs: Promise<unknown>[] = [];
    const mats: [THREE.Material, THREE.WebGLRenderTarget | THREE.WebGL3DRenderTarget][] = [[this.transMat, this.trans], [this.multiMat, this.multi], [this.apMat, this.ap]];
    for (const [m, target] of mats) {
      const scene = new THREE.Scene(), q = new THREE.Mesh(this.quad.geometry, m);
      q.frustumCulled = false;
      scene.add(q);
      renderer.setRenderTarget(target as THREE.WebGLRenderTarget);
      jobs.push(renderer.compileAsync(scene, this.quadCam));
    }
    renderer.setRenderTarget(prev);
    return Promise.all(jobs).then(() => { this.warmed = true; });
  }

  /** Each frame, after the camera is placed, before rendering. on: the new atmosphere is in use. */
  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sun: THREE.Vector3, on: boolean) {
    this.u.uAtOn.value = on ? 1 : 0;
    this.sky.visible = on;
    if (!on) return;
    if (!this.ready) this.precompute(renderer);
    camera.updateMatrixWorld();
    this.u.uAtSun.value.copy(sun).normalize();
    renderer.getDrawingBufferSize(this.u.uAtScreen.value);
    // Depth covered past the point a ray enters the air: the longest path through it that ends
    // on the ground or leaves again (a grazing ray, horizon to horizon).
    this.u.uAtMax.value = 2 * Math.sqrt(1.07 * 1.07 - 1);
    for (const m of [this.apMat, this.skyMat]) {
      m.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      m.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    }
    this.apMat.uniforms.uCam.value.copy(camera.position);
    const prev = renderer.getRenderTarget();
    for (let k = 0; k < 32; k++) {
      this.apMat.uniforms.uSlice.value = k;
      renderer.setRenderTarget(this.ap, k);
      renderer.render(this.quadScene, this.quadCam);
    }
    renderer.setRenderTarget(prev);
  }
}
