/**
 * River valleys for the whole planet, worked out once per world (trial V, 2026-11-02).
 *
 * Carved valleys were tried twice before around the view (a region centred on it, then fixed
 * tiles near it), and both times Bill saw them come and go as he moved: anything worked out on
 * demand near the camera arrives, and gets dropped, somewhere. Here the planet is done in one go
 * and the valleys are simply part of the land.
 *
 * The terrain's heights are drawn onto the six faces of a cube round the planet (gnomonic: a
 * point lands at u = p_i / p_k on face k) and eroded as one grid in a worker (valleyworker.ts,
 * cubeErosion in analyticerosion.ts), water flowing across the faces' edges; the result goes in
 * a six-layer texture, read by the shader's groundCarve(p) (VALLEY_GLSL) from the face p is on.
 * (Faces eroded one by one, overlapping and blended, disagreed where they met: each had treated
 * its edge as the sea, so their valleys there were different ones.)
 */
import * as THREE from 'three';
import { MTN_CARVE } from './dunes.ts';
import { RELIEF } from './surface.ts';
import type { ValleyRequest, ValleyResult } from './valleyworker.ts';

/**
 * Face resolution: ~2.6e-3 rad a texel at a face's centre (~17 km on an Earth-sized world), ~2x
 * finer at the edges. The erosion needs ~36 bytes a cell in one worker: 768 is ~130 MB.
 */
export const VALLEY_N = 768;

/** Face f: major axis k = f >> 1, sign by f & 1; the face's grid axes are i = k + 1, j = k + 2. */
function faceAxes(f: number) {
  const k = f >> 1, sign = f & 1 ? -1 : 1;
  return { k, sign, i: (k + 1) % 3, j: (k + 2) % 3 };
}

/**
 * groundCarve(p) = (carving, log2 drainage area, weight). Same contract as the tiles it replaces
 * (terrainshadow.ts), so the shading, valley floors and shadows that read it are unchanged.
 */
export const VALLEY_GLSL = /* glsl */`
  uniform highp sampler2DArray uValleys;
  uniform float uEroR, uEroOn;
  vec3 groundCarve(vec3 p) {
    if (uEroOn <= 0.0) return vec3(0.0);
    vec3 q = abs(p);
    // The face p is on, and its gnomonic coordinates there (see faceAxes).
    vec2 t; float f;
    if (q.x >= q.y && q.x >= q.z) { t = p.yz / q.x; f = p.x < 0.0 ? 1.0 : 0.0; }
    else if (q.y >= q.z) { t = p.zx / q.y; f = p.y < 0.0 ? 3.0 : 2.0; }
    else { t = p.xy / q.z; f = p.z < 0.0 ? 5.0 : 4.0; }
    return vec3(texture(uValleys, vec3(t * 0.5 + 0.5, f)).rg, uEroOn);
  }
  /**
   * The carving less its local average (valleyworker.ts): what the close-up patch cuts into the
   * ground, so that on average the land stays at the plain terrain's height. Negative on ridges,
   * which stand up a little where the valleys beside them go down.
   */
  float groundCut(vec3 p) {
    if (uEroOn <= 0.0) return 0.0;
    vec3 q = abs(p);
    vec2 t; float f;
    if (q.x >= q.y && q.x >= q.z) { t = p.yz / q.x; f = p.x < 0.0 ? 1.0 : 0.0; }
    else if (q.y >= q.z) { t = p.zx / q.y; f = p.y < 0.0 ? 3.0 : 2.0; }
    else { t = p.xy / q.z; f = p.z < 0.0 ? 5.0 : 4.0; }
    vec4 v = texture(uValleys, vec3(t * 0.5 + 0.5, f));
    return v.r - v.b;
  }
`;

