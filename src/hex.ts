/**
 * The hex view: one planet hex opened up as a walkable local map (hex.html). Opened from the
 * planet by double-clicking a hex. The generator (hexlocal.ts) lays out the ground from the
 * planet; a style (hexstyle.ts, keys 1–5) decides how it is drawn.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { GRADE_SHADER } from './grade.ts';
import { Atmosphere, applyAerial } from './atmosphere.ts';
import { treeGeometry, treeMaterial, TUFT } from './flora.ts';
import { FIRST, FAMILIES, VARIANTS } from './species.ts';
import { loadPack, packModel, packMaterial, packStill, PackPlants, type Pack } from './hexplants.ts';
import { wind, WindLines, clouds, cloudMaterial } from './hexwind.ts';
import { Grass, grassField } from './hexgrass.ts';
import { waterMaterial, waterUniforms, shoreUniforms, SHORE_GLSL } from './hexwater.ts';
import { DEFAULT_PARAMS, type WorldParams } from './world.ts';
import { parseSeed } from './seedname.ts';
import { LOCAL_DEFAULTS, localHeights, LAYERS, L_DEPTH, L_FOREST, L_SNOW, L_LUSH, L_FIELD, L_HEDGE, L_PATH, HOUSE_STRIDE, type LocalMap, type LocalOptions, H_LOG, H_LILYPAD, isFlower, H_FERN, H_STUMP, isHexKind } from './hexlocal.ts';
import { STYLE, paintGround, groundGrain, STYLE_GRADE, TILT_SHIFT, type HexStyle } from './hexstyle.ts';
import { daylight, hourForElevation, type RGB } from './daylight.ts';
import type { HexJob, ValleyJob } from './hexworker.ts';
import type { Spot } from './debug.ts';
import { HexCamera, FEEL } from './hexcamera.ts';
import { Walker, pegman } from './hexwalk.ts';
import { mountHud } from './hexui.ts';
import { PROP_STRIDE } from './hextown.ts';
import { familyOf, loadHouses, buildHouses, buildProps, houseMaterial, houseNight, HOUSE_MODES, type HouseMode, type HousePack, type Building } from './hexhouses.ts';
import { snowGround, snowContext } from './hexsnow.ts';
import { HexFog } from './primundi/hexfog.ts';
import { Nav, Caravan, townSpots, townLandmark, noticeBoard, findModel, LANDMARKS, type TownSpot } from './primundi/hexcaravan.ts';
import { FOLK_LABEL, type FolkKind } from './primundi/life.ts';
import { makeRng } from './rng.ts';
import { noiseTexture } from './primundi/fog.ts';

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
/** How towns' buildings are drawn (hexhouses.ts): CC0 model families, or the plain boxes. */
let houseMode: HouseMode = (HOUSE_MODES.find(([k]) => k === h.get('houses'))?.[0]) ?? 'people';
let housePack: HousePack | null = null;
let housesGroup: THREE.Group | null = null;
// One look: Golden Earth (hexstyle.ts), Bill's pick of six on 2026-11-04.
const style: HexStyle = STYLE;
let tiltOn = h.get('tilt') === null ? style.tiltShift : h.get('tilt') === '1';
/** The hour of local solar time, once Bill has set one; until then each style's own hour. */
let userHour: number | null = h.get('time') !== null && h.get('time') !== '' ? ((Number(h.get('time')) % 24) + 24) % 24 : null;
let playing = false;
/** The fill light's strength, as a share of the sun's. */
const fillK = h.get('fill') !== null ? Number(h.get('fill')) : 0.28;
/** Primundi (primundi.html): the hex is a game's, and neighbours not yet revealed (not in `seen` in the link)
 * stand in fog. The game's own bar replaces "← planet", and the inset map, which would show what
 * the fog hides, is gone. */
const game = h.get('game') === '1';
let gameSeen = new Set((h.get('seen') ?? '').split('.').filter(Boolean).map(Number));
/** Primundi: the place in this hex ('town', or 'home' for the caravan's own), and the cell the
 * caravan came in from. */
let gameTown = h.get('town') ?? '';
let gameFrom = Number(h.get('from') ?? -1);
/** Primundi: what there is to find in this hex (finds.ts kinds), and which of them are used up. */
let gameFinds = (h.get('finds') ?? '').split('.').filter(Boolean);
let gameUsed = new Set((h.get('used') ?? '').split('.').filter(Boolean));
/** Primundi: jobs whose camp or site is in this hex, `kind~id`. */
let gameJobs = (h.get('jobs') ?? '').split('.').filter(Boolean);
/** Primundi: others on the road in this hex, `kind~id` (life.ts). */
let gameFolk = (h.get('folk') ?? '').split('.').filter(Boolean);
const hexFog = game ? new HexFog(noiseTexture()) : null;
if (game) {
  document.body.classList.add('primundi');
  const css = document.createElement('style');
  css.textContent = '.primundi .hud-back, .primundi #back, .primundi #inset, .primundi .hud-time { display: none !important; }';
  document.head.appendChild(css);
  hexFog!.onStrike = (near) => parent.postMessage({ type: 'primundi-thunder', near }, location.origin);
}
/** The neighbouring hexes, drawn blurred behind the tile (N, or the panel). */
let showCtx = h.get('around') !== '0';
/** Plant models from the free Ultimate Nature pack (hexplants.ts; Bill's pick of four, 2026-11-05),
 * fetched from the start. Kinds it lacks keep the planet's own models. */
let pack: Pack | null = null;
let packReady: Promise<void> | null = null;
const fetchPack = () => (packReady ??= loadPack().then((p) => { pack = p; }));
void fetchPack();
let packPlants: PackPlants | null = null;
/** The full models within this far of the camera, map metres; simplified ones beyond. */
const NEAR_M = 140;
const back = new URLSearchParams(h);
for (const k of ['cell', 'spot', 'v', 'mag', 'vScale', 'vSoft', 'res', 'river', 'crags', 'style', 'tilt', 'time', 'around', 'plants', 'houses']) back.delete(k);
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
  if (game) { gameSeen = new Set((q.get('seen') ?? '').split('.').filter(Boolean).map(Number)); gameTown = q.get('town') ?? ''; gameFrom = Number(q.get('from') ?? -1);
    gameFinds = (q.get('finds') ?? '').split('.').filter(Boolean); gameUsed = new Set((q.get('used') ?? '').split('.').filter(Boolean));
    gameJobs = (q.get('jobs') ?? '').split('.').filter(Boolean);
    gameFolk = (q.get('folk') ?? '').split('.').filter(Boolean); }
  for (const k of [...back.keys()]) back.delete(k);
  for (const [k, v] of q) if (!['cell', 'spot', 'v', 'mag', 'vScale', 'vSoft', 'res', 'river', 'crags', 'style', 'tilt', 'time', 'around', 'plants', 'houses'].includes(k)) back.set(k, v);
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
// A city-builder camera (hexcamera.ts): right-drag pans, middle-drag turns, the wheel zooms.
const controls = new HexCamera(camera, renderer.domElement);
controls.ground = (x, z) => waterAt(x, -z);
{ const f = h.get('feel'); if (f && FEEL[f]) controls.feel = FEEL[f]; }
// Walking (hexwalk.ts): drag the little figure onto the map.
const walker = new Walker(camera, renderer.domElement);
walker.ground = controls.ground;
if (h.get('bob') !== null) walker.bob = Number(h.get('bob'));
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
/** The key light (sun or moon) as the hour sets it; not in the scene itself: the cascades below
 * carry it, each with its own shadow map. */
const sun = new THREE.DirectionalLight(0xffffff, 1);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0);
scene.add(hemi, rim, rim.target);
// Shadows in three cascades that follow the camera (2026-11-06): a fine map for the first few tens
// of metres (a tree's own shadow, dappled light in a wood), a middle one, and a coarse one for the
// whole view. One map over the whole hex was ~0.5 m a texel, so plants' shadows were mush.
// (CSM swaps three's light chunks for its own; the hex page is its own document, so the planet's
// shaders are untouched.)
const csmBreaks = [0.1, 0.4, 1];
const csm = new CSM({ camera, parent: scene, cascades: 3, mode: 'custom', shadowMapSize: 2048, shadowBias: -0.0002, lightIntensity: 1,
  customSplitsCallback: (n: number, near: number, far: number, out: number[]) => { for (const b of csmBreaks) out.push(b); } });
csm.fade = true;
csm.lights[2].shadow.mapSize.set(4096, 4096);
// Lights reach layer 1 too, where the backdrop of neighbouring hexes is drawn.
for (const l of [hemi, rim, ...csm.lights]) l.layers.enableAll();
/** Give a lit material the cascades (after its own shader hooks, which it keeps). */
function csmMaterial(mat: THREE.Material) {
  if ((mat.defines as Record<string, unknown> | undefined)?.USE_CSM) return;
  const prev = mat.onBeforeCompile, key = mat.customProgramCacheKey?.bind(mat);
  csm.setupMaterial(mat);
  const hook = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { prev?.call(mat, sh, r); hook.call(mat, sh, r); };
  if (key) mat.customProgramCacheKey = key;
  cloudMaterial(mat);
  mat.needsUpdate = true;
}

/**
 * Shade under the plants (2026-11-06): a map over the whole tile of how much each spot is roofed
 * by crowns, splatted from the plants, so the ground darkens under a wood and at each trunk's
 * foot. It dims the sky's light there (not the sun's, which the shadows already handle).
 * 1.3-1.8 m a texel.
 */
