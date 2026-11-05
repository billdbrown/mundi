/**
 * The hex view: one planet hex opened up as a walkable local map (hex.html). Opened from the
 * planet by double-clicking a hex. The generator (hexlocal.ts) lays out the ground from the
 * planet; a style (hexstyle.ts, keys 1–5) decides how it is drawn.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GRADE_SHADER } from './grade.ts';
import { Atmosphere, applyAerial } from './atmosphere.ts';
import { treeGeometry, treeMaterial, TUFT } from './flora.ts';
import { FIRST, FAMILIES, VARIANTS } from './species.ts';
import { DEFAULT_PARAMS, type WorldParams } from './world.ts';
import { parseSeed } from './seedname.ts';
import { LOCAL_DEFAULTS, localHeights, LAYERS, L_DEPTH, L_FOREST, HOUSE_STRIDE, type LocalMap, type LocalOptions } from './hexlocal.ts';
import { STYLE, paintGround, STYLE_GRADE, TILT_SHIFT, type HexStyle } from './hexstyle.ts';
import { daylight, hourForElevation, type RGB } from './daylight.ts';
import type { HexJob, ValleyJob } from './hexworker.ts';
import type { Spot } from './debug.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// --- What to build, from the link: the world's settings, the cell, the options and the style. ---
const h = new URLSearchParams(location.hash.slice(1));
const params: WorldParams = { ...DEFAULT_PARAMS };
const s = parseSeed(h.get('seed') ?? '');
if (s) params.seed = s.seed;
for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
  const v = h.get(k);
  if (k !== 'seed' && v !== null && v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
}
let cell = Number(h.get('cell') ?? -1);
const spot = (h.get('spot') ?? undefined) as Spot | undefined;
let opts: LocalOptions = { ...LOCAL_DEFAULTS, radiusKm: Number(h.get('radius')) || LOCAL_DEFAULTS.radiusKm };
for (const k of ['mag', 'vScale', 'vSoft', 'res'] as const) if (h.get(k)) opts[k] = Number(h.get(k));
if (h.get('river') === 'scaled' || h.get('river') === 'flow') opts.riverMode = h.get('river') as LocalOptions['riverMode'];
if (h.get('crags')) opts.crags = h.get('crags') === '1';
// One look: Golden Earth (hexstyle.ts), Bill's pick of six on 2026-11-04.
const style: HexStyle = STYLE;
let tiltOn = h.get('tilt') === null ? style.tiltShift : h.get('tilt') === '1';
/** The hour of local solar time, once Bill has set one; until then each style's own hour. */
let userHour: number | null = h.get('time') !== null && h.get('time') !== '' ? ((Number(h.get('time')) % 24) + 24) % 24 : null;
let playing = false;
/** The neighbouring hexes, drawn blurred behind the tile (N, or the panel). */
let showCtx = h.get('around') !== '0';
const back = new URLSearchParams(h);
for (const k of ['cell', 'spot', 'v', 'mag', 'vScale', 'vSoft', 'res', 'river', 'crags', 'style', 'tilt', 'time', 'around']) back.delete(k);
$<HTMLAnchorElement>('back').href = '/#' + back.toString();
/** Inside the planet page (main.ts): the planet stays loaded underneath, so "← planet" just
 * uncovers it, and new hexes arrive by message instead of by loading this page again. */
const embedded = h.get('embed') === '1';
if (embedded) {
  $<HTMLAnchorElement>('back').onclick = (e) => { e.preventDefault(); goBack(); };
  for (const a of document.querySelectorAll<HTMLAnchorElement>('#panel a[href="/hexes.html"]')) a.target = '_top';
}
function goBack() { parent.postMessage({ type: 'mundi-hex-back' }, location.origin); }
/** Read a planet link (world settings, radius, cell) into the current state. */
function applyHash(hash: string) {
  const q = new URLSearchParams(hash);
  const sd = parseSeed(q.get('seed') ?? '');
  if (sd) params.seed = sd.seed;
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = q.get(k);
    if (k !== 'seed' && v !== null && v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  opts.radiusKm = Number(q.get('radius')) || LOCAL_DEFAULTS.radiusKm;
  cell = Number(q.get('cell') ?? -1);
  for (const k of [...back.keys()]) back.delete(k);
  for (const [k, v] of q) if (!['cell', 'spot', 'v', 'mag', 'vScale', 'vSoft', 'res', 'river', 'crags', 'style', 'tilt', 'time', 'around'].includes(k)) back.set(k, v);
}

// --- Scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xffffff, 0);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 50000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
const walker = new PointerLockControls(camera, document.body);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
const rim = new THREE.DirectionalLight(0xdfe8ff, 0);
scene.add(hemi, sun, sun.target, rim, rim.target);
// Lights reach layer 1 too, where the backdrop of neighbouring hexes is drawn.
for (const l of [hemi, sun, rim]) l.layers.enableAll();

// The planet's atmosphere, for the Earth style: the map is put back on the planet (planet radii,
// true size) and drawn through a camera that mirrors the orbit camera, so the planet's own sky,
// haze and reddened sunlight apply. Every material carries it; it is off in the other styles.
const atmo = new Atmosphere();
scene.add(atmo.sky);
atmo.sky.layers.enableAll();
applyAerial(treeMaterial, true);
const planetCam = new THREE.PerspectiveCamera(50, 1, 1e-6, 1);
/** Map metres to planet radii, for the current map (identity until a map is in). */
const toPlanet = new THREE.Matrix4(), toPlanetRot = new THREE.Quaternion();
let planetScale = 1;
const sunDir = new THREE.Vector3(), sunOrigin = new THREE.Vector3();

// Post: render, grade (the style's, or the planet's photo grade), tilt-shift, tone map and encode.
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const photoPass = new ShaderPass(GRADE_SHADER);
const gradePass = new ShaderPass(STYLE_GRADE);
const tiltH = new ShaderPass(TILT_SHIFT), tiltV = new ShaderPass(TILT_SHIFT);
tiltV.uniforms.uDir.value = [0, 1];
composer.addPass(photoPass); composer.addPass(gradePass); composer.addPass(tiltH); composer.addPass(tiltV);
composer.addPass(new OutputPass());
// The backdrop: the neighbouring ground drawn alone (layer 1) at half size, blurred, and set
// behind the tile as the background, so the tile stays sharp in a soft world.
const ctxRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const blurRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const blurMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
    void main() {
      vec4 s = vec4(0.0); float ws = 0.0;
      for (int k = -8; k <= 8; k++) { float w = exp(-float(k * k) / 32.0); s += texture2D(tSrc, vUv + uDir * float(k)) * w; ws += w; }
      gl_FragColor = s / ws;
    }`,
  depthTest: false, depthWrite: false,
});
const blurQuad = new FullScreenQuad(blurMat);
function resize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  const half = (v: number) => Math.max(1, Math.round(v * renderer.getPixelRatio() / 2));
  ctxRT.setSize(half(innerWidth), half(innerHeight)); blurRT.setSize(half(innerWidth), half(innerHeight));
  const pr = renderer.getPixelRatio();
  tiltH.uniforms.uRes.value = tiltV.uniforms.uRes.value = [innerWidth * pr, innerHeight * pr];
}
addEventListener('resize', resize);
resize();

let map: LocalMap | null = null;
let world = new THREE.Group();
scene.add(world);
let outline: THREE.Line | null = null;

/** Ground height under (x, y) in map metres (y north). */
function groundAtMap(m: LocalMap, x: number, y: number): number {
  const { res, size, heights } = m, step = size / (res - 1), half = size / 2;
  const fi = Math.max(0, Math.min(res - 1.001, (x + half) / step)), fj = Math.max(0, Math.min(res - 1.001, (y + half) / step));
  const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0;
  const a = heights[j0 * res + i0], b = heights[j0 * res + i0 + 1], c = heights[(j0 + 1) * res + i0], d = heights[(j0 + 1) * res + i0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
const groundAt = (x: number, y: number) => (map ? groundAtMap(map, x, y) : 0);
const waterAt = (x: number, y: number) => Math.max(map?.sea ? 0 : -Infinity, groundAt(x, y));

function dispose(o: THREE.Object3D) {
  o.traverse((n) => {
    if (n.name === 'plants') { (n as THREE.InstancedMesh).dispose(); return; }   // geometry and material are shared (flora.ts)
    const m = n as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
}

const col = (hex: number) => new THREE.Color(hex);

/** Water that moves: small ripples in the normal (so the light glints) and foam that shimmers. */
const waterTime = { value: 0 };
function animateWater(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWTime = waterTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; uniform float uWTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWP.xz;
          float t = uWTime;
          vec2 g = vec2(
            sin(p.x * 0.11 + p.y * 0.05 + t * 0.9) * 0.6 + sin(p.x * 0.23 - p.y * 0.17 + t * 1.4) * 0.4,
            sin(p.y * 0.1 - p.x * 0.04 - t * 0.8) * 0.6 + sin(p.y * 0.21 + p.x * 0.13 - t * 1.2) * 0.4);
          // Long, gentle swells only: finer, regular waves tiled into a waffle of glints. Faded out
          // when a pixel covers more than about a metre, or from high up even the swells form a grid.
          float near = 1.0 - smoothstep(0.5, 1.5, length(fwidth(p)));
          normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz * 0.035 * near);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Foam (the palest vertex colours) breathes in and out.
          float foam = smoothstep(0.55, 0.85, dot(vColor.rgb, vec3(0.33)));
          diffuseColor.rgb *= 1.0 + foam * 0.12 * sin(uWTime * 1.3 + vWP.x * 0.21 + vWP.z * 0.17);
        }`);
  };
  mat.customProgramCacheKey = () => 'hexwater';
}