export class Valleys {
  readonly tex: THREE.DataArrayTexture;
  /** Faces done for the current world; the fade starts once all six are in. */
  private done = 0;
  private gen = 0;
  private started = false;
  private fadeStart = 0;
  private worker: Worker | null = null;
  /**
   * The cell size drainage area is counted in (cubeErosion). The old tiles' cells (2.6e-4 rad,
   * which k and m were tuned at) carved whole uplands down on this coarser grid; this grid's own
   * cells (2.6e-3) barely carved at all. A third of a cell gave branching valley networks rather
   * than worn-down blobs (2026-11-02, carve maps at 2.6e-3, 1.3e-3, 8.7e-4, 5.2e-4).
   */
  unit = 2 / VALLEY_N / 3;
  /** For tests: keep a copy of the captured heights (RGBA half floats, face-major). */
  keepHeights = false;
  heights: Uint16Array | null = null;
  private target = new THREE.WebGLRenderTarget(VALLEY_N, VALLEY_N, { type: THREE.HalfFloatType, depthBuffer: false });
  private scene = new THREE.Scene();
  private copy = new THREE.Mesh();
  private cam = new THREE.Camera();
  private mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    vertexShader: 'varying float vH; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vH = length(w.xyz) - 1.0; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'varying float vH; void main() { gl_FragColor = vec4(vH * 50.0, 0.0, 0.0, 1.0); }',
  });
  /** Times for the readout and tests: capture, and each face's erosion (ms). */
  readonly timings: { capture: number; faces: number[]; total: number } = { capture: 0, faces: [], total: 0 };
  private t0 = 0;

  private u: { uValleys: { value: THREE.Texture | null }; uEroOn: { value: number }; uEroR: { value: number } };
  constructor(u: { uValleys: { value: THREE.Texture | null }; uEroOn: { value: number }; uEroR: { value: number } }) {
    this.u = u;
    const n = VALLEY_N;
    this.tex = new THREE.DataArrayTexture(new Uint16Array(n * n * 4 * 6), n, n, 6);
    this.tex.format = THREE.RGBAFormat;
    this.tex.type = THREE.HalfFloatType;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.copy.material = this.mat;
    this.copy.matrixAutoUpdate = false;
    this.copy.frustumCulled = false;
    this.scene.add(this.copy);
    this.cam.matrixAutoUpdate = false;
    u.uValleys.value = this.tex;
    // The shader's finite-difference step for the valleys' slope (sky.ts: uEroR * 2 / 512) to
    // about a texel at a face's centre.
    u.uEroR.value = 512 / n;
  }

  /**
   * The rivers' drawn centrelines (render.ts buildRivers): segments a (3), b (3), weight. The
   * valleys are cut along them (valleyworker.ts), so the rivers run in their valleys.
   */
  private rivers: Float32Array = new Float32Array(0);
  setRivers(lines: Float32Array) { this.rivers = new Float32Array(lines); }

  /** A new world: forget the old valleys. */
  reset() {
    // A job for the old world still running: stop it rather than wait ~6 s behind it.
    if (this.busy && this.worker) { this.worker.terminate(); this.worker = null; this.busy = false; }
    this.gen++;
    this.done = 0;
    this.started = false;
    this.fadeStart = 0;
    this.u.uEroOn.value = 0;
  }

  /** All six faces are in. */
  get ready() { return this.done === 6; }

  /** Capture the terrain onto the six faces and start the erosion (once per world). */
  build(renderer: THREE.WebGLRenderer, terrain: THREE.Mesh) {
    if (this.started || typeof Worker === 'undefined') return;
    this.started = true;
    this.t0 = performance.now();
    const n = VALLEY_N, gen = this.gen;
    terrain.updateWorldMatrix(true, false);
    this.copy.geometry = terrain.geometry;
    this.copy.matrix.copy(terrain.matrixWorld);
    this.copy.matrixWorld.copy(terrain.matrixWorld);
    const prev = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    const half = new Uint16Array(6 * n * n * 4);
    const reads: Promise<unknown>[] = [];
    for (let f = 0; f < 6; f++) {
      const { k, sign, i, j } = faceAxes(f);
      // Clip x = p_i / EXT, y = p_j / EXT, w = the major coordinate (behind the face clips).
      const e = (axis: number, s: number) => { const v = [0, 0, 0]; v[axis] = s; return v; };
      const ri = e(i, 1), rj = e(j, 1), rk = e(k, sign);
      this.cam.projectionMatrix.set(ri[0], ri[1], ri[2], 0, rj[0], rj[1], rj[2], 0, 0, 0, 0, 0, rk[0], rk[1], rk[2], 0);
      this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(this.scene, this.cam);
      reads.push(renderer.readRenderTargetPixelsAsync(this.target, 0, 0, n, n, half.subarray(f * n * n * 4, (f + 1) * n * n * 4)));
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    void Promise.all(reads).then(() => {
      this.timings.capture = performance.now() - this.t0;
      if (this.keepHeights) this.heights = half.slice();
      this.post({ half, n, gen, unit: this.unit, rivers: this.rivers.slice() });
    });
  }

  private post(req: ValleyRequest) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./valleyworker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<ValleyResult>) => this.receive(ev.data);
    }
    this.busy = true;
    this.worker.postMessage(req, [req.half.buffer]);
  }
  private busy = false;
  private receive(r: ValleyResult) {
    this.busy = false;
    if (r.gen !== this.gen) return;
    (this.tex.image.data as Uint16Array).set(r.packed);
    this.tex.needsUpdate = true;
    this.timings.faces = [r.ms];
    this.done = 6;
    this.timings.total = performance.now() - this.t0;
    this.fadeStart = performance.now();
  }

  /**
   * How far the close-up patch lowers the ground at direction (x, y, z), hAbove its height above
   * the sea on the plain terrain, as drawn now (0 until the valleys have arrived): for the camera,
   * which keeps its height above the ground it looks at. Negative where the patch raises a ridge.
   * As dunes.ts PATCH_BAKE_GLSL has it: the carving less its local average, deeper in the
   * mountains, never below the sea. Nearest texel.
   */
  carveAt(x: number, y: number, z: number, hAbove: number): number {
    const on = this.u.uEroOn.value;
    if (on <= 0 || hAbove <= 0) return 0;
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z), n = VALLEY_N;
    let u: number, v: number, f: number;
    if (ax >= ay && ax >= az) { u = y / ax; v = z / ax; f = x < 0 ? 1 : 0; }
    else if (ay >= az) { u = z / ay; v = x / ay; f = y < 0 ? 3 : 2; }
    else { u = x / az; v = y / az; f = z < 0 ? 5 : 4; }
    const px = Math.min(n - 1, Math.max(0, Math.floor((u * 0.5 + 0.5) * n)));
    const py = Math.min(n - 1, Math.max(0, Math.floor((v * 0.5 + 0.5) * n)));
    const d = this.tex.image.data as Uint16Array, i = ((f * n + py) * n + px) * 4;
    const cut = THREE.DataUtils.fromHalfFloat(d[i]) - THREE.DataUtils.fromHalfFloat(d[i + 2]);
    const t = Math.min(1, Math.max(0, (hAbove / RELIEF - 0.12) / 0.73)), highland = t * t * (3 - 2 * t);
    return Math.min(cut * (1 + MTN_CARVE * highland), 0.9 * hAbove) * on;
  }

  /** Each frame: fade the whole planet's valleys in, once, over 1.5 s. */
  tick(on: boolean) {
    if (!on) { this.u.uEroOn.value = 0; return; }
    if (!this.ready) return;
    this.u.uEroOn.value = Math.min(1, (performance.now() - this.fadeStart) / 1500);
  }
}