const canopy = { tCanopy: { value: null as THREE.DataTexture | null }, uCanopyBox: { value: new THREE.Vector2(1, 1) } };
const CANOPY_RES = 1024;
function canopyMap(m: LocalMap): THREE.DataTexture {
  const R = CANOPY_RES, half = m.size / 2, tx = m.size / R, acc = new Float32Array(R * R);
  const T = m.trees;
  for (let i = 0; i < T.length; i += 6) {
    const sz = T[i + 3], k = T[i + 4];
    if (sz < 1.2 || isFlower(k) || k === H_FERN || k === TUFT || k === H_LILYPAD) continue;
    // Crowns about a third of the height across; the foot gets a tighter, darker spot.
    const rc = Math.max(0.8, sz * 0.22) / tx, cx = (T[i] + half) / tx, cy = (T[i + 1] + half) / tx;
    const wgt = Math.min(1, sz / 8);
    const r = Math.ceil(rc * 1.6), i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(R - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cy - r)), j1 = Math.min(R - 1, Math.ceil(cy + r));
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
      const d2 = ((ii + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2) / (rc * rc);
      if (d2 < 2.6) acc[j * R + ii] += wgt * (0.5 * Math.exp(-d2) + 0.5 * Math.exp(-d2 * 6));
    }
  }
  const data = new Uint8Array(R * R);
  for (let v = 0; v < R * R; v++) data[v] = Math.round(255 * (1 - Math.exp(-acc[v] * 1.1)));
  const t = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
const unitV = new THREE.Vector3();
/** Fit the cascades to the camera: the near ones by its height over the ground, so at eye level
 * the first covers the next ~40 m and from a drone ~100 m; from high up all is the last one. */
function fitShadows(cam: THREE.PerspectiveCamera) {
  if (!map) return;
  const k = style.atmosphere ? planetScale : 1;
  camera.updateMatrixWorld();
  const hAG = Math.max(1, camera.position.y - waterAt(camera.position.x, -camera.position.z));
  const dT = camera.position.distanceTo(controls.target);
  const farM = Math.min(camera.far, dT + map.size * 0.9);
  const b0 = Math.max(40, hAG * 3), b1 = b0 * 5;
  csmBreaks[0] = Math.min(1, b0 / farM); csmBreaks[1] = Math.min(1, b1 / farM); csmBreaks[2] = 1;
  csm.camera = cam;
  csm.maxFar = farM * k;
  csm.lightMargin = map.size * 0.6 * k;
  csm.lightDirection.copy(unitV.copy(sun.target.position).sub(sun.position).normalize());
  csm.updateFrustums();
  csm.update();
  for (let i = 0; i < 3; i++) {
    const L = csm.lights[i], sc = L.shadow.camera, w = sc.right - sc.left;
    L.color.copy(sun.color); L.intensity = sun.intensity;
    sc.near = 0; sc.far = csm.lightMargin + w * 2 + map.size * 0.5 * k; sc.updateProjectionMatrix();
    // About one texel and a half along the normal: no acne, and small things keep their shadows.
    L.shadow.normalBias = w / L.shadow.mapSize.x * 1.5;
    // An empty cascade (the camera is high) isn't drawn.
    L.shadow.autoUpdate = i === 2 || csmBreaks[i] > (i ? csmBreaks[i - 1] : 0) + 1e-4;
  }
}

// The planet's atmosphere, for the Earth style: the map is put back on the planet (planet radii,
// true size) and drawn through a camera that mirrors the orbit camera, so the planet's own sky,
// haze and reddened sunlight apply. Every material carries it; it is off in the other styles.
const atmo = new Atmosphere();
scene.add(atmo.sky);
atmo.sky.layers.enableAll();
applyAerial(treeMaterial, true);
applyAerial(packMaterial, true); applyAerial(packStill, true);
csmMaterial(treeMaterial); csmMaterial(packMaterial); csmMaterial(packStill);
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
let windLines: WindLines | null = null;
let grass: Grass | null = null;
let world = new THREE.Group();
scene.add(world);
let outline: THREE.Line | null = null;