// Ground textures (CC0, public/assets/hex/CREDITS.md), and each one's mean brightness, so the
// shader can use their grain without shifting the style's colours.
const texMean = { grass: 0.2, ground: 0.2, rock: 0.2 };
const loadTex = (name: keyof typeof texMean) => new THREE.TextureLoader().load(`assets/hex/${name}.jpg`, (t) => {
  const img = t.image as HTMLImageElement, cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d')!;
  g.drawImage(img, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * (d[i] / 255) ** 2.2 + 0.7152 * (d[i + 1] / 255) ** 2.2 + 0.0722 * (d[i + 2] / 255) ** 2.2;
  texMean[name] = sum / 256;
  groundTex.uMeans.value.set(texMean.grass, texMean.ground, texMean.rock);
});
const groundTex = {
  tGrass: { value: loadTex('grass') }, tGround: { value: loadTex('ground') }, tRock: { value: loadTex('rock') },
  uMeans: { value: new THREE.Vector3(0.2, 0.2, 0.2) }, uTexAmt: { value: 0 }, uTexScale: { value: 8 },
};
for (const k of ['tGrass', 'tGround', 'tRock'] as const) {
  const t = groundTex[k].value;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
}
/** The terrain material with the ground textures' grain: grass, soil in patches, rock on steep ground. */
function texturedGround(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, groundTex);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLPos; varying vec3 vLN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLPos = position; vLN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLPos; varying vec3 vLN;
        uniform sampler2D tGrass, tGround, tRock;
        uniform vec3 uMeans;
        uniform float uTexAmt, uTexScale;
        float texL(sampler2D t, vec2 uv) { return dot(texture2D(t, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uTexAmt > 0.0) {
          vec2 uv = vLPos.xz / uTexScale;
          // Two scales, the second turned, so the tiles don't repeat visibly.
          vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.37;
          float g = 0.5 * (texL(tGrass, uv) + texL(tGrass, uv2)) / uMeans.x;
          float d = 0.5 * (texL(tGround, uv * 0.8) + texL(tGround, uv2 * 0.8)) / uMeans.y;
          float r = 0.5 * (texL(tRock, uv * 0.5) + texL(tRock, uv2 * 0.5)) / uMeans.z;
          float soil = smoothstep(0.35, 0.65, texL(tGround, uv * 0.03));
          float steep = 1.0 - smoothstep(0.7, 0.88, normalize(vLN).y);
          float det = mix(mix(g, d, soil * 0.5), r, steep);
          diffuseColor.rgb *= mix(1.0, clamp(det, 0.4, 1.8), uTexAmt);
        }`);
  };
  mat.customProgramCacheKey = () => 'hexground';
}

/** The hex as a convex polygon: inside test and nearest boundary point. */
function hexShape(m: LocalMap) {
  const H = m.hex, n = H.length / 2;
  // Orientation, so "inside" is the same side of every edge as the centre.
  let area = 0;
  for (let k = 0; k < n; k++) area += H[k * 2] * H[((k + 1) % n) * 2 + 1] - H[((k + 1) % n) * 2] * H[k * 2 + 1];
  const sgn = Math.sign(area);
  const inside = (x: number, y: number) => {
    for (let k = 0; k < n; k++) {
      const ax = H[k * 2], ay = H[k * 2 + 1], bx = H[((k + 1) % n) * 2], by = H[((k + 1) % n) * 2 + 1];
      if (sgn * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) < 0) return false;
    }
    return true;
  };
  const nearest = (x: number, y: number): [number, number] => {
    let best: [number, number] = [x, y], bd = Infinity;
    for (let k = 0; k < n; k++) {
      const ax = H[k * 2], ay = H[k * 2 + 1], bx = H[((k + 1) % n) * 2], by = H[((k + 1) % n) * 2 + 1];
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      const px = ax + dx * t, py = ay + dy * t, d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) { bd = d; best = [px, py]; }
    }
    return best;
  };
  return { inside, nearest, H, n };
}

/** Lit windows in the towns, shown from dusk, and a soft glow over each lit house so a town reads
 * from afar; the tile's sides (unlit, dimmed by the hour). */
let windows: THREE.InstancedMesh | null = null;
/** The backdrop map from the worker, and its mesh in the current build. */
let ctxMap: LocalMap | null = null;
let ctxMesh: THREE.Mesh | null = null;

/** The ground around the hex as one coarse mesh on layer 1, in the style's colours, water flat,
 * fading out toward its edge. */
function addContext(aerial: boolean) {
  if (!ctxMap || !map || ctxMap.cell !== map.cell) return;
  if (ctxMesh) { world.remove(ctxMesh); ctxMesh.geometry.dispose(); (ctxMesh.material as THREE.Material).dispose(); ctxMesh = null; }
  const c = ctxMap, st = style, R = c.res, half = c.size / 2, step = c.size / (R - 1), N = R * R;
  const paint = paintGround(c, st);
  const pos = new Float32Array(N * 3), rgba = new Float32Array(N * 4);
  const sh = col(st.water.shallow), dp = col(st.water.deep);
  // No tree models out here, so woods are painted as canopy, or blurred forest reads as bare ground.
  const canopy = col(st.ground === 'palette' ? st.palette.forest : 0x2e4424).multiplyScalar(0.8);
  const edge = half * 0.98;
  // Near the hex the backdrop takes the hex's own ground, so the seam always matches; further out
  // it blends into the wide map (the two agree except where each carved its own river channels).
  let reach = 0;
  for (let k = 0; k < map.hex.length; k += 2) reach = Math.max(reach, Math.hypot(map.hex[k], map.hex[k + 1]));
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const v = j * R + i, x = -half + i * step, y = -half + j * step;
    let hv = c.heights[v], r = paint[v * 3], g = paint[v * 3 + 1], b = paint[v * 3 + 2];
    const own = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y) / reach, 1.05, 1.25);
    if (own > 0) hv += (groundAtMap(map, x, y) - hv) * own;
    const f = Math.min(1, c.layers[v * LAYERS + L_FOREST] * 1.3) * 0.8;
    r += (canopy.r - r) * f; g += (canopy.g - g) * f; b += (canopy.b - b) * f;
    let lvl = c.sea ? 0 : -Infinity;
    if (!Number.isNaN(c.lakeLevel) && c.lakeMask[v] > 0.5) lvl = Math.max(lvl, c.lakeLevel);
    if (hv < lvl) {
      const t = Math.min(1, (lvl - hv) / 30);
      r = sh.r + (dp.r - sh.r) * t; g = sh.g + (dp.g - sh.g) * t; b = sh.b + (dp.b - sh.b) * t;
      hv = lvl;
    }
    pos[v * 3] = x; pos[v * 3 + 1] = hv; pos[v * 3 + 2] = -y;
    rgba[v * 4] = r; rgba[v * 4 + 1] = g; rgba[v * 4 + 2] = b;
    rgba[v * 4 + 3] = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y), edge * 0.6, edge);
  }
  const idx: number[] = [];
  for (let j = 0; j < R - 1; j++) for (let i = 0; i < R - 1; i++) {
    const a = j * R + i, b2 = a + 1, cc = a + R, d = cc + 1;
    idx.push(a, b2, cc, b2, d, cc);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 1 });
  if (aerial) applyAerial(mat, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'context';
  mesh.layers.set(1);
  world.add(mesh);
  ctxMesh = mesh;

  // The occluder: every triangle outside the hex (inside, it would fight the tile's own ground).
  if (ctxOccluder) { world.remove(ctxOccluder); ctxOccluder.geometry.dispose(); (ctxOccluder.material as THREE.Material).dispose(); }
  const shape = hexShape(map), oidx: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    let cx = 0, cy = 0;
    for (let k = 0; k < 3; k++) { cx += pos[idx[t + k] * 3]; cy -= pos[idx[t + k] * 3 + 2]; }
    if (!shape.inside(cx / 3, cy / 3)) oidx.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', geo.getAttribute('position'));
  og.setIndex(oidx);
  ctxOccluder = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ colorWrite: false }));
  ctxOccluder.name = 'occluder';
  ctxOccluder.renderOrder = -1;
  world.add(ctxOccluder);

  // The neighbours' outlines: soft cream ribbons lying on the ground, with a small round marker at
  // each corner, like a board-game map; fading with distance. The hex's own edge is its
  // neighbours' edge too, so it shows as a rim. Shared edges are drawn once.
  if (ctxLines) { world.remove(ctxLines); dispose(ctxLines); }
  const ownAt = (x: number, y: number) => {
    const w = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y) / reach, 1.05, 1.25);
    const hc = groundAtMap(c, x, y);
    return Math.max(c.sea ? 0 : -Infinity, w > 0 ? hc + (groundAtMap(map!, x, y) - hc) * w : hc);
  };
  const lift = 1.5, wR = map.size * 0.005;
  const fade = (x: number, y: number) => 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y), edge * 0.35, edge * 0.75);
  const rp: number[] = [], ruv: number[] = [], rc: number[] = [], ri: number[] = [];
  const seen = new Set<string>(), corners = new Map<string, [number, number]>();
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  for (let i = 0; i < c.cells.length; i++) {
    if (c.cells[i] === map.cell) continue;
    const p0 = c.polyStart[i], p1 = c.polyStart[i + 1];
    for (let p = p0; p < p1; p++) {
      const q = p + 1 < p1 ? p + 1 : p0;
      const ax = c.polyXY[p * 2], ay = c.polyXY[p * 2 + 1], bx = c.polyXY[q * 2], by = c.polyXY[q * 2 + 1];
      if (fade(ax, ay) <= 0 && fade(bx, by) <= 0) continue;
      const ka = key(ax, ay), kb = key(bx, by), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (seen.has(ek)) continue;
      seen.add(ek);
      corners.set(ka, [ax, ay]); corners.set(kb, [bx, by]);
      const len = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / len * wR / 2, ny = (bx - ax) / len * wR / 2;
      const n = Math.max(1, Math.ceil(len / (step * 1.5))), base = rp.length / 3;
      for (let k = 0; k <= n; k++) {
        const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n, f = fade(x, y) * 0.38;
        for (const sd of [-1, 1]) {
          const px = x + nx * sd, py = y + ny * sd;
          rp.push(px, ownAt(px, py) + lift, -py);
          ruv.push(k / n, (sd + 1) / 2);
          rc.push(1, 1, 1, f);
        }
        if (k < n) { const o = base + k * 2; ri.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      }
    }
  }
  const softTex = (radial: boolean) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const gr = radial ? g.createRadialGradient(32, 32, 0, 32, 32, 32) : g.createLinearGradient(0, 0, 0, 64);
    if (radial) { gr.addColorStop(0, '#fff'); gr.addColorStop(0.55, '#fff'); gr.addColorStop(0.75, '#888'); gr.addColorStop(1, '#000'); }
    else { gr.addColorStop(0, '#000'); gr.addColorStop(0.3, '#999'); gr.addColorStop(0.5, '#fff'); gr.addColorStop(0.7, '#999'); gr.addColorStop(1, '#000'); }
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  };
  const overGround = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide };
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
  rg.setAttribute('color', new THREE.Float32BufferAttribute(rc, 4));
  rg.setIndex(ri);
  const ribbons = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xfff0d6, vertexColors: true, alphaMap: softTex(false), ...overGround }));
  // Corner markers: small discs, sized by how far out they are.
  const cl = [...corners.values()].filter(([x, y]) => fade(x, y) > 0.05);
  const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xfff0d6, alphaMap: softTex(true), opacity: 0.6, ...overGround }), Math.max(1, cl.length));
  dots.count = cl.length;
  const dm = new THREE.Matrix4(), dq = new THREE.Quaternion(), dv = new THREE.Vector3(), ds = new THREE.Vector3();
  cl.forEach(([x, y], k) => {
    const r = wR * 1.6 * Math.sqrt(fade(x, y));
    dots.setMatrixAt(k, dm.compose(dv.set(x, ownAt(x, y) + lift * 1.3, -y), dq, ds.set(r, 1, r)));
  });
  ctxLines = new THREE.Group();
  ctxLines.name = 'ctxlines';
  ribbons.name = dots.name = 'ctxlines';
  ctxLines.add(ribbons, dots);
  world.add(ctxLines);
  syncAround();
  if (map) applyTime();
}

/** With the neighbours shown the tile drops its earth sides, so its edge meets the ground around
 * it at the same height; alone, it is a tile again. */
function syncAround() {
  const on = showCtx && !!ctxMesh;
  if (sidesMesh) sidesMesh.visible = !on;
  if (skirtMesh) skirtMesh.visible = on;
  if (ctxLines) ctxLines.visible = on;
  if (ctxOccluder) ctxOccluder.visible = on;
}
let glow: THREE.Points | null = null;
let sidesMat: THREE.MeshBasicMaterial | null = null;
let sidesMesh: THREE.Mesh | null = null, skirtMesh: THREE.Mesh | null = null;
/** Faint outlines of the neighbouring hexes, drawn sharp over the blurred backdrop. */
let ctxLines: THREE.Group | null = null;
/** The same ground, invisible, in the main pass: it only fills the depth buffer, so a nearer ridge
 * hides the tile behind it (the backdrop alone can't: a background is behind everything). */
let ctxOccluder: THREE.Mesh | null = null;
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function build(m: LocalMap) {
  scene.remove(world); dispose(world);
  windows = null; glow = null; sidesMat = null; sidesMesh = null; skirtMesh = null; ctxMesh = null; ctxLines = null; ctxOccluder = null;
  world = new THREE.Group();
  const st = style;
  const { res, size } = m, half = size / 2, step = size / (res - 1);
  const shape = hexShape(m);
  const cut = st.frame === 'hex';
  const inFrame = (x: number, y: number) => (cut ? shape.inside(x, y) : Math.abs(x) <= half && Math.abs(y) <= half);

  // Terrain. Cut to the hex: samples outside are pulled onto its edge, so the tile has a clean
  // hexagonal outline, and quads wholly outside are dropped.
  const N = res * res;
  const px = new Float32Array(N), py = new Float32Array(N), ph = new Float32Array(N), out = new Uint8Array(N);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const v = j * res + i;
    let x = -half + i * step, y = -half + j * step, hh = m.heights[v];
    if (cut && !shape.inside(x, y)) { [x, y] = shape.nearest(x, y); hh = groundAtMap(m, x, y); out[v] = 1; }
    px[v] = x; py[v] = y; ph[v] = hh;
  }
  const pos = new Float32Array(N * 3);
  for (let v = 0; v < N; v++) { pos[v * 3] = px[v]; pos[v * 3 + 1] = ph[v]; pos[v * 3 + 2] = -py[v]; }
  const idx: number[] = [];
  for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
    const a = j * res + i, b = a + 1, c = a + res, d = c + 1;
    if (out[a] && out[b] && out[c] && out[d]) continue;
    idx.push(a, b, c, b, d, c);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(paintGround(m, st), 3));
  tg.setIndex(idx);
  tg.computeVertexNormals();
  const tmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97 });
  texturedGround(tmat);
  const terrain = new THREE.Mesh(tg, tmat);
  terrain.receiveShadow = true; terrain.castShadow = true;
  world.add(terrain);

  // Sides: earth in bands, so the map reads as a tile cut from the ground; water shows as water.
  // The floor sits a little below the lowest ground inside the frame (not the whole square map,
  // or a hex near a deep valley stands on a tall block).
  let lo = Infinity;
  for (let v = 0; v < N; v++) if (!out[v]) lo = Math.min(lo, ph[v]);
  if (m.sea) lo = Math.min(lo, 0);
  const floor = lo - Math.max(20, size * (cut ? 0.035 : 0.02));
  const ring: [number, number][] = [];
  if (cut) {
    for (let k = 0; k < shape.n; k++) {
      const ax = shape.H[k * 2], ay = shape.H[k * 2 + 1], bx = shape.H[((k + 1) % shape.n) * 2], by = shape.H[((k + 1) % shape.n) * 2 + 1];
      const segs = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let t = 0; t < segs; t++) ring.push([ax + (bx - ax) * t / segs, ay + (by - ay) * t / segs]);
    }
  } else {
    for (let i = 0; i < res - 1; i++) ring.push([-half + i * step, -half]);
    for (let j = 0; j < res - 1; j++) ring.push([half, -half + j * step]);
    for (let i = res - 1; i > 0; i--) ring.push([-half + i * step, half]);
    for (let j = res - 1; j > 0; j--) ring.push([-half, -half + j * step]);
  }
  ring.push(ring[0]);
  const bands = st.sides.map(col), sp: number[] = [], sc: number[] = [];
  const waterTop = col(st.water.deep);
  for (let k = 0; k < ring.length - 1; k++) {
    const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
    const ga = groundAtMap(m, ax, ay), gb = groundAtMap(m, bx, by);
    const ta = m.sea ? Math.max(0, ga) : ga, tb = m.sea ? Math.max(0, gb) : gb;
    // Rows from the top down: water (if any) to the ground, then the bands of earth to the floor.
    const rows = (top: number, g: number) => {
      const r: [number, THREE.Color][] = [];
      if (top > g + 0.01) r.push([top, waterTop], [g, waterTop]);
      const nb = bands.length;
      for (let b = 0; b <= nb; b++) {
        const yb = g + (floor - g) * (b === 0 ? 0 : 0.05 + 0.95 * b / nb);
        r.push([yb, bands[Math.min(nb - 1, b)]]);
        if (b > 0 && b < nb) r.push([yb, bands[b]]);
      }
      return r;
    };
    // Shading baked in by which way the face points, the same in every style's light.
    const nx = by - ay, ny = -(bx - ax), nl = Math.hypot(nx, ny) || 1;
    const shade = 0.78 + 0.22 * ((nx * -0.45 + ny * -0.9) / nl);
    const ra = rows(ta, ga), rb = rows(tb, gb);
    const L = Math.min(ra.length, rb.length);
    for (let r = 0; r < L - 1; r++) {
      const [ya0, ca0] = ra[r], [ya1, ca1] = ra[r + 1], [yb0, cb0] = rb[r], [yb1, cb1] = rb[r + 1];
      sp.push(ax, ya0, -ay, ax, ya1, -ay, bx, yb0, -by, bx, yb0, -by, ax, ya1, -ay, bx, yb1, -by);
      for (const c of [ca0, ca1, cb0, cb0, ca1, cb1]) sc.push(c.r * shade, c.g * shade, c.b * shade);
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  sg.computeVertexNormals();
  // Sides are the tile's edge, not landscape: unlit (shade baked above), no fog or haze, or they
  // turn grey, navy or black depending on the style's sun.
  const sides = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }));
  sides.name = 'sides';
  sidesMat = sides.material;
  sidesMesh = sides;

  // With the neighbours on, the sides give way to a short skirt in the edge's own ground colour:
  // the backdrop is coarser than the tile, and the skirt covers any sliver of gap at the seam.
  if (cut) {
    const tc = tg.getAttribute('color').array as Float32Array;
    const skp: number[] = [], skc: number[] = [], depth = Math.max(4, size * 0.02);
    const colAt = (x: number, y: number) => {
      const i = Math.max(0, Math.min(res - 1, Math.round((x + half) / step))), j = Math.max(0, Math.min(res - 1, Math.round((y + half) / step)));
      const v = j * res + i;
      return [tc[v * 3] * 0.8, tc[v * 3 + 1] * 0.8, tc[v * 3 + 2] * 0.8];
    };
    for (let k = 0; k < ring.length - 1; k++) {
      const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
      const ga = groundAtMap(m, ax, ay), gb = groundAtMap(m, bx, by);
      skp.push(ax, ga, -ay, ax, ga - depth, -ay, bx, gb, -by, bx, gb, -by, ax, ga - depth, -ay, bx, gb - depth, -by);
      const ca = colAt(ax, ay), cb = colAt(bx, by);
      for (const cc of [ca, ca, cb, cb, ca, cb]) skc.push(cc[0], cc[1], cc[2]);
    }
    const skg = new THREE.BufferGeometry();
    skg.setAttribute('position', new THREE.Float32BufferAttribute(skp, 3));
    skg.setAttribute('color', new THREE.Float32BufferAttribute(skc, 3));
    skg.computeVertexNormals();
    skirtMesh = new THREE.Mesh(skg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    skirtMesh.name = 'skirt';
    world.add(skirtMesh);
  }
  world.add(sides);

  // Water: coloured by depth, shallow to deep, with foam where it meets the land.
  const W = st.water, shallow = col(W.shallow), deep = col(W.deep), foam = col(W.foam);
  const waterMat = () => {
    // Pushed back a touch in depth: on gentle shores (true vertical scale) the ground and the
    // water are nearly the same height and flickered over each other; the ground wins ties.
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: W.roughness, metalness: 0.05, transparent: true, opacity: W.opacity,
      polygonOffset: true, polygonOffsetFactor: 0.5, polygonOffsetUnits: 2 });
    animateWater(mat);
    return mat;
  };
  const tint = (depth: number, out3: THREE.Color) => {
    out3.copy(shallow).lerp(deep, Math.min(1, depth / 10));
    if (depth < W.foamDepth) out3.lerp(foam, 1 - depth / W.foamDepth);
    return out3;
  };
  const tmp = new THREE.Color();
  const waterOver = (level: number, mask: Float32Array | null) => {
    const lp: number[] = [], lc: number[] = [];
    for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
      const v = j * res + i, q = [v, v + 1, v + res, v + res + 1];
      if (mask && Math.max(...q.map((u) => mask[u])) < 0.5) continue;
      if (Math.min(...q.map((u) => ph[u])) > level) continue;
      if (q.every((u) => out[u])) continue;
      for (const u of [q[0], q[1], q[2], q[1], q[3], q[2]]) {
        lp.push(px[u], level, -py[u]);
        tint(Math.max(0, level - ph[u]), tmp); lc.push(tmp.r, tmp.g, tmp.b);
      }
    }
    if (!lp.length) return;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    lg.computeVertexNormals();
    // (No shadows on open water: at a high sun they speckled it into a mesh-like grid.)
    const mesh = new THREE.Mesh(lg, waterMat());
    world.add(mesh);
  };
  if (m.sea) waterOver(0, null);
  if (!Number.isNaN(m.lakeLevel)) waterOver(m.lakeLevel, m.lakeMask);
  // Rivers: a ribbon of three rows, foam-pale at the banks and deeper down the middle.
  for (const r of m.rivers) {
    const p = r.pts, k = p.length / 4, rp = new Float32Array(k * 9), rc = new Float32Array(k * 9), ri: number[] = [];
    for (let s2 = 0; s2 < k; s2++) {
      const a = Math.max(0, s2 - 1), b = Math.min(k - 1, s2 + 1);
      let tx = p[b * 4] - p[a * 4], ty = p[b * 4 + 1] - p[a * 4 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const w = p[s2 * 4 + 3], hw = w * 0.55, x = p[s2 * 4], y = p[s2 * 4 + 1], lv = p[s2 * 4 + 2] + 0.05;
      rp.set([x - ty * hw, lv, -(y + tx * hw), x, lv, -y, x + ty * hw, lv, -(y - tx * hw)], s2 * 9);
      const mid = tint(Math.max(0.6, Math.min(6, 0.12 * w)) * 2, new THREE.Color());
      const bank = tint(W.foamDepth * 0.85, new THREE.Color());
      rc.set([bank.r, bank.g, bank.b, mid.r, mid.g, mid.b, bank.r, bank.g, bank.b], s2 * 9);
      // Only the stretch on the map.
      if (s2 < k - 1 && inFrame(x, y) && inFrame(p[s2 * 4 + 4], p[s2 * 4 + 5]) && !(m.sea && lv < 0.3 && groundAtMap(m, x, y) < 0)) {
        const o = s2 * 3;
        ri.push(o, o + 1, o + 3, o + 1, o + 4, o + 3, o + 1, o + 2, o + 4, o + 2, o + 5, o + 4);
      }
    }
    if (!ri.length) continue;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    rg.setIndex(ri);
    rg.computeVertexNormals();
    const mat = waterMat(); mat.side = THREE.DoubleSide; mat.roughness = Math.max(W.roughness, 0.45);   // narrow: sun glare turned it white
    const mesh = new THREE.Mesh(rg, mat); mesh.receiveShadow = true;
    world.add(mesh);
  }

  // Plants: the planet's own models (flora.ts), one instanced mesh per kind, life-size.
  const T = m.trees, STRIDE = 6, count = T.length / STRIDE;
  const byKind = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    if (!inFrame(T[i * STRIDE], T[i * STRIDE + 1])) continue;
    if (st.plants.keep < 1 && ((i * 2246822519) >>> 0) / 4294967296 > st.plants.keep) continue;
    // Grass tufts and reeds are too fine for the stylised looks: scribbles at this distance.
    const kk = T[i * STRIDE + 4];
    if (!st.plants.tufts && (kk === TUFT || (kk >= FIRST && FAMILIES[Math.floor((kk - FIRST) / VARIANTS)] === 'reeds'))) continue;
    const k = T[i * STRIDE + 4];
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(i);
  }
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc3 = new THREE.Vector3(), ps = new THREE.Vector3(), pc = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [kind, list] of byKind) {
    const mesh = new THREE.InstancedMesh(treeGeometry(kind), treeMaterial, list.length);
    list.forEach((i, k) => {
      const sz = T[i * STRIDE + 3], jit = ((i * 2654435761) >>> 0) / 4294967296;
      q.setFromAxisAngle(up, jit * Math.PI * 2);
      sc3.setScalar(sz * st.plants.scale);
      ps.set(T[i * STRIDE], T[i * STRIDE + 2] - 0.04 * sz * st.plants.scale, -T[i * STRIDE + 1]);
      mesh.setMatrixAt(k, mtx.compose(ps, q, sc3));
      pc.setHex(T[i * STRIDE + 5]);
      const l = 0.2126 * pc.r + 0.7152 * pc.g + 0.0722 * pc.b;
      pc.setRGB((l + (pc.r - l) * st.plants.sat) * st.plants.bright, (l + (pc.g - l) * st.plants.sat) * st.plants.bright, (l + (pc.b - l) * st.plants.sat) * st.plants.bright);
      mesh.setColorAt(k, pc);
    });
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'plants';
    world.add(mesh);
  }

  // Houses (placeholders where the history put towns): walls and a pitched roof, instanced, in the
  // style's colours; scaled up a little in the stylised looks, like the trees.
  const HS = m.houses, nh = HS.length / HOUSE_STRIDE;
  if (nh) {
    const keep: number[] = [];
    for (let k = 0; k < nh; k++) if (inFrame(HS[k * HOUSE_STRIDE], HS[k * HOUSE_STRIDE + 1])) keep.push(k);
    const wallGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    // A roof: a triangular prism along x, 1 wide, 1 deep, 1 tall, eaves overhanging a little.
    const roofGeo = new THREE.BufferGeometry();
    const rv = [-0.55, 0, -0.6, 0.55, 0, -0.6, 0, 1, -0.6, -0.55, 0, 0.6, 0, 1, 0.6, 0.55, 0, 0.6];
    roofGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      // gable ends
      rv[0], rv[1], rv[2], rv[3], rv[4], rv[5], rv[6], rv[7], rv[8],
      rv[9], rv[10], rv[11], rv[15], rv[16], rv[17], rv[12], rv[13], rv[14],
      // slopes
      rv[0], rv[1], rv[2], rv[6], rv[7], rv[8], rv[9], rv[10], rv[11], rv[9], rv[10], rv[11], rv[6], rv[7], rv[8], rv[12], rv[13], rv[14],
      rv[3], rv[4], rv[5], rv[15], rv[16], rv[17], rv[6], rv[7], rv[8], rv[6], rv[7], rv[8], rv[15], rv[16], rv[17], rv[12], rv[13], rv[14],
    ], 3));
    roofGeo.rotateY(Math.PI / 2);
    roofGeo.computeVertexNormals();
    const walls = new THREE.InstancedMesh(wallGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), keep.length);
    const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true, side: THREE.DoubleSide }), keep.length);
    const hm = new THREE.Matrix4(), hq = new THREE.Quaternion(), hs = new THREE.Vector3(), hp = new THREE.Vector3(), hc = new THREE.Color();
    const up2 = new THREE.Vector3(0, 1, 0), K = st.town.scale;
    keep.forEach((k, n) => {
      const o = k * HOUSE_STRIDE, x = HS[o], y = HS[o + 1], gy = HS[o + 2], rot = HS[o + 3];
      const wd = HS[o + 4] * K, dp = HS[o + 5] * K, wh = HS[o + 6] * K, ch = HS[o + 7];
      hq.setFromAxisAngle(up2, rot);
      walls.setMatrixAt(n, hm.compose(hp.set(x, gy - 0.6, -y), hq, hs.set(wd, wh + 0.6, dp)));
      walls.setColorAt(n, hc.setHex(st.town.walls[Math.floor(ch * 7919) % st.town.walls.length]));
      roofs.setMatrixAt(n, hm.compose(hp.set(x, gy + wh, -y), hq, hs.set(dp * 1.0, Math.min(wd, dp) * 0.55, wd * 1.0)));
      roofs.setColorAt(n, hc.setHex(st.town.roofs[Math.floor(ch * st.town.roofs.length) % st.town.roofs.length]));
    });
    // Chimneys on most houses, at one end of the ridge.
    const withChim = keep.filter((k) => HS[k * HOUSE_STRIDE + 7] < 0.7);
    const chims = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.9 }), Math.max(1, withChim.length));
    chims.count = withChim.length;
    const cOff = new THREE.Vector3();
    withChim.forEach((k, n) => {
      const o = k * HOUSE_STRIDE, x = HS[o], y = HS[o + 1], gy = HS[o + 2], rot = HS[o + 3];
      const wd = HS[o + 4] * K, dp = HS[o + 5] * K, wh = HS[o + 6] * K;
      hq.setFromAxisAngle(up2, rot);
      cOff.set(wd * 0.3, 0, dp * 0.15).applyQuaternion(hq);
      chims.setMatrixAt(n, hm.compose(hp.set(x + cOff.x, gy + wh, -y + cOff.z), hq, hs.set(0.9 * K, Math.min(wd, dp) * 0.55 + 1.2 * K, 0.9 * K)));
      chims.setColorAt(n, hc.setHex(0x6a5a50));
    });
    for (const im of [walls, roofs, chims]) { im.castShadow = true; im.receiveShadow = true; world.add(im); }
    // Windows: two square lights through each lit house, showing on both long walls. Three in four
    // houses are lit. Unlit material, brightened at night (applyTime).
    const lit = keep.filter((k) => (HS[k * HOUSE_STRIDE + 7] * 7.31) % 1 < 0.75);
    const win = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffb060 }), Math.max(1, lit.length * 2));
    win.count = lit.length * 2;
    win.name = 'windows';
    const wOff = new THREE.Vector3();
    lit.forEach((k, n) => {
      const o = k * HOUSE_STRIDE, x = HS[o], y = HS[o + 1], gy = HS[o + 2], rot = HS[o + 3];
      const wd = HS[o + 4] * K, dp = HS[o + 5] * K, wh = HS[o + 6] * K;
      hq.setFromAxisAngle(up2, rot);
      const sz = Math.min(0.9 * K, wh * 0.35);
      for (const side of [0, 1]) {
        wOff.set((side * 2 - 1) * wd * 0.24, 0, 0).applyQuaternion(hq);
        win.setMatrixAt(n * 2 + side, hm.compose(hp.set(x + wOff.x, gy + wh * 0.45, -y + wOff.z), hq, hs.set(sz, sz, dp + 0.15)));
      }
    });
    windows = win;
    world.add(win);
    const gp = new Float32Array(lit.length * 3);
    lit.forEach((k, n) => {
      const o = k * HOUSE_STRIDE;
      gp[n * 3] = HS[o]; gp[n * 3 + 1] = HS[o + 2] + HS[o + 6] * K * 0.6; gp[n * 3 + 2] = -HS[o + 1];
    });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    glow = new THREE.Points(gg, new THREE.PointsMaterial({ map: glowTex, size: 45 * K, color: 0xff9440, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.name = 'glow';
    world.add(glow);
  }

  // A person (1.8 m) beside the centre, for scale.
  const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.3, 4, 8), new THREE.MeshStandardMaterial({ color: 0xc0392b }));
  person.position.set(6, groundAtMap(m, 6, 0) + 0.9, 0); person.castShadow = true;
  world.add(person);

  // The hex outline, draped over the ground (on the cut tile, its edge is the outline already).
  const ol: number[] = [], H = m.hex, nc = H.length / 2;
  for (let k = 0; k < nc; k++) {
    const a = k, b = (k + 1) % nc;
    for (let t = 0; t < 160; t++) {
      const x = H[a * 2] + (H[b * 2] - H[a * 2]) * t / 160, y = H[a * 2 + 1] + (H[b * 2 + 1] - H[a * 2 + 1]) * t / 160;
      ol.push(x, Math.max(groundAtMap(m, x, y), m.sea ? 0 : -1e9) + size * 0.002, -y);
    }
  }
  ol.push(ol[0], ol[1], ol[2]);
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.Float32BufferAttribute(ol, 3));
  const showOutline = outline ? outline.visible : true;
  outline = new THREE.Line(og, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
  outline.visible = showOutline && !cut;
  world.add(outline);

  // The backdrop of neighbouring hexes, if the worker has sent it (it follows the hex).
  addContext(false);

  // The atmosphere on everything (a no-op outside the Earth style).
  world.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.name === 'plants' || o.name === 'sides' || o.name === 'windows' || o.name === 'occluder' || o.name === 'ctxlines') return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) applyAerial(mat, true);
  });
  // Where the map sits on the planet: x east, y up, z south (three.js), metres to radii.
  const F = m.frame;
  planetScale = m.mag / (m.radiusKm * 1000) * (st.atmosphere ? st.haze ?? 1 : 1);
  const ps2 = planetScale;
  toPlanet.set(
    F[3] * ps2, F[0] * ps2, -F[6] * ps2, F[0],
    F[4] * ps2, F[1] * ps2, -F[7] * ps2, F[1],
    F[5] * ps2, F[2] * ps2, -F[8] * ps2, F[2],
    0, 0, 0, 1,
  );
  toPlanetRot.setFromRotationMatrix(new THREE.Matrix4().extractRotation(toPlanet));
  if (st.atmosphere) {
    world.matrixAutoUpdate = false;
    world.matrix.copy(toPlanet);
    world.matrixWorldNeedsUpdate = true;
  }
  scene.add(world);
  applyLook(m);
}

/** Views are framed for a 16:10 screen; on a narrower one (a phone held upright) the camera backs
 * off by this much so most of the width still fits, and the fog thins to match. */
const narrowness = () => Math.max(1, (1.6 / camera.aspect) ** 0.75);

/** Light, shadows, camera and grade for the current style: the parts the hour doesn't change. */
function applyLook(m: LocalMap) {
  const st = style, size = m.size;
  lat = Math.asin(Math.max(-1, Math.min(1, m.frame[1])));
  const fog = scene.fog as THREE.FogExp2;
  fog.density = st.atmosphere ? 0 : st.fog / size / narrowness();
  // In the Earth style everything is in planet radii: the lights move with the map.
  const k = st.atmosphere ? planetScale : 1;
  const sc = sun.shadow.camera;
  sc.left = -size * 0.75 * k; sc.right = size * 0.75 * k; sc.top = size * 0.75 * k; sc.bottom = -size * 0.75 * k;
  sc.near = 1 * k; sc.far = size * 4 * k; sc.updateProjectionMatrix();
  sun.shadow.normalBias = (size / (m.res - 1)) * 0.5 * k;
  camera.far = size * 8; camera.fov = st.camera.fov; camera.updateProjectionMatrix();
  photoPass.enabled = st.photoGrade;
  gradePass.enabled = !st.photoGrade;
  const G = gradePass.uniforms;
  G.uSat.value = st.grade.sat; G.uContrast.value = st.grade.contrast;
  G.uVig.value = st.grade.vignette; G.uLift.value = st.grade.lift;
  tiltH.enabled = tiltV.enabled = tiltOn;
  groundTex.uTexAmt.value = st.texture.amount; groundTex.uTexScale.value = st.texture.scale;
  // Point size is in scene units: in the Earth style those are planet radii, not metres.
  if (glow) (glow.material as THREE.PointsMaterial).size = 45 * st.town.scale * k;
  applyTime();
}

// --- Time of day (daylight.ts) ---
let lat = 0;
/** The hour shown: Bill's, or the style's own (when its designed sun stands, in the afternoon). */
const hourNow = () => userHour ?? hourForElevation(lat, style.sun.elev);
/** The real sun's direction in the map's frame, for the atmosphere (the key light may be the moon). */
const realSun = new THREE.Vector3(0, 1, 0);
const skyCv = document.createElement('canvas'); skyCv.width = 2; skyCv.height = 256;
const skyTex = new THREE.CanvasTexture(skyCv); skyTex.colorSpace = THREE.SRGBColorSpace;
const tmpCol = new THREE.Color();
const cssOf = (c: RGB) => '#' + tmpCol.setRGB(c[0], c[1], c[2]).getHexString(THREE.SRGBColorSpace);

/** Everything the hour changes: sun or moon, sky, fog colour, ambient light, exposure, grade tint
 * and lit windows. Cheap enough to run every frame while the day plays. */
function applyTime() {
  if (!map) return;
  const st = style, size = map.size, L = daylight(st, lat, hourNow());
  realSun.set(L.sun[0], L.sun[1], L.sun[2]);
  const g = skyCv.getContext('2d')!, gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, cssOf(L.sky[0])); gr.addColorStop(1, cssOf(L.sky[1]));
  g.fillStyle = gr; g.fillRect(0, 0, 2, 256); skyTex.needsUpdate = true;
  (scene.fog as THREE.FogExp2).color.setRGB(L.fog[0], L.fog[1], L.fog[2]);
  hemi.color.setRGB(L.hemiSky[0], L.hemiSky[1], L.hemiSky[2]);
  hemi.groundColor.setRGB(L.hemiGround[0], L.hemiGround[1], L.hemiGround[2]);
  hemi.intensity = L.hemiI;
  const d = size * 1.2, [kx, ky, kz] = L.key.dir;
  sun.color.setRGB(L.key.color[0], L.key.color[1], L.key.color[2]); sun.intensity = L.key.intensity;
  sun.position.set(kx * d, ky * d, kz * d); sun.target.position.set(0, 0, 0);
  rim.intensity = L.rim;
  rim.position.set(-sun.position.x, size * 0.3, -sun.position.z);
  // The planet's atmosphere already brightens low-sun skies; adapting fully washes them out.
  renderer.toneMappingExposure = st.atmosphere ? Math.min(L.exposure, st.exposure * (st.paintedSky ? 3 : 1.5)) : L.exposure;
  gradePass.uniforms.uTint.value = L.tint;
  if (style.atmosphere) {
    sun.position.applyMatrix4(toPlanet); rim.position.applyMatrix4(toPlanet);
    sun.target.position.set(0, 0, 0).applyMatrix4(toPlanet); rim.target.position.copy(sun.target.position);
    scene.background = st.paintedSky ? skyTex : new THREE.Color(0x0a1424);
  } else {
    scene.background = skyTex;
    rim.target.position.set(0, 0, 0);
  }
  sun.target.updateMatrixWorld(); rim.target.updateMatrixWorld();
  if (sidesMat) sidesMat.color.setRGB(L.sideLight * L.tint[0], L.sideLight * L.tint[1], L.sideLight * L.tint[2]);
  if (ctxLines) for (const o of ctxLines.children) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setRGB(L.sideLight, L.sideLight * 0.94, L.sideLight * 0.84);
  if (glow) {
    glow.visible = L.windows > 0.01;
    (glow.material as THREE.PointsMaterial).opacity = 0.5 * L.windows;
  }
  if (windows) {
    windows.visible = L.windows > 0.01;
    (windows.material as THREE.MeshBasicMaterial).color.setRGB(1.7 * L.windows, 0.85 * L.windows, 0.28 * L.windows);
  }
  syncTime(L.elev);
}
function syncTime(elev: number) {
  const hr = hourNow(), hh = Math.floor(hr), mm = Math.floor((hr - hh) * 60);
  $<HTMLInputElement>('time').value = String(hr);
  $('time-out').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('time-sun').textContent = elev > 0 ? `sun ${Math.round(elev)}° up` : elev > -6 ? 'twilight' : 'night';
  $('play').textContent = playing ? '❚❚' : '▶';
}
function setTime(hr: number | null) { userHour = hr === null ? null : ((hr % 24) + 24) % 24; applyTime(); writeHash(); }
$<HTMLInputElement>('time').oninput = (e) => { playing = false; setTime(Number((e.target as HTMLInputElement).value)); };
$('play').onclick = () => { playing = !playing; if (!playing) writeHash(); if (map) applyTime(); else $('play').textContent = playing ? '❚❚' : '▶'; };
$('time-reset').onclick = () => { playing = false; setTime(null); };

// --- The inset: the planet's own picture of this ground. ---
function drawInset(m: LocalMap) {
  const cv = $<HTMLCanvasElement>('map'), ctx = cv.getContext('2d')!, W = cv.width;
  const k = W / m.size, X = (x: number) => W / 2 + x * k, Y = (y: number) => W / 2 - y * k;
  ctx.fillStyle = '#10161b'; ctx.fillRect(0, 0, W, W);
  const poly = (i: number) => {
    ctx.beginPath();
    for (let p = m.polyStart[i]; p < m.polyStart[i + 1]; p++) {
      const x = X(m.polyXY[p * 2]), y = Y(m.polyXY[p * 2 + 1]);
      if (p === m.polyStart[i]) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  for (let i = 0; i < m.cells.length; i++) {
    poly(i);
    ctx.fillStyle = '#' + m.cellRGB[i].toString(16).padStart(6, '0'); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.strokeStyle = '#5fa8e6'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  const R = m.planetRivers;
  for (let i = 0; i < R.length; i += 6) {
    ctx.beginPath(); ctx.moveTo(X(R[i]), Y(R[i + 1])); ctx.lineTo(X(R[i + 2]), Y(R[i + 3])); ctx.lineTo(X(R[i + 4]), Y(R[i + 5])); ctx.stroke();
  }
  poly(0); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
}

// --- Panel ---
function setAround(on: boolean) { showCtx = on; $<HTMLInputElement>('around').checked = on; syncAround(); writeHash(); }
$<HTMLInputElement>('around').onchange = (e) => setAround((e.target as HTMLInputElement).checked);
function setTilt(on: boolean) { tiltOn = on; tiltH.enabled = tiltV.enabled = on; syncPanel(); writeHash(); }
function syncPanel() {
  $<HTMLInputElement>('tilt').checked = tiltOn;
  $<HTMLInputElement>('around').checked = showCtx;
  $<HTMLInputElement>('mag').value = String(opts.mag); $('mag-out').textContent = `${opts.mag}×`;
  $<HTMLInputElement>('vscale').value = String(opts.vScale); $('vscale-out').textContent = String(opts.vScale);
  $<HTMLSelectElement>('river').value = opts.riverMode;
  $<HTMLSelectElement>('vsoft').value = String(opts.vSoft);
  $<HTMLInputElement>('crags').checked = opts.crags;
  $<HTMLSelectElement>('res').value = String(opts.res);
}
const custom = () => { syncPanel(); request(); };
$<HTMLInputElement>('tilt').onchange = (e) => setTilt((e.target as HTMLInputElement).checked);
$<HTMLInputElement>('mag').oninput = (e) => { opts.mag = Number((e.target as HTMLInputElement).value); $('mag-out').textContent = `${opts.mag}×`; };
$<HTMLInputElement>('mag').onchange = custom;
$<HTMLInputElement>('vscale').oninput = (e) => { opts.vScale = Number((e.target as HTMLInputElement).value); $('vscale-out').textContent = String(opts.vScale); };
$<HTMLInputElement>('vscale').onchange = custom;
$<HTMLSelectElement>('vsoft').onchange = (e) => { opts.vSoft = Number((e.target as HTMLSelectElement).value); custom(); };
$<HTMLSelectElement>('river').onchange = (e) => { opts.riverMode = (e.target as HTMLSelectElement).value as LocalOptions['riverMode']; custom(); };
$<HTMLInputElement>('crags').onchange = (e) => { opts.crags = (e.target as HTMLInputElement).checked; custom(); };
$<HTMLSelectElement>('res').onchange = (e) => { opts.res = Number((e.target as HTMLSelectElement).value); request(); };

function writeHash() {
  const o = new URLSearchParams(back);
  o.set('cell', String(cell));
  if (tiltOn !== style.tiltShift) o.set('tilt', tiltOn ? '1' : '0');
  // Only what differs from the defaults (content-aware 10x).
  const D = LOCAL_DEFAULTS;
  if (opts.mag !== D.mag) o.set('mag', String(opts.mag));
  if (opts.vScale !== D.vScale) o.set('vScale', String(opts.vScale));
  if (opts.vSoft !== D.vSoft) o.set('vSoft', String(opts.vSoft));
  if (opts.riverMode !== D.riverMode) o.set('river', opts.riverMode);
  if (opts.crags !== D.crags) o.set('crags', opts.crags ? '1' : '0');
  if (opts.res !== D.res) o.set('res', String(opts.res));
  if (userHour !== null) o.set('time', userHour.toFixed(2));
  if (!showCtx) o.set('around', '0');
  history.replaceState(null, '', location.pathname + '#' + o.toString());
}

/** How rises of a few sizes come out, e.g. "100 m → 50 m, 1 km → 380 m, 5 km → 830 m". */
function heightLine() {
  const f = localHeights(opts, 0);
  const d = (t: number) => { const v = f(t); return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`; };
  return `Rises drawn: 100 m → ${d(100)}, 1 km → ${d(1000)}, 5 km → ${d(5000)}`;
}
function facts(m: LocalMap) {
  const i = m.info;
  const km = m.trueWidthKm.toFixed(1), drawn = m.localWidth >= 1000 ? `${(m.localWidth / 1000).toFixed(2)} km` : `${Math.round(m.localWidth)} m`;
  const rw = i.riverWidthsM.length ? i.riverWidthsM.map((w) => {
    const d = opts.riverMode === 'scaled' ? w / opts.mag : Math.min(Math.max(6, w * 0.8), m.size * 0.05);
    return `${w} m (drawn ${d < 10 ? d.toFixed(1) : Math.round(d)} m)`;
  }).join(', ') : '';
  $('title').textContent = `Hex ${m.cell}`;
  $('facts').innerHTML =
    `<b>${i.biome}</b> · ${i.tempC} °C mean · ground ~${i.trueHeightM.toLocaleString()} m<br>` +
    `Really <b>${km} km</b> across, drawn <b>${drawn}</b> (${opts.mag}× smaller)<br>` +
    heightLine() +
    (rw ? `<br>River here: ${rw}` : '');
}

// --- Building, off the main thread: one worker for the hex, one for the backdrop of neighbours,
// so both build at once. One request in flight; later changes collapse into one. ---
const worker = new Worker(new URL('./hexworker.ts', import.meta.url), { type: 'module' });
const ctxWorker = new Worker(new URL('./hexworker.ts', import.meta.url), { type: 'module' });
let busy = false, again = false, firstBuild = true;
/** The planet's valleys have arrived (for which world), and whether the hex on show has them. */
let valleysIn = '', mapValleys = false;
function request() {
  writeHash();
  if (busy) { again = true; return; }
  busy = true; $('busy').hidden = false;
  const job: HexJob = { kind: 'hex', params, cell, spot: cell < 0 ? (spot ?? 'river') : undefined, opts };
  worker.postMessage(job);
  // The backdrop needs the cell; with a named spot it follows once the hex says which.
  if (cell >= 0) ctxWorker.postMessage({ ...job, kind: 'context' });
}
/** Both workers build the world now (the hex view loading hidden behind the planet). */
function warm() {
  for (const [w, kind] of [[worker, 'hex'], [ctxWorker, 'context']] as const) w.postMessage({ kind, params, cell: -1, opts, warm: true } satisfies HexJob);
}
/** The planet's carved valleys (relief.ts) for the world in a planet hash: to both workers. */
function takeValleys(hash: string, n: number, half: Uint16Array) {
  // The planet's carved valleys (relief.ts), for the world in the hash: to both workers.
  const q = new URLSearchParams(hash), p = { ...params };
  const sd = parseSeed(q.get('seed') ?? '');
  if (sd) p.seed = sd.seed;
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = q.get(k);
    if (k !== 'seed' && v !== null && v !== '' && !Number.isNaN(Number(v))) p[k] = Number(v);
  }
  const msg = (h: Uint16Array): ValleyJob => ({ kind: 'valleys', params: p, n, half: h });
  worker.postMessage(msg(half.slice()));
  ctxWorker.postMessage(msg(half), [half.buffer]);
  valleysIn = JSON.stringify(p);
  // A hex on show without them: build it again.
  if (map && !mapValleys && JSON.stringify(params) === valleysIn) request();
}
/** Start building a hex before it is opened (the planet's pointer is resting on it). */
function prefetch(c: number) {
  if (c < 0) return;
  for (const [w, kind] of [[worker, 'hex'], [ctxWorker, 'context']] as const) w.postMessage({ kind, params, cell: c, opts, prefetch: true } satisfies HexJob);
}
ctxWorker.onmessage = (e: MessageEvent<{ context?: LocalMap; warmed?: boolean }>) => {
  if (!e.data.context) return;
  ctxMap = e.data.context;
  if (map) addContext(true);
};
worker.onmessage = (e: MessageEvent<{ map: LocalMap; ms: { world: number; local: number }; context?: LocalMap }>) => {
  if ((e.data as { warmed?: boolean }).warmed) return;
  busy = false;
  const m = e.data.map;
  mapValleys = !!(e.data as { valleys?: boolean }).valleys;
  if (cell < 0) ctxWorker.postMessage({ kind: 'context', params, cell: m.cell, opts } satisfies HexJob);
  // Keep the camera's place relative to the map size, so changes compare from the same angle.
  const rel = map && !firstBuild ? { p: camera.position.clone().divideScalar(map.size), t: controls.target.clone().divideScalar(map.size) } : null;
  cell = m.cell;
  map = m;
  build(m);
  drawInset(m); facts(m);
  if (rel) { camera.position.copy(rel.p.multiplyScalar(m.size)); controls.target.copy(rel.t.multiplyScalar(m.size)); }
  else resetView();
  firstBuild = false;
  $('timing').textContent = `world ${Math.round(e.data.ms.world)} ms · hex ${Math.round(e.data.ms.local)} ms${(e.data as { prebuilt?: boolean }).prebuilt ? ' (prebuilt)' : ''} · ${(m.trees.length / 6).toLocaleString()} plants`;
  writeHash();
  if (again) { again = false; request(); } else $('busy').hidden = true;
};

