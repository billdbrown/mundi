/**
 * A high-detail patch of ground under the middle of the view, so dunes and eroded hills stand
 * up as real shapes against the horizon instead of being shading on a surface whose vertices
 * are ~60 km apart. (Named for the dunes it was built for; it carries the erosion relief too.)
 *
 * The patch is a fine grid (finest at its centre) in the tangent plane at the point the view
 * is centred on. To sit exactly on the terrain as drawn, and shade exactly like it, it reads a
 * capture of the terrain mesh rendered from straight above: height, normal, colour and climate,
 * in two small textures, taken again whenever the view moves off-centre. It draws with the
 * terrain's own material (makeTerrainMaterial, DUNE_PATCH), raised by the dunes, the hills and
 * the gully octaves its grid can carry (PATCH_GLSL in dunes.ts); finer detail stays shading.
 *
 * Drawing order, so nothing is shaded twice: a cheap depth-only pass of the patch first; then
 * the terrain, which the GPU skips wherever the patch covers it; then the patch's colour, which
 * only its front-most pixels pass. Relief hides plenty of itself, and the grid is drawn in no
 * particular order, so without the depth pass hidden slopes were shaded and then painted over
 * (twice the cost over hills). A discarding shader would also disable the skipping.
 */
import * as THREE from 'three';
import { makeTerrainMaterial, NOISE_GLSL, type CloudUniforms } from './sky.ts';
import { PATCH_N, PATCH_A, PATCH_R, CAPTURE_SIZE, DUNES_GLSL, PATCH_GLSL, PATCH_BAKE_GLSL, patchUniforms, type PatchUniforms } from './dunes.ts';
import { EROSION_GLSL } from './erosion.ts';
import { TerrainShadow, shadowUniforms } from './terrainshadow.ts';
import { VALLEY_GLSL } from './valleys.ts';

const CAPTURE = CAPTURE_SIZE;
/** Camera heights below which the patch is drawn (dunes are invisible from higher). */
const PATCH_MAX_DIST = 1.12;