/** The lake mask nearest (x, y) on the map. */
function layerNear(m: LocalMap, x: number, y: number): number {
  const { res, size } = m, step = size / (res - 1), half = size / 2;
  const i = Math.max(0, Math.min(res - 1, Math.round((x + half) / step))), j = Math.max(0, Math.min(res - 1, Math.round((y + half) / step)));
  return m.lakeMask[j * res + i];
}

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
    Object.assign(sh.uniforms, groundTex, canopy, shoreUniforms, { uWTime: waterUniforms.uWTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLPos; varying vec3 vLN; attribute vec3 grain; varying vec3 vGrain;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLPos = position; vLN = normal; vGrain = grain;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLPos; varying vec3 vLN; varying vec3 vGrain;
        uniform sampler2D tGrass, tGround, tRock;
        uniform vec3 uMeans;
        uniform float uTexAmt, uTexScale;
        uniform sampler2D tCanopy; uniform vec2 uCanopyBox;
        ${SHORE_GLSL}
        float gWet;
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
          // (vGrain: the ground's own soil and stone, from its patterns (desert, scree, gravel), and snow.)
          float det = mix(mix(g, d, max(soil * 0.5, vGrain.x)), r, max(steep, vGrain.y));
          diffuseColor.rgb *= mix(1.0, clamp(det, 0.4, 1.8), uTexAmt * (1.0 - 0.55 * vGrain.z));
        }
        {
          // Wet sand at the waterline, following the swell; light rippling over the shallow bed.
          vec3 nn = normalize(vLN);
          vec2 sw = shore(vLPos, length(nn.xz) / max(nn.y, 0.05));
          gWet = sw.x;
          sw.y *= 1.0 - smoothstep(0.25, 0.8, length(fwidth(vLPos.xz)));
          diffuseColor.rgb *= mix(1.0, 0.58, sw.x) * (1.0 + 0.7 * sw.y);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.32, gWet);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float occ = texture2D(tCanopy, vec2(vLPos.x + uCanopyBox.x, -vLPos.z + uCanopyBox.x) / uCanopyBox.y).r;
          reflectedLight.indirectDiffuse *= 1.0 - 0.62 * occ;
          // Leaf litter and dark soil under the crowns, warmer and browner than the grass around.
          reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, reflectedLight.directDiffuse * vec3(1.05, 0.82, 0.62), occ * 0.55);
          reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, reflectedLight.indirectDiffuse * vec3(1.05, 0.82, 0.62), occ * 0.55);
          reflectedLight.directDiffuse *= 1.0 - 0.18 * occ;
        }`);
    snowGround(sh);   // last: snow and the rock among it, per pixel (hexsnow.ts)
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
  snowContext(mat);   // snow out there lit as on the hex (hexsnow.ts)
  csmMaterial(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'context';
  mesh.layers.set(1);
  world.add(mesh);
  ctxMesh = mesh;
  if (hexFog) {
    // The ground the fog stands on: as drawn here (the tile's own near it), water at its surface.
    const tileR = reach;
    const fogGround = (x: number, y: number) => {
      const own = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, y) / tileR, 1.05, 1.25);
      let g = groundAtMap(c, x, y);
      if (own > 0) g += (groundAtMap(map!, x, y) - g) * own;
      return c.sea ? Math.max(g, 0) : g;
    };
    hexFog.set(c, map.localWidth, fogGround, [...gameSeen, map.cell]);
    world.add(hexFog.mesh);
  }

  // The occluder: every triangle outside the hex (inside, it would fight the tile's own ground).
  if (ctxOccluder) { world.remove(ctxOccluder); ctxOccluder.geometry.dispose(); (ctxOccluder.material as THREE.Material).dispose(); }
  const shape = hexShape(map), oidx: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    let cx = 0, cy = 0;
    for (let k = 0; k < 3; k++) { cx += pos[idx[t + k] * 3]; cy -= pos[idx[t + k] * 3 + 2]; }
    if (!shape.inside(cx / 3, cy / 3)) oidx.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const og = new THREE.BufferGeometry();
  // Sunk a little: triangles straddling the edge reach into the tile, and at the backdrop's own
  // height they hid the tile's water in triangular teeth along the edge (Bill, 2026-11-06: a
  // sawtooth on a coral reef). Lower, they still hide the skirt hanging under the edge.
  const opos = pos.slice();
  for (let v = 1; v < opos.length; v += 3) opos[v] -= 1.5;
  og.setAttribute('position', new THREE.BufferAttribute(opos, 3));
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
  // A grid square split in two, as triangles facing up. On the tile's slanted edges, squares with
  // corners pulled onto the edge fold over: the usual diagonal can give a flipped triangle, which is
  // culled, and flat water showed the gaps as a sawtooth (Bill, 2026-11-06). There, take the other
  // diagonal, and drop any triangle still flipped (it has no area on the tile).
  const area = (u: number, v: number, w: number) => (px[v] - px[u]) * (py[w] - py[u]) - (py[v] - py[u]) * (px[w] - px[u]);
  const split = (a: number, b: number, c: number, d: number): number[] => {
    if (!(out[a] || out[b] || out[c] || out[d])) return [a, b, c, b, d, c];
    let t = [[a, b, c], [b, d, c]];
    if (!(area(a, b, c) > 1e-6 && area(b, d, c) > 1e-6)) t = [[a, b, d], [a, d, c]];
    return t.filter(([u, v, w]) => area(u, v, w) > 1e-6).flat();
  };
  const idx: number[] = [];
  for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
    const a = j * res + i, b = a + 1, c = a + res, d = c + 1;
    if (out[a] && out[b] && out[c] && out[d]) continue;
    for (const u of split(a, b, c, d)) idx.push(u);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(paintGround(m, st), 3));
  tg.setAttribute('grain', new THREE.BufferAttribute(groundGrain(m), 3));
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
      // None under water: there the water's edge meets the backdrop's, and a skirt hanging below
      // the sea bed showed through it as dark teeth along the edge.
      const lakeAt = (x: number, y: number) => (!Number.isNaN(m.lakeLevel) && layerNear(m, x, y) > 0.3 ? m.lakeLevel : -Infinity);
      const wa = Math.max(m.sea ? 0 : -Infinity, lakeAt(ax, ay)), wb = Math.max(m.sea ? 0 : -Infinity, lakeAt(bx, by));
      if (ga < wa - 0.05 && gb < wb - 0.05) continue;
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
  // (hexwater.ts: coloured by the true depth under each pixel, ripples, surf, the sky reflected.)
  const waterMat = (river = false) => waterMaterial(W, river);
  shoreUniforms.uSeaLevel.value = m.sea ? 0 : -1e9;
  shoreUniforms.uLakeLevel.value = Number.isNaN(m.lakeLevel) ? -1e9 : m.lakeLevel;
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
      for (const u of split(q[0], q[1], q[2], q[3])) {
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
    const p = r.pts, k = p.length / 4, rp = new Float32Array(k * 9), rc = new Float32Array(k * 9), rf = new Float32Array(k * 9), ri: number[] = [];
    for (let s2 = 0; s2 < k; s2++) {
      const a = Math.max(0, s2 - 1), b = Math.min(k - 1, s2 + 1);
      let tx = p[b * 4] - p[a * 4], ty = p[b * 4 + 1] - p[a * 4 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      // Wider than the water, so its clear edge meets the banks rather than ending in a hard line.
      const w = p[s2 * 4 + 3], hw = w * 0.72, x = p[s2 * 4], y = p[s2 * 4 + 1], lv = p[s2 * 4 + 2] + 0.05;
      rp.set([x - ty * hw, lv, -(y + tx * hw), x, lv, -y, x + ty * hw, lv, -(y - tx * hw)], s2 * 9);
      const mid = tint(Math.max(0.6, Math.min(6, 0.12 * w)) * 2, new THREE.Color());
      const bank = tint(W.foamDepth * 0.85, new THREE.Color());
      const ro = r.rough[s2];
      mid.lerp(foam, ro * ro * 0.3); bank.lerp(foam, ro * ro * 0.3);
      rc.set([bank.r, bank.g, bank.b, mid.r, mid.g, mid.b, bank.r, bank.g, bank.b], s2 * 9);
      rf.set([tx, -ty, ro, tx, -ty, ro, tx, -ty, ro], s2 * 9);
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
    rg.setAttribute('flow', new THREE.BufferAttribute(rf, 3));
    rg.setIndex(ri);
    rg.computeVertexNormals();
    const mat = waterMat(true); mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(rg, mat); mesh.receiveShadow = true;
    world.add(mesh);
  }

  world.add(buildPlants(m, inFrame));
  canopy.tCanopy.value?.dispose();
  canopy.tCanopy.value = canopyMap(m);
  canopy.uCanopyBox.value.set(half, size);
  // The grass carpet (hexgrass.ts), from the ground as painted.
  grass?.dispose();
  const gf = grassField(m, tg.getAttribute('color').array as Float32Array, tg.getAttribute('grain').array as Float32Array,
    canopy.tCanopy.value.image.data as Uint8Array, CANOPY_RES, inFrame);
  grass = new Grass(gf, m);
  world.add(grass.group);
  // A cold open can beat the pack: draw with the planet's models, then swap once it is here.
  if (!pack) void fetchPack().then(() => { if (map === m) redrawPlants(); });

  // Houses where the history put towns: CC0 models (hexhouses.ts) or plain boxes.
  houseFrame = inFrame;
  drawHouses(m);

  // Wind lines drifting through the air (hexwind.ts).
  windLines?.dispose();
  windLines = new WindLines();
  world.add(windLines.mesh);

  // Bridges (2026-11-06): where a path comes down to a river on both banks, a timber bridge across.
  {
    const layerAt = (x: number, y: number, L: number) => {
      const i = Math.max(0, Math.min(res - 1, Math.round((x + half) / step))), j = Math.max(0, Math.min(res - 1, Math.round((y + half) / step)));
      return m.layers[(j * res + i) * LAYERS + L];
    };
    const spans: [number, number, number, number, number, number][] = [];   // x, y, angle, length, deck height, width
    for (const r of m.rivers) {
      const p = r.pts, k = p.length / 4;
      for (let s2 = 1; s2 < k - 1; s2++) {
        const x = p[s2 * 4], y = p[s2 * 4 + 1], lv = p[s2 * 4 + 2], w = p[s2 * 4 + 3];
        if (w > 40 || !inFrame(x, y)) continue;
        let tx = p[s2 * 4 + 4] - p[s2 * 4 - 4], ty = p[s2 * 4 + 5] - p[s2 * 4 - 3];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty, ny = tx, reach = w * 0.5 + 4;
        // A path on both banks, within a few metres of the water.
        let pa = 0, pb = 0;
        for (let d = w * 0.5; d < w * 0.5 + 10; d += 1.5) { pa = Math.max(pa, layerAt(x + nx * d, y + ny * d, L_PATH)); pb = Math.max(pb, layerAt(x - nx * d, y - ny * d, L_PATH)); }
        if (pa < 0.4 || pb < 0.4) continue;
        const ax = x + nx * reach, ay = y + ny * reach, bx = x - nx * reach, by = y - ny * reach;
        if (spans.some((q) => Math.hypot(q[0] - x, q[1] - y) < 30)) continue;
        const ga = groundAtMap(m, ax, ay), gb = groundAtMap(m, bx, by);
        let top = lv;
        for (let o = Math.max(0, s2 - 4); o <= Math.min(k - 1, s2 + 4); o++) top = Math.max(top, p[o * 4 + 2]);
        spans.push([x, y, Math.atan2(ny, nx), reach * 2 + 2, Math.max(top + 1.2, (ga + gb) / 2 + 0.3), 3.6]);
      }
    }
    if (spans.length) {
      const box = new THREE.BoxGeometry(1, 1, 1);
      const parts: [number, number, number, number, number, number, number][] = [];   // cx, cy, h, along, across, thick, angle
      for (const [x, y, ang, len, hgt, wd] of spans) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        parts.push([x, y, hgt, len, wd, 0.35, ang]);                         // the deck
        for (const sd of [-1, 1]) {
          const ox = -sa * wd * 0.46 * sd, oy = ca * wd * 0.46 * sd;
          parts.push([x + ox, y + oy, hgt + 0.95, len, 0.12, 0.12, ang]);    // a rail
          for (let t = -0.5; t <= 0.501; t += 1 / Math.max(2, Math.round(len / 3))) {
            parts.push([x + ox + ca * len * t, y + oy + sa * len * t, hgt + 0.5, 0.16, 0.16, 0.9, ang]);   // posts
          }
        }
        // Piers into the water, under each end of the channel.
        for (const t of [-0.25, 0.25]) {
          const px2 = x + ca * len * t, py2 = y + sa * len * t, g = groundAtMap(m, px2, py2);
          parts.push([px2, py2, (hgt + g) / 2 - 0.5, 0.6, wd * 0.9, Math.max(0.5, hgt - g + 1), ang]);
        }
      }
      const im = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 }), parts.length);
      const bm = new THREE.Matrix4(), bq = new THREE.Quaternion(), bs = new THREE.Vector3(), bp = new THREE.Vector3(), yAx = new THREE.Vector3(0, 1, 0);
      const shade = new THREE.Color();
      parts.forEach(([cx, cy, hh, al, ac, th, ang], n) => {
        // (Map angle is from east toward north; three.js turns the other way about y.)
        bq.setFromAxisAngle(yAx, ang);
        im.setMatrixAt(n, bm.compose(bp.set(cx, hh, -cy), bq, bs.set(al, th, ac)));
        im.setColorAt(n, shade.setHex(0x8a6a48).multiplyScalar(0.8 + 0.4 * (((n * 2654435761) >>> 0) / 4294967296)));
      });
      im.castShadow = true; im.receiveShadow = true; im.name = 'bridges';
      world.add(im);
    }
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
    if (!mesh.isMesh || o.name === 'plants' || o.name === 'sides' || o.name === 'windows' || o.name === 'occluder' || o.name === 'ctxlines' || o.name === 'windlines' || o.name === 'house-models') return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) applyAerial(mat, true);
  });
  world.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.name === 'house-models') return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (!(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(mat as THREE.ShaderMaterial).isShaderMaterial) csmMaterial(mat);
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
  world.updateMatrixWorld(true);
  clouds.uToMap.value.copy(world.matrixWorld).invert();
  waterUniforms.uUpW.value.set(0, 1, 0).transformDirection(world.matrixWorld);
  waterUniforms.uMapRot.value.setFromMatrix4(new THREE.Matrix4().extractRotation(world.matrixWorld));
  applyLook(m);
}

/** Crown width over height of Mundi's own model for a plant kind. */
const refWidths = new Map<number, number>();
function refWidth(kind: number): number {
  let w = refWidths.get(kind);
  if (w === undefined) {
    const g = treeGeometry(kind); g.computeBoundingBox();
    const b = g.boundingBox!;
    w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / Math.max(1e-3, b.max.y - b.min.y);
    refWidths.set(kind, w);
  }
  return w;
}

/**
 * The plants, life-size: the pack's models (hexplants.ts) where it has one for the kind, else the
 * planet's own (flora.ts), one instanced mesh per model.
 */
let houseFrame: (x: number, y: number) => boolean = () => true;
/** The towns' buildings, in their own group so the Houses setting can swap them without a rebuild.
 * Plain: walls and a pitched roof, instanced, in the style's colours; scaled up a little in the
 * stylised looks, like the trees. Otherwise the CC0 models, once their pack is in (until then the
 * boxes stand in). Lit windows and a glow over lit houses at night either way. */
function drawHouses(m: LocalMap) {
  if (housesGroup) {
    world.remove(housesGroup);
    housesGroup.traverse((o) => { const im = o as THREE.InstancedMesh; if (im.isInstancedMesh) { im.dispose(); if (o.name === 'house-models') { im.geometry.dispose(); (im.material as THREE.Material).dispose(); } } });
  }
  windows = null; glow = null;
  const group = new THREE.Group();
  housesGroup = group;
  world.add(group);
  const inFrame = houseFrame, st = style;
  const models = houseMode !== 'plain' && housePack;
  if (houseMode !== 'plain' && !housePack) void loadHouses().then((p) => { housePack = p; if (map === m) drawHouses(m); });
  const HS = m.houses, nh = HS.length / HOUSE_STRIDE;
  if (models && nh) {
    const bs: Building[] = [];
    for (let k = 0; k < nh; k++) {
      const o = k * HOUSE_STRIDE;
      if (!inFrame(HS[o], HS[o + 1])) continue;
      bs.push({ x: HS[o], y: HS[o + 1], gy: HS[o + 2], rot: HS[o + 3], wd: HS[o + 4], dp: HS[o + 5], ch: HS[o + 7], kind: HS[o + 8], culture: HS[o + 9] });
    }
    // One new material for this drawing, given the atmosphere and the shadows once, here (the
    // build's own passes skip the house models).
    const mat = houseMaterial();
    applyAerial(mat, true);
    csmMaterial(mat);
    group.add(buildHouses(housePack!, houseMode, bs, st.town.scale, mat));
    if (m.props?.length) group.add(buildProps(housePack!, m.props, PROP_STRIDE, inFrame, mat));
    // The glow over lit houses, as for the boxes.
    const K = st.town.scale;
    const lit = bs.filter((b) => (b.ch * 7.31) % 1 < 0.75);
    const gp = new Float32Array(lit.length * 3);
    lit.forEach((b, n) => { gp[n * 3] = b.x; gp[n * 3 + 1] = b.gy + 4 * K; gp[n * 3 + 2] = -b.y; });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    glow = new THREE.Points(gg, new THREE.PointsMaterial({ map: glowTex, size: 45 * K, color: 0xff9440, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.name = 'glow';
    group.add(glow);
    applyTime();
    return;
  }
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
    for (const im of [walls, roofs, chims]) { im.castShadow = true; im.receiveShadow = true; group.add(im); }
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
    group.add(win);
    const gp = new Float32Array(lit.length * 3);
    lit.forEach((k, n) => {
      const o = k * HOUSE_STRIDE;
      gp[n * 3] = HS[o]; gp[n * 3 + 1] = HS[o + 2] + HS[o + 6] * K * 0.6; gp[n * 3 + 2] = -HS[o + 1];
    });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    glow = new THREE.Points(gg, new THREE.PointsMaterial({ map: glowTex, size: 45 * K, color: 0xff9440, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.name = 'glow';
    group.add(glow);
  }

  applyTime();
}

function buildPlants(m: LocalMap, inFrame: (x: number, y: number) => boolean): THREE.Group {
  const st = style, group = new THREE.Group();
  group.name = 'plantgroup';
  packPlants?.dispose(); packPlants = null;
  const usePack = !!pack;
  const { res, size, layers } = m, half = size / 2, step = size / (res - 1);
  const layerAt = (x: number, y: number, L: number) => {
    const i = Math.max(0, Math.min(res - 1, Math.round((x + half) / step))), j = Math.max(0, Math.min(res - 1, Math.round((y + half) / step)));
    return layers[(j * res + i) * LAYERS + L];
  };
  const T = m.trees, STRIDE = 6, count = T.length / STRIDE;
  const byKind = new Map<number, number[]>();
  const byModel = new Map<string, { mtx: number[]; col: number[]; nearOnly?: boolean }>();
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc3 = new THREE.Vector3(), ps = new THREE.Vector3(), pc = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const tilt = new THREE.Quaternion(), tAxis = new THREE.Vector3();
  const place = (i: number) => {
    const sz = T[i * STRIDE + 3], jit = ((i * 2654435761) >>> 0) / 4294967296;
    q.setFromAxisAngle(up, jit * Math.PI * 2);
    // No two quite upright (2026-11-06): a lean of up to ~4 degrees, and on a slope a little more,
    // downhill, as trees on a bank do. (Small things: more; they sit in the ground's tilt.)
    {
      const x = T[i * STRIDE], y = T[i * STRIDE + 1], e = 2;
      const gx = (groundAtMap(m, x + e, y) - groundAtMap(m, x - e, y)) / (2 * e), gy = (groundAtMap(m, x, y + e) - groundAtMap(m, x, y - e)) / (2 * e);
      const j2 = ((i * 2246822519) >>> 0) / 4294967296, j3 = ((i * 3266489917) >>> 0) / 4294967296;
      const small = sz < 2.5 ? 1 : 0;
      // A lean: random, plus downhill (in three.js axes, map y is -z).
      let lx = (j2 - 0.5) * 0.14 - gx * (0.18 + 0.4 * small), lz = (j3 - 0.5) * 0.14 + gy * (0.18 + 0.4 * small);
      const L = Math.hypot(lx, lz), cap = small ? 0.45 : 0.14;
      if (L > cap) { lx *= cap / L; lz *= cap / L; }
      if (L > 1e-4) {
        // Tilt the up axis toward (lx, 1, lz): about the horizontal axis across it.
        tAxis.set(lz, 0, -lx).normalize();
        tilt.setFromAxisAngle(tAxis, Math.atan(Math.min(L, cap)));
        q.premultiply(tilt);
      }
    }
    sc3.setScalar(sz * st.plants.scale);
    ps.set(T[i * STRIDE], T[i * STRIDE + 2] - 0.04 * sz * st.plants.scale, -T[i * STRIDE + 1]);
    mtx.compose(ps, q, sc3);
    pc.setHex(T[i * STRIDE + 5]);
    const l = 0.2126 * pc.r + 0.7152 * pc.g + 0.0722 * pc.b;
    pc.setRGB((l + (pc.r - l) * st.plants.sat) * st.plants.bright, (l + (pc.g - l) * st.plants.sat) * st.plants.bright, (l + (pc.b - l) * st.plants.sat) * st.plants.bright);
    // Each its own shade: a little lighter or darker, a little yellower or bluer.
    const vb = 0.86 + 0.28 * (((i * 1597334677) >>> 0) / 4294967296), vh = (((i * 3812015801) >>> 0) / 4294967296 - 0.5) * 0.12;
    pc.setRGB(pc.r * vb * (1 + vh), pc.g * vb, pc.b * vb * (1 - vh));
  };
  for (let i = 0; i < count; i++) {
    const x = T[i * STRIDE], y = T[i * STRIDE + 1];
    if (!inFrame(x, y)) continue;
    if (st.plants.keep < 1 && ((i * 2246822519) >>> 0) / 4294967296 > st.plants.keep) continue;
    const k = T[i * STRIDE + 4];
    const name = usePack ? packModel(pack!, k, i, layerAt(x, y, L_SNOW), Math.max(layerAt(x, y, L_LUSH), layerAt(x, y, L_FOREST))) : null;
    if (name) {
      place(i);
      // Pack crowns are wider for their height than Mundi's: shrink them to its footprint, so a
      // forest keeps its gaps and its mix (wide oaks swallowed the pines).
      // (The hex's own kinds have no planet model to match; logs and lilies are sized by length.)
      const w = pack!.index.models[name].w;
      if (k === H_LOG || k === H_LILYPAD) mtx.scale(sc3.setScalar(1 / w));
      else if (!isHexKind(k)) {
        const f = Math.max(0.55, Math.min(1, refWidth(k) / w));
        // Conifers keep their height (they stand over the broadleaf canopy) and only narrow a little.
        if (f < 1) mtx.scale(name.startsWith('Pine') ? sc3.set(Math.sqrt(f), 1, Math.sqrt(f)) : sc3.setScalar(f));
      }
      if (!byModel.has(name)) byModel.set(name, { mtx: [], col: [], nearOnly: isFlower(k) || k === H_FERN || k === H_STUMP });
      const d = byModel.get(name)!;
      for (let e = 0; e < 16; e++) d.mtx.push(mtx.elements[e]);
      d.col.push(pc.r, pc.g, pc.b);
      continue;
    }
    if (isHexKind(k)) continue;   // (the pack's alone: until it loads, or where it has none)
    // Cold tufts (the pack has no snowy grass): the grass carpet stands in; the planet's own tuft
    // model, life-size, was a black slab up close.
    if (k === TUFT && usePack) continue;
    // Grass tufts and reeds are too fine for the stylised looks: scribbles at this distance.
    if (!st.plants.tufts && (k === TUFT || (k >= FIRST && FAMILIES[Math.floor((k - FIRST) / VARIANTS)] === 'reeds'))) continue;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(i);
  }
  for (const [kind, list] of byKind) {
    const mesh = new THREE.InstancedMesh(treeGeometry(kind), treeMaterial, list.length);
    list.forEach((i, k) => { place(i); mesh.setMatrixAt(k, mtx); mesh.setColorAt(k, pc); });
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'plants';
    group.add(mesh);
  }
  // Hedgerows (2026-11-06): bushes along the fields' edges, now and then a tree standing in them.
  if (usePack) {
    const H = st.town.hedge, hc = new THREE.Color(H);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const v = j * res + i;
      if (layers[v * LAYERS + L_HEDGE] < 0.75 || layers[v * LAYERS + L_FIELD] < 0.5) continue;
      const r = (((v * 2654435761) >>> 0) / 4294967296), r2 = (((v * 2246822519) >>> 0) / 4294967296);
      if (r > 0.62) continue;
      const x = -half + i * step + (r2 - 0.5) * step * 0.6, y = -half + j * step + (r - 0.3) * step * 0.6;
      if (!inFrame(x, y)) continue;
      const tree = r2 < 0.035;
      const set = pack!.index.sets[tree ? 'broadleaf' : r2 < 0.2 ? 'bushBerries' : 'bush'];
      const name = set[Math.floor(r * 97) % set.length];
      const sz = tree ? 8 + 5 * r : 1.6 + 1.2 * ((r2 * 7) % 1);
      q.setFromAxisAngle(up, r * 40);
      mtx.compose(ps.set(x, groundAtMap(m, x, y) - 0.1, -y), q, sc3.setScalar(sz * st.plants.scale * (tree ? 1 : 0.9)));
      const w = pack!.index.models[name].w;
      if (tree && w > 0.7) mtx.scale(sc3.setScalar(0.7 / w));
      const vb = 0.85 + 0.3 * r2;
      pc.setRGB(hc.r * 1.5 * vb, hc.g * 1.5 * vb, hc.b * 1.5 * vb);
      if (!byModel.has(name)) byModel.set(name, { mtx: [], col: [] });
      const d = byModel.get(name)!;
      for (let e = 0; e < 16; e++) d.mtx.push(mtx.elements[e]);
      d.col.push(pc.r, pc.g, pc.b);
    }
  }
  if (byModel.size) {
    packPlants = new PackPlants(pack!, byModel, NEAR_M);
    group.add(packPlants.group);
  }
  return group;
}

/** Redraw the plants alone. */
function redrawPlants() {
  if (!map) return;
  const old = world.getObjectByName('plantgroup');
  if (old) { world.remove(old); dispose(old); }
  const st = style, shape = hexShape(map), half = map.size / 2;
  const inFrame = (x: number, y: number) => (st.frame === 'hex' ? shape.inside(x, y) : Math.abs(x) <= half && Math.abs(y) <= half);
  world.add(buildPlants(map, inFrame));
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
  // A cool fill from opposite the sun (2026-11-06): the sky's light on the shaded side, so the
  // shade of a wall, a trunk or a wood reads blue-grey, not black. (?fill=0 to compare.)
  rim.intensity = Math.max(L.rim, fillK * L.key.intensity * Math.min(1, Math.max(0, L.elev / 8)));
  rim.position.set(-sun.position.x, size * 0.3, -sun.position.z);
  // The planet's atmosphere already brightens low-sun skies; adapting fully washes them out.
  renderer.toneMappingExposure = st.atmosphere ? Math.min(L.exposure, st.exposure * (st.paintedSky ? 3 : 1.5)) : L.exposure;
  gradePass.uniforms.uTint.value = L.tint;
  waterUniforms.uSkyTop.value.setRGB(L.sky[0][0], L.sky[0][1], L.sky[0][2]);
  waterUniforms.uSkyHor.value.setRGB(L.sky[1][0], L.sky[1][1], L.sky[1][2]);
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
  houseNight.value = L.windows;
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
{
  // Houses: which buildings stand in the towns (no rebuild: only the buildings are redrawn).
  const sel = document.createElement('select');
  sel.id = 'houses';
  for (const [k, label] of HOUSE_MODES) sel.add(new Option(label, k));
  sel.value = houseMode;
  sel.onchange = () => { houseMode = sel.value as HouseMode; if (map) drawHouses(map); writeHash(); };
  const row = document.createElement('label');
  row.className = 'row';
  row.append('Houses ', sel, document.createElement('span'));
  $('res').closest('label')?.before(row);
}

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
  if (houseMode !== 'people') o.set('houses', houseMode);
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
/**
 * A picture of a hex for the planet's card (main.ts, hexcard.ts), from its own starting view:
 * builds it here, hidden (so opening it next is quick), waits for the neighbours round it, draws
 * one frame and sends it back as a JPEG. The camera is put back if the hex was already on show.
 */
let snapWant = '';
function snapshot(hash: string) {
  const was = JSON.stringify(params) + cell + opts.radiusKm;
  applyHash(hash);
  const c = cell, same = !!map && !busy && JSON.stringify(params) + cell + opts.radiusKm === was;
  snapWant = hash;
  if (!same) { world.visible = false; ctxMap = null; firstBuild = true; request(); }
  const t0 = performance.now();
  const tryShoot = () => {
    if (snapWant !== hash) return;
    const waited = performance.now() - t0;
    if (!(map && !busy && map.cell === c && world.visible && (ctxMesh || !showCtx || waited > 4000))) {
      if (waited < 30000) setTimeout(tryShoot, 120);
      return;
    }
    snapWant = '';
    const p = camera.position.clone(), t = controls.target.clone();
    resetView();
    // Two frames: the shadows and the sky settle on the first.
    loop(); loop();
    const src = renderer.domElement, W = 640, H = 400;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    let sw = src.width, sh = src.height;
    if (sw / sh > W / H) sw = sh * W / H; else sh = sw * H / W;
    cv.getContext('2d')!.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, W, H);
    if (same) { camera.position.copy(p); controls.target.copy(t); controls.snap(); }
    parent.postMessage({ type: 'mundi-hex-snapshot', hash, url: cv.toDataURL('image/jpeg', 0.82) }, location.origin);
  };
  tryShoot();
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
  const tb = performance.now();
  build(m);
  const drawMs = performance.now() - tb;
  drawInset(m); facts(m);
  if (game) setupCaravan(m);
  if (rel) { camera.position.copy(rel.p.multiplyScalar(m.size)); controls.target.copy(rel.t.multiplyScalar(m.size)); controls.snap(); }
  else resetView();
  firstBuild = false;
  if (game) arriveCaravan();
  $('timing').textContent = `world ${Math.round(e.data.ms.world)} ms · hex ${Math.round(e.data.ms.local)} ms${(e.data as { prebuilt?: boolean }).prebuilt ? ' (prebuilt)' : ''} · draw ${Math.round(drawMs)} ms · ${(m.trees.length / 6).toLocaleString()} plants`;
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
  // Zoom: out to the whole hex with its neighbours round it, in to a few metres off the ground.
  // (Bill, 2026-11-06: farthest out closer in than the first try at 1.15 × the fit; the starting
  // view is the farthest out.)
  controls.maxDistance = fit * 0.8;
  controls.minDistance = 4;
  controls.bound = map.localWidth * 0.55;
  controls.target.set(0, g, 0);
  camera.position.set(0, g + Math.cos(t) * fit * 0.8, Math.sin(t) * fit * 0.8);
  controls.snap();
  tiltH.uniforms.uFocus.value = tiltV.uniforms.uFocus.value = 0.5;
}
$('reset').onclick = resetView;

// --- Primundi: the caravan, moved by tapping (primundi/hexcaravan.ts) ---
// Tap the ground and the leader walks there; tap a town building or its label and they walk to its
// door, and the game opens that part of the town. The camera follows the walk until it's moved.
let nav: Nav | null = null, navMap: LocalMap | null = null;
let caravan: Caravan | null = null;
let spots: TownSpot[] = [];
let followFrom = 0;
let arrival: (() => void) | null = null;
const spotLayer = document.createElement('div');
spotLayer.id = 'spots';
if (game) {
  document.body.appendChild(spotLayer);
  const css = document.createElement('style');
  css.textContent = `#spots { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
    #spots button { position: absolute; left: 0; top: 0; pointer-events: auto; min-height: 44px; min-width: 44px;
      padding: 0 14px; border-radius: 20px; border: 1px solid rgba(242, 193, 78, 0.55); background: rgba(22, 20, 16, 0.72); color: #f4ead2;
      font: 600 14px/38px system-ui, sans-serif; letter-spacing: 0.02em; white-space: nowrap; cursor: pointer; backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px); box-shadow: 0 2px 10px rgba(0,0,0,0.35); transition: opacity 0.25s, background 0.2s; touch-action: manipulation; }
    #spots button::after { content: ''; position: absolute; left: 50%; bottom: -7px; margin-left: -6px; border: 6px solid transparent; border-bottom: 0; border-top-color: rgba(22, 20, 16, 0.72); }
    #spots button:hover, #spots button.going { background: rgba(120, 84, 24, 0.85); }
    #spots button.far { opacity: 0; pointer-events: none; }
    body.walking #spots { display: none; }`;
  document.head.appendChild(css);
}
/** The map's walking grid, made when first needed. */
function navFor(m: LocalMap): Nav {
  if (nav && navMap === m) return nav;
  const { res, size, layers } = m, step = size / (res - 1), half = size / 2;
  const at = (x: number, y: number) => Math.max(0, Math.min(res - 1, Math.round((y + half) / step))) * res + Math.max(0, Math.min(res - 1, Math.round((x + half) / step)));
  const shape = hexShape(m);
  nav = new Nav({
    houses: m.houses, props: m.props ?? new Float32Array(0), K: houseMode === 'plain' ? 1 : style.town.scale, hex: m.hex,
    inside: (x, y) => shape.inside(x, y),
    ground: (x, y) => groundAtMap(m, x, y),
    water: (x, y) => {
      const g = groundAtMap(m, x, y);
      if (m.sea && g < 0.25) return 2;
      if (!Number.isNaN(m.lakeLevel) && layerNear(m, x, y) > 0.3 && g < m.lakeLevel + 0.2) return 2;
      return layers[at(x, y) * LAYERS + L_DEPTH] > 0.3 ? 1 : 0;
    },
    path: (x, y) => Math.min(1, layers[at(x, y) * LAYERS + L_PATH]),
    wood: (x, y) => Math.min(1, layers[at(x, y) * LAYERS + L_FOREST]),
  });
  navMap = m;
  return nav;
}
/** The view's atmosphere and shadows on materials added after a build (the caravan's, the finds'),
 * once each: adding them twice breaks a shader (see houseMaterial). */