/** The style's own camera: tilted `tilt` degrees from straight down, looking north at the centre. */
function resetView() {
  if (!map) return;
  const g = groundAt(0, 0), c = style.camera;
  let hi = -Infinity, lo = Infinity;
  for (const v of map.heights) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  // Back off for tall terrain, or a mountain overfills the frame.
  const narrow = narrowness();
  const fit = (map.localWidth * 0.62 + Math.max(0, hi - Math.max(lo, 0)) * 0.6) / Math.tan((c.fov * Math.PI / 180) / 2) * c.dist * narrow;
  // Standing further back on a narrow screen, look down more steeply, or near hills hide the hex.
  const t = Math.max(30, c.tilt - 12 * (narrow - 1)) * Math.PI / 180;
  controls.target.set(0, g, 0);
  camera.position.set(0, g + Math.cos(t) * fit, Math.sin(t) * fit);
  controls.update();
  tiltH.uniforms.uFocus.value = tiltV.uniforms.uFocus.value = 0.5;
}
$('reset').onclick = resetView;

// --- Walking ---
const keys = new Set<string>();
let saved: { p: THREE.Vector3; t: THREE.Vector3; tilt: boolean } | null = null;
$('walk').onclick = () => {
  if (!map) return;
  saved = { p: camera.position.clone(), t: controls.target.clone(), tilt: tiltOn };
  camera.position.set(8, waterAt(8, 3) + 1.7, -3);
  camera.lookAt(0, groundAt(0, 0) + 2, 0);
  controls.enabled = false;
  tiltH.enabled = tiltV.enabled = false;
  walker.lock();
};
walker.addEventListener('unlock', () => {
  controls.enabled = true;
  if (saved) { camera.position.copy(saved.p); controls.target.copy(saved.t); controls.update(); tiltH.enabled = tiltV.enabled = saved.tilt; saved = null; }
});
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (walker.isLocked || (e.target as HTMLElement)?.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (e.code === 'BracketLeft') { playing = false; setTime(hourNow() - 0.5); }
  if (e.code === 'BracketRight') { playing = false; setTime(hourNow() + 0.5); }
  if (e.code === 'KeyP') $('play').click();
  if (e.code === 'Escape' && embedded) goBack();
  if (e.code === 'KeyT') setTilt(!tiltOn);
  if (e.code === 'KeyN') setAround(!showCtx);
  if (e.code === 'KeyH' && outline) outline.visible = !outline.visible;
});
addEventListener('keyup', (e) => keys.delete(e.code));