const captureVertex = /* glsl */`
  attribute vec2 climate;
  attribute vec4 eco;
  varying vec3 vW, vN, vCol;
  varying vec2 vClim;
  varying vec4 vEco;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vCol = color;
    vClim = climate;
    vEco = eco;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const captureFragment = (which: 'A' | 'B' | 'C') => /* glsl */`
  uniform vec3 uE, uN;
  varying vec3 vW, vN, vCol;
  varying vec2 vClim;
  varying vec4 vEco;
  void main() {
    ${which === 'A'
      ? 'gl_FragColor = vec4((length(vW) - 1.0) * 50.0, dot(normalize(vN), uE), dot(normalize(vN), uN), vClim.x);'
      : which === 'B' ? 'gl_FragColor = vec4(vCol, vClim.y);' : 'gl_FragColor = vEco;'}
  }`;

export class DunePatch {
  readonly mesh: THREE.Group;
  private colour: THREE.Mesh;
  /** The patch's shape for the terrain-shadow height map (terrainshadow.ts). */
  readonly heightMesh: THREE.Mesh;
  /** Called after each recentre (the patch's shape changed). */
  onCapture: (() => void) | null = null;
  private depth: THREE.Mesh;
  private u: PatchUniforms;
  private capA: THREE.WebGLRenderTarget;
  private capB: THREE.WebGLRenderTarget;
  private capC: THREE.WebGLRenderTarget;
  /** The baked relief, one texel per grid vertex (PatchUniforms.uBake0..2). */
  private bake: THREE.WebGLRenderTarget[];
  private bakeScene = new THREE.Scene();
  private bakeMat: THREE.ShaderMaterial;
  /** River mask: rivers and streams drawn from above, white on black. */
  private capR: THREE.WebGLRenderTarget;
  private riverScene = new THREE.Scene();
  /** River mask: r 1 where water runs, g its surface height (x50), for the patch's channels. */
  private riverMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying float vH; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vH = length(w.xyz) - 1.0; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'varying float vH; void main() { gl_FragColor = vec4(1.0, vH * 50.0, 0.0, 1.0); }',
  });
  private capCam = new THREE.OrthographicCamera(-PATCH_R, PATCH_R, PATCH_R, -PATCH_R, 0.01, 0.4);
  private capScene = new THREE.Scene();
  private capMesh = new THREE.Mesh();
  private matA: THREE.ShaderMaterial;
  private matB: THREE.ShaderMaterial;
  private matC: THREE.ShaderMaterial;
  private source: THREE.Mesh | null = null;
  private center = new THREE.Vector3(0, 0, 1);
  private dirty = true;

  constructor(cloud: CloudUniforms) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
    this.capA = new THREE.WebGLRenderTarget(CAPTURE, CAPTURE, opts);
    this.capB = new THREE.WebGLRenderTarget(CAPTURE, CAPTURE, opts);
    this.capC = new THREE.WebGLRenderTarget(CAPTURE, CAPTURE, opts);
    this.bake = [0, 1, 2].map(() => new THREE.WebGLRenderTarget(PATCH_N, PATCH_N, { ...opts, depthBuffer: false }));
    this.capR = new THREE.WebGLRenderTarget(CAPTURE, CAPTURE, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.u = patchUniforms;
    this.u.uCapA.value = this.capA.texture;
    this.u.uCapB.value = this.capB.texture;
    this.u.uCapC.value = this.capC.texture;
    this.u.uBake0.value = this.bake[0].texture;
    this.u.uBake1.value = this.bake[1].texture;
    this.u.uBake2.value = this.bake[2].texture;
    this.u.uCapR.value = this.capR.texture;
    const uniforms = { uE: { value: new THREE.Vector3() }, uN: { value: new THREE.Vector3() } };
    this.matA = new THREE.ShaderMaterial({ vertexShader: captureVertex, fragmentShader: captureFragment('A'), uniforms, vertexColors: true });
    this.matB = new THREE.ShaderMaterial({ vertexShader: captureVertex, fragmentShader: captureFragment('B'), uniforms, vertexColors: true });
    this.matC = new THREE.ShaderMaterial({ vertexShader: captureVertex, fragmentShader: captureFragment('C'), uniforms, vertexColors: true });
    this.capMesh.matrixAutoUpdate = false;
    this.capMesh.frustumCulled = false;
    this.capScene.add(this.capMesh);

    // Grid: tangent-plane offsets, closer together near the centre (x = R·u·(a + (1 − a)|u|)).
    const n = PATCH_N, pos = new Float32Array(n * n * 3), idx: number[] = [];
    const map = (t: number) => PATCH_R * t * (PATCH_A + (1 - PATCH_A) * Math.abs(t));
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = map((i / (n - 1)) * 2 - 1);
      pos[k + 1] = map((j / (n - 1)) * 2 - 1);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Normals are worked out in the shader; without the attribute three.js shades the mesh flat.
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    geo.setIndex(idx);
    // Colour: the terrain's material. Pulled a little further forward than the depth pass, so
    // it always passes against its own depth (two shader programs needn't agree to the bit).
    const mat = makeTerrainMaterial(cloud, true, this.u);
    mat.polygonOffset = true;
    // Constant offset only: the slope-scaled part grows huge at the grazing angles of low views
    // and pulled the patch in front of rivers lying just above the ground.
    mat.polygonOffsetFactor = 0;
    mat.polygonOffsetUnits = -4;
    mat.depthWrite = false;
    this.colour = new THREE.Mesh(geo, mat);
    this.colour.renderOrder = 1;
    // Depth only, with the same vertex code, in front of the terrain where the two coincide.
    const pre = new THREE.MeshBasicMaterial({ colorWrite: false });
    pre.polygonOffset = true;
    pre.polygonOffsetFactor = 0;
    pre.polygonOffsetUnits = -2;
    pre.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, cloud, this.u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${PATCH_GLSL}`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\npatchSample(position.xy);\ntransformed = pSurf;');
    };
    pre.customProgramCacheKey = () => 'dune-patch-depth';
    this.depth = new THREE.Mesh(geo, pre);
    this.depth.renderOrder = -1;
    for (const m of [this.colour, this.depth]) m.frustumCulled = false;
    this.heightMesh = new THREE.Mesh(geo, TerrainShadow.heightMaterial(PATCH_GLSL, 'patchSample(position.xy); vec3 transformed = pSurf;', { ...this.u }));
    this.heightMesh.frustumCulled = false;
    this.heightMesh.visible = false;
    this.mesh = new THREE.Group();
    this.mesh.add(this.depth, this.colour);
    this.mesh.visible = false;

    // The bake: each grid vertex as one point, at its own texel, writing its relief. Run once per
    // recentre (three passes, one per target), so the drawing shaders stay small.
    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: { ...cloud, ...this.u, uOut: { value: 0 }, uValleys: shadowUniforms.uValleys, uEroOn: shadowUniforms.uEroOn, uEroR: shadowUniforms.uEroR },
      vertexShader: `${NOISE_GLSL}\n${EROSION_GLSL}\n${VALLEY_GLSL}\n${DUNES_GLSL}\n${PATCH_BAKE_GLSL}
        varying vec4 vOut0, vOut1, vOut2;
        void main() {
          patchBake(position.xy);
          vOut0 = bake0; vOut1 = bake1; vOut2 = bake2;
          vec2 ij = vec2(float(gl_VertexID % ${PATCH_N}), float(gl_VertexID / ${PATCH_N}));
          gl_Position = vec4((ij + 0.5) / ${PATCH_N}.0 * 2.0 - 1.0, 0.0, 1.0);
          gl_PointSize = 1.0;
        }`,
      fragmentShader: `uniform int uOut;
        varying vec4 vOut0, vOut1, vOut2;
        void main() { gl_FragColor = uOut == 0 ? vOut0 : uOut == 1 ? vOut1 : vOut2; }`,
      depthTest: false, depthWrite: false,
    });
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', geo.getAttribute('position'));
    const bakePts = new THREE.Points(points, this.bakeMat);
    bakePts.frustumCulled = false;
    this.bakeScene.add(bakePts);
  }

  /** The rivers and streams, so the patch keeps flat floodplains along them. */
  setRivers(meshes: (THREE.Mesh | undefined)[]) {
    this.riverScene.clear();
    for (const m of meshes) {
      if (!m) continue;
      const copy = new THREE.Mesh(m.geometry, this.riverMat);
      copy.matrixAutoUpdate = false;
      copy.frustumCulled = false;
      m.updateWorldMatrix(true, false);
      copy.matrix.copy(m.matrixWorld);
      this.riverScene.add(copy);
    }
    this.dirty = true;
  }

  /** The terrain to drape over (smooth style with climate), or null to switch the patch off. */
  setTerrain(terrain: THREE.Mesh | null) {
    this.source = terrain && terrain.geometry.getAttribute('climate') ? terrain : null;
    this.dirty = true;
    if (!this.source) this.mesh.visible = false;
  }

  /**
   * Each frame: centre is the direction of the point the view is centred on, dist the camera's
   * distance from the planet's centre. Captures the terrain again when the view has moved.
   * wait: stay hidden until the shaders are compiled (false for screenshots, which would
   * otherwise come out with or without the patch depending on timing).
   */
  update(renderer: THREE.WebGLRenderer, centre: THREE.Vector3, dist: number, active: boolean, wait = true) {
    const on = (this.ready || !wait) && active && !!this.source && this.source.visible && dist < PATCH_MAX_DIST;
    this.mesh.visible = on;
    this.heightMesh.visible = on;
    this.u.uPatchOn.value = on ? 1 : 0;
    if (!on) return;
    const c = centre.clone().normalize();
    // The whole planet's valleys are baked in once they have fully arrived (valleys.ts).
    const valleys = shadowUniforms.uEroOn.value >= 0.999 ? 1 : 0;
    if (valleys !== this.bakedValleys) { this.bakedValleys = valleys; this.dirty = true; }
    if (this.dirty || c.angleTo(this.center) > PATCH_R * 0.12) this.capture(renderer, c);
  }

  private bakedValleys = 0;
  private capture(renderer: THREE.WebGLRenderer, c: THREE.Vector3) {
    const src = this.source!;
    this.dirty = false;
    this.center.copy(c);
    let e = new THREE.Vector3(c.z, 0, -c.x);
    if (e.lengthSq() < 1e-8) e = new THREE.Vector3(1, 0, 0);
    e.normalize();
    const nth = new THREE.Vector3().crossVectors(c, e);
    this.u.uPatchC.value.copy(c);
    this.u.uPatchE.value.copy(e);
    this.u.uPatchN.value.copy(nth);
    (this.matA.uniforms.uE.value as THREE.Vector3).copy(e);
    (this.matA.uniforms.uN.value as THREE.Vector3).copy(nth);

    // Looking straight down at the centre, east to the right and north up.
    this.capCam.position.copy(c).multiplyScalar(1.1);
    this.capCam.up.copy(nth);
    this.capCam.lookAt(0, 0, 0);
    this.capCam.updateMatrixWorld();
    this.capMesh.geometry = src.geometry;
    src.updateWorldMatrix(true, false);
    this.capMesh.matrix.copy(src.matrixWorld);
    this.capMesh.matrixWorld.copy(src.matrixWorld);

    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const [target, mat] of [[this.capA, this.matA], [this.capB, this.matB], [this.capC, this.matC]] as const) {
      this.capMesh.material = mat;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(this.capScene, this.capCam);
    }
    renderer.setRenderTarget(this.capR);
    renderer.clear();
    renderer.render(this.riverScene, this.capCam);
    this.bake.forEach((target, k) => {
      this.bakeMat.uniforms.uOut.value = k;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(this.bakeScene, this.capCam);
    });
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    this.onCapture?.();
  }

  /**
   * Compile the patch's shaders now, in the background where the browser supports it
   * (KHR_parallel_shader_compile), instead of in the frame where the camera first gets low:
   * the colour shader alone takes ~12 s to compile on Windows. The patch stays hidden until they
   * are ready (the plain terrain shows meanwhile). Each is compiled against the kind of target
   * and geometry it will really draw with, or three.js compiles a different variant.
   * scene: for its lights and fog; target: where the main view renders (null: the screen).
   */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene, target: THREE.WebGLRenderTarget | null): Promise<unknown> {
    const prev = renderer.getRenderTarget();
    const terrainGeo = this.source?.geometry ?? new THREE.PlaneGeometry();
    const river = (this.riverScene.children[0] as THREE.Mesh | undefined)?.geometry;
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const offscreen = new THREE.Scene();
    offscreen.add(new THREE.Mesh(terrainGeo, this.matA), new THREE.Mesh(terrainGeo, this.matB), new THREE.Mesh(river ?? bare, this.riverMat));
    offscreen.add(this.bakeScene.children[0].clone());
    renderer.setRenderTarget(this.capA);
    const jobs = [renderer.compileAsync(offscreen, this.capCam)];
    renderer.setRenderTarget(target);
    jobs.push(renderer.compileAsync(this.mesh, camera, scene));
    renderer.setRenderTarget(prev);
    return Promise.all(jobs).then(() => { this.ready = true; }).finally(() => bare.dispose());
  }
  /** False until prewarm's shaders are compiled. */
  private ready = false;

  dispose() {
    this.capA.dispose(); this.capB.dispose(); this.capC.dispose(); this.capR.dispose();
    for (const t of this.bake) t.dispose();
    this.bakeMat.dispose();
    this.riverMat.dispose();
    this.matA.dispose(); this.matB.dispose();
    this.colour.geometry.dispose();
    (this.colour.material as THREE.Material).dispose();
    (this.depth.material as THREE.Material).dispose();
  }
}