function dress(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of [mesh.material].flat()) {
      if (mat.userData.dressed || (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial || (mat as THREE.ShaderMaterial).isShaderMaterial) continue;
      mat.userData.dressed = true;
      applyAerial(mat, true); csmMaterial(mat);
    }
  });
}
function setupCaravan(m: LocalMap) {
  nav = null;
  const K = houseMode === 'plain' ? 1 : style.town.scale;
  const cartName = housePack?.index.props.find((n) => n.endsWith('/Cart'));
  caravan = new Caravan((x, y) => groundAtMap(m, x, y), K, cartName ? housePack!.geos.get(cartName)!.clone() : null);
  world.add(caravan.group);
  // (In the looks drawn on the planet the map's group is scaled down to planet units, which would
  // shrink the marker that keeps its size on screen.)
  world.updateMatrixWorld(true);
  caravan.markerScale(1 / world.matrixWorld.getMaxScaleOnAxis());
  if (!cartName) {
    const c = caravan;
    void loadHouses().then((p) => { const n = p.index.props.find((k) => k.endsWith('/Cart')); if (n && caravan === c) { c.setCart(p.geos.get(n)!.clone()); dress(c.group); } });
  }
  const n = navFor(m);
  spots = [];
  if (gameTown) {
    // What the landmark is (a market, an inn...), by the family it's drawn in.
    const lm = townLandmark(m.houses);
    const landmark = lm >= 0 && houseMode !== 'plain' ? LANDMARKS[familyOf(houseMode, m.houses[lm + 9])][Math.min(2, m.houses[lm + 8] - 1)] : null;
    const t = townSpots(m.houses, m.props ?? new Float32Array(0), K, gameTown === 'home', landmark, (x, y) => groundAtMap(m, x, y), (x, y) => n.ok(x, y));
    spots = t.spots;
    if (t.board) {
      const [bx, by, br] = t.board, b = noticeBoard(K);
      b.position.set(bx, groundAtMap(m, bx, by) - 0.05, -by);
      b.rotation.y = br;
      caravan.group.add(b);
      n.block(bx, by, br, 2.2 * K, 0.8 * K);
    }
  }
  placeFinds(m, n, K);
  placeFolk(m, n, K, cartName ? housePack!.geos.get(cartName)! : null);
  dress(caravan.group);
  spotLayer.replaceChildren(...spots.map((s, n) => {
    const b = document.createElement('button');
    b.textContent = s.label;
    b.dataset.n = String(n);
    b.onclick = (e) => { e.stopPropagation(); goSpot(s); };
    return b;
  }));
  // Where they come in: from the side of the hex they came from (or the south), out at the edge of
  // the town, walking in to its square. Out in the country: the middle.
  let dx = 0, dy = -1;
  const fi = gameFrom >= 0 ? Array.from(m.cells).indexOf(gameFrom) : -1;
  if (fi >= 0) { const fx = m.cellXY[fi * 2], fy = m.cellXY[fi * 2 + 1], l = Math.hypot(fx, fy) || 1; dx = fx / l; dy = fy / l; }
  const sq = spots.find((s) => s.tab === 'work');
  if (sq) {
    const [sx, sy] = sq.centre;
    let far = 30;
    for (let o = 0; o < m.houses.length; o += HOUSE_STRIDE) { const d = Math.hypot(m.houses[o] - sx, m.houses[o + 1] - sy); if (d < 260) far = Math.max(far, d); }
    const v = n.nearest(sx + dx * (far * 0.8 + 15), sy + dy * (far * 0.8 + 15), 80);
    const [x, y] = v >= 0 ? n.xy(v) : [sx + dx * 40, sy + dy * 40];
    caravan.place(x, y, Math.atan2(-dx, dy));
    arrival = () => {
      controls.glideTo(x, -y, 70 * K);
      const p = n.find(x, y, sx + dx * 16, sy + dy * 16);
      if (p) { followFrom = performance.now(); caravan!.walk(p); }
    };
  } else {
    const v = n.nearest(0, 0, 200);
    const [x, y] = v >= 0 ? n.xy(v) : [0, 0];
    caravan.place(x, y, Math.atan2(-dx, dy));
    arrival = null;
  }
}
const FIND_LABELS: Record<string, string> = { lookout: 'Lookout', spring: 'Spring', forage: 'Foraging', ruin: 'Ruins', camp: 'Old camp' };
/** The hex's finds (finds.ts) on the ground: a lookout on the high point, a spring in a hollow,
 * foraging where it's wooded, ruins and old camps out in the country. Where is the same every visit. */