const timer = new THREE.Timer();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
let frames = 0, fpsT = 0;
const loop = () => {
  timer.update();
  const dt = Math.min(0.1, timer.getDelta());
  frames++; fpsT += dt;
  waterTime.value += dt;
  // Playing: a day in 48 seconds.
  if (playing && map) { userHour = (hourNow() + dt * 0.5) % 24; applyTime(); }
  if (fpsT > 1) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
  if (walker.isLocked && map) {
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 14 : 1.6;
    camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();
    let mx = 0, mz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) mx += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) mx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mz += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mz -= 1;
    camera.position.addScaledVector(fwd, mx * speed * dt).addScaledVector(right, mz * speed * dt);
    const lim = map.size / 2 - 1;
    camera.position.x = Math.max(-lim, Math.min(lim, camera.position.x));
    camera.position.z = Math.max(-lim, Math.min(lim, camera.position.z));
    camera.position.y = waterAt(camera.position.x, -camera.position.z) + 1.7;
  } else controls.update();
  // The real sun (not the moon) for the atmosphere; in the Earth style through the same map-to-planet
  // matrix as the lights (it may mirror, so not just its rotation).
  if (style.atmosphere) sunDir.copy(realSun).multiplyScalar(1000).applyMatrix4(toPlanet).sub(sunOrigin.set(0, 0, 0).applyMatrix4(toPlanet)).normalize();
  else sunDir.copy(realSun);
  if (style.atmosphere && map) {
    camera.updateMatrixWorld();
    planetCam.position.copy(camera.position).applyMatrix4(toPlanet);
    planetCam.quaternion.copy(toPlanetRot).multiply(camera.quaternion);
    planetCam.fov = camera.fov; planetCam.aspect = camera.aspect;
    planetCam.near = camera.near * planetScale; planetCam.far = camera.far * planetScale;
    planetCam.updateProjectionMatrix(); planetCam.updateMatrixWorld();
    atmo.update(renderer, planetCam, sunDir, true);
    renderPass.camera = planetCam;
  } else {
    atmo.update(renderer, camera, sunDir, false);
    renderPass.camera = camera;
  }
  renderFrame();
};
renderer.setAnimationLoop(embedded && cell < 0 ? null : loop);