/** Primundi: others on the road, walking it back and forth through the middle of the hex. */
interface Folk { id: string; c: Caravan; path: [number, number][]; fwd: boolean; waiting: boolean; still: boolean }
let walkers: Folk[] = [];
const FOLK_CLOAK: Record<string, number> = { traders: 0x2f5d7c, pilgrims: 0xd8cfae, broken: 0x5d6b3a };
function folkWalk(f: Folk) {
  if (f.still || f.waiting) return;
  const p = f.fwd ? f.path : [...f.path].reverse();
  f.fwd = !f.fwd;
  f.c.walk(p, () => folkWalk(f));
}
function placeFolk(m: LocalMap, n: Nav, K: number, cartGeo: THREE.BufferGeometry | null) {
  walkers = [];
  if (!gameFolk.length || !caravan) return;
  const rng = makeRng((m.cell * 374761393 + 668265263) >>> 0);
  const R = Math.min(1500, m.localWidth * 0.25);
  for (const entry of gameFolk) {
    const [kind, id] = entry.split('~');
    // A way across the middle (the walk grid keeps to roads and tracks where there are any).
    let path: [number, number][] | null = null;
    for (let k = 0; k < 6 && !path; k++) {
      const a = rng() * Math.PI * 2;
      path = n.find(Math.cos(a) * R, Math.sin(a) * R, -Math.cos(a) * R, -Math.sin(a) * R);
    }
    if (!path || path.length < 2) continue;
    const c = new Caravan((x, y) => groundAtMap(m, x, y), K, cartGeo ? cartGeo.clone() : null, { cloak: FOLK_CLOAK[kind] ?? 0x2f5d7c, guide: false, pace: 1.6 * K });
    caravan.group.add(c.group);
    // Somewhere along it, not on top of the player.
    const start = Math.floor(path.length * (0.2 + rng() * 0.25));
    const [x, y] = path[start];
    c.place(x, y, rng() * Math.PI * 2);
    const f: Folk = { id, c, path: path.slice(start), fwd: true, waiting: false, still: kind === 'broken' };
    walkers.push(f);
    folkWalk(f);
    spots.push({ tab: '', label: FOLK_LABEL[kind as FolkKind] ?? 'Someone', door: [x, y], top: [x, y, groundAtMap(m, x, y) + 3 * K], centre: [x, y], radius: 2 * K,
      find: 'folk', folk: id, seen: true, used: false, obj: c.group });
  }
}
function placeFinds(m: LocalMap, n: Nav, K: number) {
  if (!gameFinds.length && !gameJobs.length) return;
  const rng = makeRng((m.cell * 2246822519 + 3266489917) >>> 0);
  const { res, size, layers } = m, step = size / (res - 1), half = size / 2;
  const wood = (x: number, y: number) => layers[(Math.max(0, Math.min(res - 1, Math.round((y + half) / step))) * res + Math.max(0, Math.min(res - 1, Math.round((x + half) / step)))) * LAYERS + L_FOREST];
  const R0 = m.localWidth * 0.5;
  // Away from the town, if there is one, and from each other.
  const lm = townLandmark(m.houses);
  const town: [number, number, number] | null = lm >= 0 && gameTown ? [m.houses[lm], m.houses[lm + 1], 140] : null;
  const taken: [number, number][] = [];
  const clear = (x: number, y: number) => n.ok(x, y) && (!town || Math.hypot(x - town[0], y - town[1]) > town[2]) && taken.every(([a, b]) => Math.hypot(x - a, y - b) > 110);
  const samples = (count: number, lo: number, hi: number) => {
    const out: [number, number][] = [];
    for (let k = 0; k < count * 4 && out.length < count; k++) {
      const a = rng() * Math.PI * 2, r = (lo + (hi - lo) * Math.sqrt(rng())) * R0;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (clear(x, y)) out.push([x, y]);
    }
    return out;
  };
  // A job's camp or site: out in the country, known from the start (you were told roughly where).
  for (const j of gameJobs) {
    const [kind, id] = j.split('~');
    const at = samples(1, 0.35, 0.8)[0];
    if (!at) continue;
    const [x, y] = at;
    taken.push(at);
    const obj = findModel(kind === 'bounty' ? 'camp' : 'ruin', K, m.cell * 7 + id.length);
    if (kind === 'bounty') obj.add(banner());
    obj.position.set(x, groundAtMap(m, x, y) - 0.05, -y);
    obj.rotation.y = rng() * Math.PI * 2;
    caravan!.group.add(obj);
    n.block(x, y, 0, 3 * K, 3 * K);
    spots.push({ tab: '', label: kind === 'bounty' ? 'Their camp' : 'The old site', door: [x, y - 3 * K], top: [x, y, groundAtMap(m, x, y) + 4 * K], centre: [x, y], radius: 2.5 * K,
      find: 'job', job: id, seen: true, used: false, obj });
  }
  for (const kind of gameFinds) {
    let at: [number, number] | null = null;
    if (kind === 'lookout') {
      let best = -Infinity;
      for (const [x, y] of samples(260, 0.05, 0.85)) { const g = groundAtMap(m, x, y); if (g > best) { best = g; at = [x, y]; } }
    } else if (kind === 'spring') {
      let best = Infinity;
      for (const [x, y] of samples(120, 0.2, 0.8)) { const g = groundAtMap(m, x, y) + rng() * 4; if (g < best) { best = g; at = [x, y]; } }
    } else if (kind === 'forage') {
      let best = -1;
      for (const [x, y] of samples(80, 0.15, 0.8)) { const v = wood(x, y) + rng() * 0.3; if (v > best) { best = v; at = [x, y]; } }
    } else at = samples(1, 0.3, 0.85)[0] ?? null;
    if (!at) continue;
    const [x, y] = at;
    taken.push(at);
    const obj = findModel(kind, K, m.cell * 31 + kind.length);
    obj.position.set(x, groundAtMap(m, x, y) - 0.05, -y);
    obj.rotation.y = rng() * Math.PI * 2;
    const seen = kind === 'lookout';
    obj.visible = seen;
    caravan!.group.add(obj);
    n.block(x, y, 0, 3 * K, 3 * K);
    const tall = kind === 'lookout' ? 6.5 : kind === 'ruin' ? 3.5 : 2.5;
    spots.push({ tab: '', label: FIND_LABELS[kind] ?? kind, door: [x, y - 3 * K], top: [x, y, groundAtMap(m, x, y) + tall * K], centre: [x, y], radius: 2.5 * K,
      find: kind, seen, used: gameUsed.has(kind), obj });
  }
}
/** A ragged banner on a pole, for a band's camp. */
function banner(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.6, 5), new THREE.MeshStandardMaterial({ color: 0x3a2a1c, flatShading: true }));
  pole.position.set(1.2, 1.8, 1.2);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshStandardMaterial({ color: 0x5a1c1c, side: THREE.DoubleSide, flatShading: true }));
  cloth.position.set(1.75, 3.1, 1.2);
  for (const o of [pole, cloth]) { o.castShadow = true; g.add(o); }
  return g;
}
/** Once the view has settled on a new hex: the walk in. */
function arriveCaravan() {
  const f = arrival; arrival = null;
  if (f) setTimeout(f, 400);
}
function goTo(x: number, y: number, then: (() => void) | null = null) {
  if (!map || !caravan) return false;
  const p = navFor(map).find(caravan.x, caravan.y, x, y);
  if (!p) return false;
  for (const b of spotLayer.children) b.classList.remove('going');
  followFrom = performance.now();
  caravan.walk(p, then);
  return true;
}
function goSpot(s: TownSpot) {
  const b = spotLayer.children[spots.indexOf(s)];
  // Someone on the road: they wait for you; walk up beside them.
  if (s.folk) {
    const f = walkers.find((w) => w.id === s.folk);
    if (!f || !caravan) return;
    f.waiting = true; f.c.stop();
    const side = Math.atan2(caravan.y - f.c.y, caravan.x - f.c.x);
    const ok = goTo(f.c.x + Math.cos(side) * 4, f.c.y + Math.sin(side) * 4, () => {
      b?.classList.remove('going');
      parent.postMessage({ type: 'primundi-meet', id: s.folk }, location.origin);
    });
    if (ok) b?.classList.add('going');
    return;
  }
  const ok = goTo(s.door[0], s.door[1], () => {
    b?.classList.remove('going');
    if (s.job) parent.postMessage({ type: 'primundi-job', id: s.job }, location.origin);
    else if (s.find) parent.postMessage({ type: 'primundi-find', kind: s.find }, location.origin);
    else parent.postMessage({ type: 'primundi-spot', tab: s.tab }, location.origin);
  });
  if (ok) b?.classList.add('going');
}
const tmpV = new THREE.Vector3();
/** Where a map point is on screen (CSS pixels), or null behind the camera. (The map camera works in
 * the map's frame, even in the looks drawn on the planet through planetCam.) */
function onScreen(x: number, y: number, hh: number): [number, number] | null {
  tmpV.set(x, hh, -y).project(camera);
  if (tmpV.z > 1) return null;
  return [(tmpV.x + 1) / 2 * innerWidth, (1 - tmpV.y) / 2 * innerHeight];
}
function tap(cx: number, cy: number) {
  if (!map || !caravan || walker.active) return;
  // A building that's one of the town's menus, near the tap?
  let best: TownSpot | null = null, bd = Infinity;
  camera.updateMatrixWorld();
  for (const s of spots) {
    if (s.find && (!s.seen || s.used)) continue;
    const mid = (groundAt(s.centre[0], s.centre[1]) + s.top[2]) / 2;
    const c = onScreen(s.centre[0], s.centre[1], mid), e = onScreen(s.centre[0] + s.radius, s.centre[1], mid);
    if (!c || !e) continue;
    const d = Math.hypot(c[0] - cx, c[1] - cy), r = Math.max(28, Math.hypot(e[0] - c[0], e[1] - c[1]));
    if (d < r && d < bd) { bd = d; best = s; }
  }
  if (best) { goSpot(best); return; }
  camera.updateMatrixWorld();
  const p = controls.pick(cx, cy, false);
  if (p) goTo(p.x, -p.z);
}
if (game) {
  // A tap: one finger or the left button, down and up again without moving much, quickly.
  const downs = new Map<number, { x: number; y: number; t: number }>();
  let many = false;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    if (downs.size > 1) many = true;
  });
  const up = (e: PointerEvent, cancel: boolean) => {
    const d = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    if (!d) return;
    const single = !many;
    if (!downs.size) many = false;
    if (cancel || !single) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && performance.now() - d.t < 450) tap(e.clientX, e.clientY);
  };
  addEventListener('pointerup', (e) => up(e, false));
  addEventListener('pointercancel', (e) => up(e, true));
}
/** Each frame: the caravan walks, the camera follows it (until it's moved by hand), the labels
 * follow their buildings. */