function renderFrame() {
  if (!ctxMesh || !showCtx) { composer.render(); return; }
  const cam = renderPass.camera as THREE.PerspectiveCamera;
  // 1. The neighbouring ground alone, with the sky, at half size.
  cam.layers.set(1);
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(ctxRT); renderer.clear(); renderer.render(scene, cam);
  renderer.shadowMap.autoUpdate = true;
  cam.layers.set(0);
  // 2. Blurred, once each way: soft, but the land still reads.
  const sp = 0.6 * Math.max(1, ctxRT.height / 500);
  for (let it = 0; it < 1; it++) {
    blurMat.uniforms.tSrc.value = ctxRT.texture; blurMat.uniforms.uDir.value.set(sp / ctxRT.width, 0);
    renderer.setRenderTarget(blurRT); blurQuad.render(renderer);
    blurMat.uniforms.tSrc.value = blurRT.texture; blurMat.uniforms.uDir.value.set(0, sp / ctxRT.height);
    renderer.setRenderTarget(ctxRT); blurQuad.render(renderer);
  }
  renderer.setRenderTarget(null);
  // 3. The tile, sharp, in front of it (the sky is already in the backdrop).
  const bg = scene.background, sky = atmo.sky.visible;
  scene.background = ctxRT.texture; atmo.sky.visible = false;
  composer.render();
  scene.background = bg; atmo.sky.visible = sky;
}