function updateCaravan(dt: number) {
  if (!caravan || !map) return;
  caravan.update(dt);
  for (const f of walkers) {
    f.c.update(dt);
    const s = spots.find((x) => x.folk === f.id);
    if (s) { s.centre = [f.c.x, f.c.y]; s.door = [f.c.x, f.c.y]; s.top = [f.c.x, f.c.y, groundAtMap(map, f.c.x, f.c.y) + 3 * style.town.scale]; }
  }
  if (caravan.moving && controls.touched < followFrom) controls.glideTo(caravan.x, -caravan.y);
  camera.updateMatrixWorld();
  const far = Math.max(600, map.localWidth * 0.5);
  const sight = 110 * Math.sqrt(style.town.scale);
  spots.forEach((s, n) => {
    const b = spotLayer.children[n] as HTMLElement;
    if (s.find && !s.seen && Math.hypot(caravan!.x - s.centre[0], caravan!.y - s.centre[1]) < sight) {
      s.seen = true;
      if (s.obj) s.obj.visible = true;
      parent.postMessage({ type: 'primundi-spotted', kind: s.find }, location.origin);
    }
    if (s.find && (!s.seen || s.used)) { b.classList.add('far'); return; }
    const c = onScreen(s.top[0], s.top[1], s.top[2]);
    const d = camera.position.distanceTo(tmpV.set(s.top[0], s.top[2], -s.top[1]));
    const show = !!c && c[0] > -40 && c[0] < innerWidth + 40 && c[1] > 0 && c[1] < innerHeight + 40 && d < far;
    b.classList.toggle('far', !show);
    if (c) b.style.transform = `translate(${c[0].toFixed(1)}px, ${c[1].toFixed(1)}px) translate(-50%, calc(-100% - 8px))`;
  });
}

// --- Walking ---
// Drag the figure onto the ground (a ring shows where), or click it to drop in at the middle of the
// view. Esc glides back up to where the map camera was.
const dropRing = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.8, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthTest: false }));
dropRing.renderOrder = 10; dropRing.visible = false;
let saved: { p: THREE.Vector3; t: THREE.Vector3; tilt: boolean } | null = null;
function walkAt(p: THREE.Vector3 | null) {
  if (!map || walker.active) return;
  const at = p ?? controls.target.clone();
  saved = { p: camera.position.clone(), t: controls.target.clone(), tilt: tiltOn };
  controls.enabled = false;
  tiltH.enabled = tiltV.enabled = false;
  walker.limit = map.size / 2 - 1;
  walker.setReturn(saved.p, saved.t);
  walker.start(at.x, at.z, controls.heading);
  document.body.classList.add('walking');
}
walker.onDone = () => {
  controls.enabled = true;
  document.body.classList.remove('walking');
  if (saved) { camera.position.copy(saved.p); controls.target.copy(saved.t); controls.snap(); tiltH.enabled = tiltV.enabled = saved.tilt; saved = null; }
};
pegman($('pegman'), renderer.domElement, dropRing, (x, y) => {
  const p = controls.pick(x, y, false);
  // In the map's group, which carries it onto the planet in the Earth style (pegman() takes it out).
  if (dropRing.parent !== world) world.add(dropRing);
  if (p) dropRing.scale.setScalar(Math.max(1, camera.position.distanceTo(p) * 0.012));   // a few pixels wide at any zoom
  return p;
}, walkAt);
// Camera feel and head bob, to compare (Tuning; also #feel= and #bob= in the link).
{
  const fs = $<HTMLSelectElement>('feel'), bs = $<HTMLSelectElement>('bob');
  fs.value = Object.keys(FEEL).find((k) => FEEL[k] === controls.feel) ?? 'silky';
  bs.value = String(walker.bob);
  fs.onchange = () => { controls.feel = FEEL[fs.value]; };
  bs.onchange = () => { walker.bob = Number(bs.value); };
}
addEventListener('keydown', (e) => {
  if (walker.active || (e.target as HTMLElement)?.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (e.code === 'BracketLeft') { playing = false; setTime(hourNow() - 0.5); }
  if (e.code === 'BracketRight') { playing = false; setTime(hourNow() + 0.5); }
  if (e.code === 'KeyP') $('play').click();
  if (e.code === 'Escape' && embedded && !game) goBack();
  if (e.code === 'KeyT') setTilt(!tiltOn);
  if (e.code === 'KeyN') setAround(!showCtx);
  if (e.code === 'KeyH' && outline) outline.visible = !outline.visible;
});

const timer = new THREE.Timer();
const fwd = new THREE.Vector3();
let frames = 0, fpsT = 0;
const loop = () => {
  timer.update();
  packPlants?.update(camera.position);   // the plants are in map coordinates, as the orbit camera
  const dt = Math.min(0.1, timer.getDelta());
  frames++; fpsT += dt;
  waterUniforms.uWTime.value += dt;
  wind.uWindT.value += dt;
  if (map && grass) grass.update(camera.position, camera.position.y - waterAt(camera.position.x, -camera.position.z));
  if (map && windLines) {
    // Sized by the camera's height over the ground, placed a little way ahead of it: near enough
    // to read as air moving past, not contrails across the far hills.
    const hAG = Math.max(1.5, camera.position.y - waterAt(camera.position.x, -camera.position.z));
    const sc = Math.max(0.35, Math.min(3, hAG / 14));
    camera.getWorldDirection(fwd);
    const ahead = Math.min(camera.position.distanceTo(controls.target), 25 + hAG * 2.5);
    const ax = camera.position.x + fwd.x * ahead, ay = -(camera.position.z + fwd.z * ahead);
    windLines.mesh.visible = hAG < map.size * 0.4;
    windLines.update(wind.uWindT.value, ax, ay, 15 + hAG * 2, sc, groundAt);
  }
  // Playing: a day in 48 seconds.
  if (playing && map) { userHour = (hourNow() + dt * 0.5) % 24; applyTime(); }
  if (fpsT > 1) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
  if (game) updateCaravan(dt);
  if (walker.active) walker.update(dt);
  else controls.update(dt);
  // The near plane moves out as the camera climbs: from high up, a fixed 0.3 m left too little depth
  // precision to keep a shallow sea bed under its water (it showed through in streaks).
  if (map) {
    const nr = Math.max(0.3, Math.min(60, (camera.position.y - waterAt(camera.position.x, -camera.position.z)) * 0.2));
    if (Math.abs(nr - camera.near) > camera.near * 0.05) { camera.near = nr; camera.updateProjectionMatrix(); }
  }
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
  fitShadows(renderPass.camera as THREE.PerspectiveCamera);
  if (hexFog && map) {
    // The fog works in the map's own space: the camera brought into it, and local → clip.
    const rc = renderPass.camera as THREE.PerspectiveCamera;
    world.updateMatrixWorld(); rc.updateMatrixWorld();
    fogCam.copy(rc.position);
    world.worldToLocal(fogCam);
    fogMvp.multiplyMatrices(rc.projectionMatrix, rc.matrixWorldInverse).multiply(world.matrixWorld);
    hexFog.update(fogCam, fogMvp, realSun, dt, timer.getElapsed());
  }
  renderFrame();
};
const fogCam = new THREE.Vector3(), fogMvp = new THREE.Matrix4();
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
      if (walker.active) walker.leave();
      renderer.setAnimationLoop(null);
    }
    if (e.data.type === 'mundi-hex-warm') { applyHash(e.data.hash); warm(); }
    if (e.data.type === 'mundi-hex-snapshot') snapshot(e.data.hash);
    if (e.data.type === 'mundi-hex-valleys') takeValleys(e.data.hash, e.data.n, e.data.half);
    // Primundi: a job's camp or site dealt with; its label goes.
    if (e.data.type === 'primundi-job-done') for (const s of spots) if (s.job === e.data.id) s.used = true;
    // Primundi: someone met on the road goes on their way.
    if (e.data.type === 'primundi-folk-done') {
      for (const s of spots) if (s.folk === e.data.id) s.used = true;
      const f = walkers.find((w) => w.id === e.data.id);
      if (f) { f.waiting = false; folkWalk(f); }
    }
    // Primundi: a find has been used; its label goes.
    if (e.data.type === 'primundi-used') {
      gameUsed.add(String(e.data.kind));
      for (const s of spots) if (s.find === e.data.kind) s.used = true;
    }
    // Primundi: more cells revealed while the hex is open; the fog over them clears.
    if (e.data.type === 'primundi-seen' && hexFog) {
      const more = (e.data.cells as number[]).filter((c) => !gameSeen.has(c));
      for (const c of more) gameSeen.add(c);
      hexFog.reveal(more);
    }
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
// The screen furniture as a HUD (hexui.ts); #ui=classic keeps the old panel.
if (h.get('ui') !== 'classic') mountHud({
  heading: () => controls.heading,
  faceNorth: () => controls.turnTo(0),
  help: game ? {
    key: 'primundi-hex-help',
    touch: `<div><b>Tap</b> walk there</div><div><b>Tap a building</b> go in</div><div><b>Drag</b> look round</div><div><b>Pinch</b> zoom · <b>twist</b> turn</div>`,
    mouse: `<div><b>Click</b> walk there</div><div><b>Click a building</b> go in</div><div><b>Drag</b> look round</div><div><b>Scroll</b> zoom · <b>middle-drag</b> turn</div>`,
  } : undefined,
});
void LAYERS; void L_DEPTH;
(window as unknown as Record<string, unknown>).hex = {
  get map() { return map; },
  get busy() { return busy; },
  /** The hex on show was built with the planet's valleys. */
  get valleys() { return mapValleys; },
  get style() { return style.id; },
  get caravan() { return caravan; },
  get spots() { return spots; },
  tap, goTo, goSpot, onScreen, camera, get worldGroup() { return world; },
  resetView, scene, setTilt, setTime, setAround, walker, wind, clouds, csm, waterUniforms, groundTex, canopy, shoreUniforms,
  /** The camera: position, the point looked at, distance (scripts/camtest.mjs). */
  camPose: () => ({ p: camera.position.toArray().map((v) => +v.toFixed(1)), t: controls.target.toArray().map((v) => +v.toFixed(1)), d: +camera.position.distanceTo(controls.target).toFixed(1), max: +controls.maxDistance.toFixed(0) }),
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
    controls.snap();
  },
  /** Camera at (x, y north) metres, height above ground, looking at (tx, ty). */
  look: (x: number, y: number, up: number, tx: number, ty: number, tUp = 0) => {
    camera.position.set(x, groundAt(x, y) + up, -y);
    controls.target.set(tx, groundAt(tx, ty) + tUp, -ty); controls.snap();
  },
};