syncPanel();
if (embedded && cell < 0) {
  // Loaded hidden: build the world now, so the first hex opened is quick.
  warm();
} else request();
if (embedded) {
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'mundi-hex-open') {
      const was = JSON.stringify(params) + cell + opts.radiusKm;
      applyHash(e.data.hash);
      if (!map || JSON.stringify(params) + cell + opts.radiusKm !== was) {
        // A different hex: clear the old one at once rather than show it while the new one builds.
        world.visible = false; ctxMap = null; firstBuild = true;
        request();
      }
      renderer.setAnimationLoop(loop);
    }
    if (e.data.type === 'mundi-hex-close') {
      playing = false;
      if (walker.isLocked) walker.unlock();
      renderer.setAnimationLoop(null);
    }
    if (e.data.type === 'mundi-hex-warm') { applyHash(e.data.hash); warm(); }
    if (e.data.type === 'mundi-hex-valleys') takeValleys(e.data.hash, e.data.n, e.data.half);
    if (e.data.type === 'mundi-hex-prefetch') {
      // The world settings may be new; which hex is shown is not, until it is opened.
      const shown = cell;
      applyHash(e.data.hash);
      const c = cell;
      cell = shown;
      prefetch(c);
    }
  });
  parent.postMessage({ type: 'mundi-hex-ready' }, location.origin);
}
void LAYERS; void L_DEPTH;
(window as unknown as Record<string, unknown>).hex = {
  get map() { return map; },
  get busy() { return busy; },
  /** The hex on show was built with the planet's valleys. */
  get valleys() { return mapValleys; },
  get style() { return style.id; },
  resetView, scene, setTilt, setTime, setAround,
  /** The planet's valleys, as the planet page sends them (scripts/hexcompare.mjs). */
  takeValleys,
  /** Hide the panels for clean screenshots. */
  capture: (on: boolean) => document.body.classList.toggle('capture', on),
  /**
   * Match a planet-view camera: `distRadii` from the ground point at the screen's centre (in
   * planet radii), tilted `tilt` radians from straight down, looking north, with a `fov` lens.
   * The distance is shrunk by mag like the ground, so the hex fills the frame alike. The ground
   * point is (eastM, northM) real metres from the cell's centre.
   */
  pose: (distRadii: number, tilt: number, fov: number, eastM = 0, northM = 0) => {
    if (!map) return;
    const d = distRadii * opts.radiusKm * 1000 / opts.mag;
    const tx = eastM / opts.mag, ty = northM / opts.mag, g = groundAt(tx, ty);
    camera.fov = fov; camera.updateProjectionMatrix();
    controls.target.set(tx, g, -ty);
    camera.position.set(tx, g + Math.cos(tilt) * d, -ty + Math.sin(tilt) * d);
    controls.update();
  },
  /** Camera at (x, y north) metres, height above ground, looking at (tx, ty). */
  look: (x: number, y: number, up: number, tx: number, ty: number) => {
    camera.position.set(x, groundAt(x, y) + up, -y);
    controls.target.set(tx, groundAt(tx, ty), -ty); controls.update();
  },
};
