import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { B } from './biomes.ts';

const DRY = new Set<number>([B.DESERT, B.SAVANNA, B.STEPPE, B.BEACH, B.TUNDRA]);
import { hash01 } from './rng.ts';
import { makeSimplex } from './noise.ts';
import { SEA, RELIEF, surfaceQueries, type MeshData, type SurfaceData, type SurfaceQueries } from './surface.ts';
import { buildForest, treeMaterial } from './flora.ts';
import { LodFlora, FADE_NEAR, FADE_FAR } from './lodflora.ts';
import { makeWaterMaterial, makeClouds, cloudTexturesFromPixels, makeAtmosphere, makeStars, makeCloudUniforms, applyCloudShadow, makeTerrainMaterial } from './sky.ts';
import type { CloudPixels } from './clouds.ts';
import type { ViewMode, TerrainStyle } from './colors.ts';

export type { ViewMode, TerrainStyle };

export interface ViewOptions {
  mode: ViewMode;
  style: TerrainStyle;
  grid: boolean;
  rivers: boolean;
  trees: boolean;
  clouds: boolean;
  blend: boolean;
  relief: number;
  /** follow: the sun rides with the camera, always lit. cycle: a fixed sun, day and night. */
  light: 'follow' | 'cycle';
  /** Markers on suggested settlement sites. */
  sites: boolean;
  /** map: overlays and game colours. photo: no overlays, rivers only up close, a photographic grade. */
  look: 'map' | 'photo';
}

export const DEFAULT_VIEW: ViewOptions = { mode: 'biome', style: 'smooth', grid: true, rivers: true, trees: true, clouds: true, blend: true, relief: 1, light: 'follow', sites: false, look: 'map' };

/** Days in a year, and the day of the northern spring equinox (seasonal offset zero). */
export const YEAR_DAYS = 365, EQUINOX_DAY = 80;
/** Axial tilt in degrees: how far the sun swings north and south over the year. */
const TILT = 23.4;

/** Options that change the meshes, so need a trip to the worker; the rest only toggle visibility. */
export const REBUILD_KEYS: (keyof ViewOptions)[] = ['mode', 'style', 'blend', 'relief'];

export class PlanetView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private container: HTMLElement;
  private planet = new THREE.Group();
  private terrain?: THREE.Mesh;
  private water?: THREE.Mesh;
  private cloudU = makeCloudUniforms();
  private waterMat = makeWaterMaterial(this.cloudU);
  /** Rivers: the same water, plus a fade so mouths dissolve into the sea. Shares time and sun. */
  private riverMat = this.makeRiverMat();
  private streamMat = this.makeRiverMat();
  /** Green corridors along rivers through dry land (the Nile from space). */
  private corridors?: THREE.Mesh;
  private corridorMat = (() => {
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, depthWrite: false, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    return m;
  })();

  /** Rivers: the sea's water with a fade (mouths dissolve into the sea) and fresh-water colours. */
  private makeRiverMat() {
    const m = makeWaterMaterial(this.cloudU, true);
    m.uniforms.uTime = this.waterMat.uniforms.uTime;
    m.uniforms.uSunDir = this.waterMat.uniforms.uSunDir;
    // Fresh, silty water: lighter and greener than the open ocean, so rivers don't read as ink.
    m.uniforms.uShallow.value.set(0x5f8f86);
    m.uniforms.uMid.value.set(0x3f6f7e);
    m.uniforms.uDeep.value.set(0x2f5a6e);
    return m;
  }
  private gridLines?: THREE.LineSegments;
  private rivers?: THREE.Mesh;
  private streams?: THREE.Mesh;
  private siteMarks?: THREE.Points;
  private siteCells: number[] = [];
  private forest: THREE.InstancedMesh[] = [];
  private flora: LodFlora;
  private clouds: THREE.Group;
  private hover: THREE.LineLoop;
  private sun: THREE.DirectionalLight;
  private surface?: SurfaceQueries;
  private faceCell: Int32Array = new Int32Array(0);
  private world?: World;
  private opts: ViewOptions = { ...DEFAULT_VIEW };
  private raycaster = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private sunDir = new THREE.Vector3();
  private composer?: EffectComposer;
  private sunU = { uSunDir: { value: new THREE.Vector3(0, 0, 1) } };
  private ambient: THREE.AmbientLight;
  private time = 0;
  /** Calendar day (fractional). Advances only while the clock runs. */
  private day = EQUINOX_DAY;
  /** Days per real second; 0 = paused. */
  private clockRate = 0;
  /** When set, animation stops at this time, so renders are repeatable (visual tests). */
  private frozen: number | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.0015, 100);
    this.camera.position.set(0, 0.9, 3.4);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x04060b);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.045;
    this.controls.maxDistance = 7;
    this.controls.zoomSpeed = 0.8;

    // The sun rides with the camera, off to one side, so the view is lit but relief still shades.
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
    this.sun.position.set(-3, 1.6, 2.2);
    this.camera.add(this.sun);
    // Ambient, not hemisphere: a hemisphere light's "up" is world +Y, which means nothing on a sphere.
    this.ambient = new THREE.AmbientLight(0xc8d8f0, 0.75);
    this.scene.add(this.ambient);

    this.clouds = makeClouds(this.cloudU);
    this.flora = new LodFlora(this.planet);
    this.hover = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.hover.renderOrder = 10;
    this.hover.visible = false;
    this.planet.add(this.hover);
    this.planet.add(this.clouds);
    applyCloudShadow(treeMaterial, this.cloudU, this.sunU, { uFadeNear: { value: FADE_NEAR }, uFadeFar: { value: FADE_FAR } });

    this.scene.add(this.planet);
    this.scene.add(makeAtmosphere(this.sunU));
    this.scene.add(makeStars());

    // Photo look: render, grade (in linear light), then tone map and encode.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(GRADE_SHADER));
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Run the clock at `rate` days per second (0 pauses). */
  setClock(rate: number) { this.clockRate = rate; }
  getDay() { return this.day; }
  setDay(d: number) { this.day = d; }
  /** Sun angle round the axis for the current day (matches frame()). */
  private sunAngle() { return (((this.day % 1) + 1) % 1) * Math.PI * 2 - 0.6; }
  /** Longitude angle of the point under the middle of the view. */
  private viewAngle() { return Math.atan2(this.camera.position.x, this.camera.position.z); }
  /** Local solar time (0..24) at the middle of the view, in cycle lighting. */
  localHour() {
    const h = 12 + ((this.sunAngle() - this.viewAngle()) / (Math.PI * 2)) * 24;
    return ((h % 24) + 24) % 24;
  }
  /** Move the clock within the current day so it is `hour` o'clock under the middle of the view. */
  setLocalHour(hour: number) {
    const a = this.viewAngle() + ((hour - 12) / 24) * Math.PI * 2;
    const frac = ((((a + 0.6) / (Math.PI * 2)) % 1) + 1) % 1;
    this.day = Math.floor(this.day) + frac;
  }

  freeze(t: number | null) {
    this.frozen = t;
    this.clock.getDelta();
  }

  /** Draws a world from worker-built data. */
  setData(world: World, data: SurfaceData) {
    this.cloudU.uHeat.value = world.params.heat;
    this.cloudU.uRelief.value = RELIEF * this.opts.relief;
    this.world = world;
    this.rebuild(data);
  }

  setClouds(px: CloudPixels) {
    const tex = cloudTexturesFromPixels(px);
    [tex.main, tex.cirrus].forEach((t, i) => {
      const m = (this.clouds.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.map = t;
      m.needsUpdate = true;
    });
    this.cloudU.uCloudMap.value = tex.main;
  }

  /** Visibility-only options apply at once; mesh options take effect with the next setData. */
  setOptions(o: Partial<ViewOptions>) {
    const light = o.light !== undefined && o.light !== this.opts.light;
    this.opts = { ...this.opts, ...o };
    if (light) this.applyLighting();
    this.applyVisibility();
  }

  /** Follow: the sun is parented to the camera. Cycle: it lives in the scene and orbits the planet. */
  private applyLighting() {
    this.sun.removeFromParent();
    if (this.opts.light === 'cycle') {
      this.scene.add(this.sun);
      this.ambient.intensity = 0.16;     // night is dark, with a little moonlight
      this.ambient.color.set(0x8ea6d8);
    } else {
      this.sun.position.set(-3, 1.6, 2.2);
      this.camera.add(this.sun);
      this.ambient.intensity = 0.75;
      this.ambient.color.set(0xc8d8f0);
    }
  }

  private applyVisibility() {
    const real = this.opts.mode === 'biome';
    const photo = this.opts.look === 'photo';
    // Rivers are invisible from orbit in reality; in the photo look they appear only close up.
    const d = this.camera.position.length();
    if (this.gridLines) this.gridLines.visible = this.opts.grid && !photo;
    // Rivers and streams fade with zoom (see frame()); streams always appear after rivers.
    if (this.rivers) this.rivers.visible = this.opts.rivers && real;
    if (this.streams) this.streams.visible = this.opts.rivers && real;
    if (this.corridors) this.corridors.visible = real;
    void d; void photo;
    if (this.siteMarks) this.siteMarks.visible = this.opts.sites && !photo;
    for (const f of this.forest) f.visible = this.opts.trees && real;
    if (this.water) this.water.visible = real;
    this.clouds.visible = this.opts.clouds && real;
  }

  /** Pins on the given cells (settlement sites); redrawn with each new surface. */
  setSites(cells: number[]) {
    this.siteCells = cells;
    this.buildSites();
    this.applyVisibility();
  }

  private buildSites() {
    if (this.siteMarks) {
      this.planet.remove(this.siteMarks);
      this.siteMarks.geometry.dispose();
      (this.siteMarks.material as THREE.Material).dispose();
      this.siteMarks = undefined;
    }
    const w = this.world, s = this.surface;
    if (!w || !s || !this.siteCells.length) return;
    // Screen-sized markers: a fixed pixel size reads at every zoom, unlike a 3D pin, which
    // shrinks to nothing from orbit. Depth-tested, so the planet hides the far side.
    const P = w.grid.centers, pos: number[] = [];
    for (const c of this.siteCells) {
      const h = Math.max(s.centerH(c), SEA) + 0.004;
      pos.push(P[c * 3] * h, P[c * 3 + 1] * h, P[c * 3 + 2] * h);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: markerTexture(), transparent: true, alphaTest: 0.3, depthWrite: false });
    this.siteMarks = new THREE.Points(geo, mat);
    this.siteMarks.renderOrder = 9;
    this.planet.add(this.siteMarks);
  }

  /** Cell under a screen point, or −1. */
  pick(clientX: number, clientY: number): number {
    if (!this.terrain) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    return hit && hit.faceIndex != null ? this.faceCell[hit.faceIndex] : -1;
  }

  highlight(cell: number) {
    if (cell < 0 || !this.world || !this.surface) { this.hover.visible = false; return; }
    const g = this.world.grid;
    const pts: number[] = [];
    g.corners[cell].forEach((k, i) => {
      const h = this.surface!.outlineH(cell, i) + 0.0005;
      pts.push(g.cornerPos[k * 3] * h, g.cornerPos[k * 3 + 1] * h, g.cornerPos[k * 3 + 2] * h);
    });
    this.hover.geometry.dispose();
    this.hover.geometry = new THREE.BufferGeometry();
    this.hover.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.hover.visible = true;
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    // Keep a 40° field of view across the narrower side, so on a portrait phone the planet
    // fits the width instead of overflowing it.
    const aspect = w / h;
    this.camera.fov = aspect >= 1 ? 40 : (2 * Math.atan(Math.tan((20 * Math.PI) / 180) / aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const dt = this.frozen === null ? this.clock.getDelta() : 0;
    this.time = this.frozen ?? this.time + dt;
    this.day += dt * this.clockRate;
    const season = Math.sin((2 * Math.PI * (this.day - EQUINOX_DAY)) / YEAR_DAYS);
    this.cloudU.uSeason.value = season;
    this.cloudU.uSnow.value = this.opts.mode === 'biome' ? 1 : 0;
    if (this.opts.light === 'cycle') {
      // The sun goes round once a day, and swings north and south with the season (the tilt).
      const a = (this.day % 1) * Math.PI * 2 - 0.6;
      const dec = ((TILT * Math.PI) / 180) * season;
      this.sun.position.set(Math.sin(a) * Math.cos(dec) * 5, Math.sin(dec) * 5, Math.cos(a) * Math.cos(dec) * 5);
    }
    const d = this.camera.position.length();
    // Slow the orbit as you close in, so ground-level views stay controllable.
    this.controls.rotateSpeed = Math.min(1, (d - 1) * 0.55);
    this.controls.update();

    this.sun.getWorldPosition(this.sunDir).normalize();
    this.sunU.uSunDir.value.copy(this.sunDir);
    this.waterMat.uniforms.uTime.value += dt;
    this.waterMat.uniforms.uSunDir.value.copy(this.sunDir);

    if (this.gridLines) {
      const top = this.opts.style === 'smooth' ? 0.13 : 0.3;
      (this.gridLines.material as THREE.ShaderMaterial).uniforms.uOpacity.value = THREE.MathUtils.clamp(0.04 + (d - 1.1) * 0.08, 0.04, top);
    }
    // Clouds thin out as you descend; their shadows stay, a little softer, so the ground keeps
    // its dappled light.
    const fade = THREE.MathUtils.clamp((d - 1.3) / 1.0, 0, 1);
    const [deck, cirrus] = this.clouds.children as THREE.Mesh[];
    for (const m of [deck, cirrus]) (m.material as THREE.MeshStandardMaterial).opacity = m.userData.baseOpacity * fade;
    deck.rotation.y += dt * 0.006;
    cirrus.rotation.y += dt * 0.011;
    if (this.frozen !== null) {
      this.waterMat.uniforms.uTime.value = this.frozen;
      deck.rotation.y = this.frozen * 0.006;
      cirrus.rotation.y = this.frozen * 0.011;
    }
    this.cloudU.uCloudRot.value = deck.rotation.y;
    this.cloudU.uCloudTime.value = this.time;
    this.cloudU.uCloudSun.value.copy(this.sunDir);
    // In the photo look rivers are invisible from orbit, as in reality, and fade in on descent;
    // in the map look they always show. Streams fade in later than rivers in both.
    const fadeIn = (near: number, far: number) => 1 - THREE.MathUtils.smoothstep(d, near, far);
    const photoLook = this.opts.look === 'photo';
    this.riverMat.uniforms.uVis.value = photoLook ? fadeIn(1.22, 1.4) : 1;
    this.streamMat.uniforms.uVis.value = photoLook ? fadeIn(1.1, 1.24) : fadeIn(1.35, 1.6);
    if (this.rivers) this.rivers.visible = this.opts.rivers && this.opts.mode === 'biome' && this.riverMat.uniforms.uVis.value > 0.002;
    if (this.streams) this.streams.visible = this.opts.rivers && this.opts.mode === 'biome' && this.streamMat.uniforms.uVis.value > 0.002;
    this.cloudU.uCloudShadow.value = this.clouds.visible ? 0.22 + 0.13 * fade : 0;

    this.flora.update(this.camera.position, this.opts.trees && this.opts.mode === 'biome');
    if (this.opts.look === 'photo') {
      this.applyVisibility();
      this.composer!.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private dispose() {
    for (const o of [this.terrain, this.water, this.gridLines, this.rivers, this.streams, this.corridors]) {
      if (!o) continue;
      this.planet.remove(o);
      o.geometry.dispose();
      if (o.material !== this.waterMat && o.material !== this.riverMat && o.material !== this.streamMat && o.material !== this.corridorMat) (o.material as THREE.Material).dispose();
    }
    for (const f of this.forest) { this.planet.remove(f); f.dispose(); }
    this.terrain = this.water = this.gridLines = this.rivers = this.streams = this.corridors = undefined;
    this.forest = [];
  }

  private rebuild(data: SurfaceData) {
    const w = this.world;
    if (!w) return;
    this.dispose();
    const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos;
    const o = this.opts;
    const s = surfaceQueries(data, g);
    this.surface = s;

    this.terrain = new THREE.Mesh(toGeometry(data.terrain), makeTerrainMaterial(this.cloudU));
    this.faceCell = data.faces;
    this.planet.add(this.terrain);

    if (data.water) {
      this.water = new THREE.Mesh(toGeometry(data.water), this.waterMat);
      this.water.renderOrder = 1;
      this.planet.add(this.water);
    }

    this.forest = buildForest(data.trees);
    for (const f of this.forest) this.planet.add(f);
    this.flora.setSurface(w, data, RELIEF * o.relief);

    // Grid outlines, each edge once.
    const gl: number[] = [];
    for (let c = 0; c < N; c++) {
      const ks = g.corners[c], m = ks.length;
      for (let i = 0; i < m; i++) {
        const nb = g.neighbors[c][i];
        if (nb < c) continue;
        let h0 = s.outlineH(c, i), h1 = s.outlineH(c, (i + 1) % m);
        if (data.style === 'tiles') h0 = h1 = Math.max(h0, s.outlineH(nb, 0));
        const k0 = ks[i], k1 = ks[(i + 1) % m];
        gl.push(C[k0 * 3] * h0, C[k0 * 3 + 1] * h0, C[k0 * 3 + 2] * h0, C[k1 * 3] * h1, C[k1 * 3 + 1] * h1, C[k1 * 3 + 2] * h1);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    this.gridLines = new THREE.LineSegments(gg, makeGridMaterial(this.sunU));
    this.gridLines.renderOrder = 2;
    this.planet.add(this.gridLines);

    this.buildRivers(w, s, P, C);
    this.buildSites();
    this.applyVisibility();
    this.highlight(-1);
  }

  /**
   * Rivers as continuous ribbons of the water surface.
   *
   * Each river is traced from its mouth upstream along its biggest branch, so one channel is one
   * path. The path's control points are the points where it crosses cell edges; a Catmull-Rom
   * spline through them gives one smooth curve, drawn as one strip, so there are no joints to
   * crease. Side branches are traced the same way and end on the main channel's centreline.
   * Width follows flow; mouths reach a little way into the sea, widen, and fade to its colour.
   * Streams (below the river threshold) go in their own mesh, shown only up close.
   */
  private buildRivers(w: World, s: SurfaceQueries, P: Float32Array, C: Float32Array) {
    const g = w.grid, T = w.riverThreshold, N = g.count;
    const spacing = Math.sqrt((4 * Math.PI) / N);
    const meander = makeSimplex(w.params.seed * 5 + 13);
    const mf = 1.1 / spacing;
    const widthOf = (f: number) => spacing * Math.min(0.15, 0.022 + 0.028 * Math.log2(1 + f / T));
    const STREAM = 0.35 * T;
    const LIFT = 0.0012, RIVER_DEPTH = 0.0045, MOUTH_DEPTH = 0.0016;
    const flows = (c: number) => w.water[c] === WATER_LAND && w.temperature[c] > 0.12 && w.flow[c] >= STREAM;
    const unit = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const center = (c: number) => [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const edgePoint = (c: number, i: number): number[] => {
      const ks = g.corners[c];
      let k0 = ks[i], k1 = ks[(i + 1) % ks.length];
      if (k0 > k1) [k0, k1] = [k1, k0]; // same point from both sides
      const t = 0.3 + 0.4 * hash01(k0 * 7919 + k1);
      return unit(C[k0 * 3] + (C[k1 * 3] - C[k0 * 3]) * t, C[k0 * 3 + 1] + (C[k1 * 3 + 1] - C[k0 * 3 + 1]) * t,
        C[k0 * 3 + 2] + (C[k1 * 3 + 2] - C[k0 * 3 + 2]) * t);
    };

    type Buf = { pos: number[]; depth: number[]; fade: number[]; index: number[] };
    const riverBuf: Buf = { pos: [], depth: [], fade: [], index: [] }, streamBuf: Buf = { pos: [], depth: [], fade: [], index: [] };
    /** A control point: direction, surface height, width, water depth (colour), and whether it is river or stream. */
    /** f is opacity: 1 along the river, falling to 0 past the shore. */
    interface CP { p: number[]; h: number; w: number; d: number; river: boolean; cell: number; f?: number }
    interface Sample { x: number; y: number; z: number; w: number; d: number; river: boolean; f: number }
    /** Drawn centreline points per cell, so branches can find the channel they join. */
    const cellSamples = new Map<number, { p: number[]; h: number }[]>();

    // Green corridors: a soft strip a few river-widths wide along rivers through dry land,
    // three vertices across (clear, green, clear), opacity following how dry the land is.
    const green = { pos: [] as number[], col: [] as number[], index: [] as number[] };
    const OASIS = new THREE.Color(0x3f5a22);
    const corridor = (pts: { x: number; y: number; z: number; w: number; cell: number; river: boolean }[]) => {
      if (pts.length < 2) return;
      const dry = pts.map((p) => (p.cell >= 0 && DRY.has(w.biome[p.cell]) ? 1 : 0));
      // Smooth dryness along the path so the strip fades in and out instead of switching.
      const k = 6, sm = dry.map((_, i) => {
        let s2 = 0, n = 0;
        for (let j = Math.max(0, i - k); j <= Math.min(dry.length - 1, i + k); j++) { s2 += dry[j]; n++; }
        return s2 / n;
      });
      if (Math.max(...sm) < 0.05) return;
      const base = green.pos.length / 3;
      let sx = 1, sy = 0, sz = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const l = Math.hypot(p.x, p.y, p.z), ux = p.x / l, uy = p.y / l, uz = p.z / l;
        let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
        const tu = tx * ux + ty * uy + tz * uz;
        tx -= ux * tu; ty -= uy * tu; tz -= uz * tu;
        const cx = ty * uz - tz * uy, cy = tz * ux - tx * uz, cz = tx * uy - ty * ux, cl = Math.hypot(cx, cy, cz);
        if (cl > 1e-9) { sx = cx / cl; sy = cy / cl; sz = cz / cl; }
        // Taper both ends to nothing: at junctions the points converge and a full-width strip folds.
        const endTaper = Math.min(1, i / 4, (pts.length - 1 - i) / 4);
        const hw = Math.max(p.w * 4, spacing * (p.river ? 0.11 : 0.05)) * endTaper;
        // Above the valley walls the river carves (it writes no depth, so the river still draws
        // over it).
        const down = 1 + LIFT * 1.2 / l;
        const alpha = sm[i] * (p.river ? 0.9 : 0.55);
        for (const side of [1, 0, -1]) {
          green.pos.push((p.x + sx * hw * side) * down, (p.y + sy * hw * side) * down, (p.z + sz * hw * side) * down);
          green.col.push(OASIS.r, OASIS.g, OASIS.b, side === 0 ? alpha : 0);
        }
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 3;
        green.index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
      }
    };

    const strip = (buf: Buf, pts: Sample[]) => {
      if (pts.length < 2) return;
      const base = buf.pos.length / 3;
      let sx = 1, sy = 0, sz = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const l = Math.hypot(p.x, p.y, p.z), ux = p.x / l, uy = p.y / l, uz = p.z / l;
        // Tangent flattened onto the ground; vertical steps (waterfalls) keep the last side.
        let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
        const tu = tx * ux + ty * uy + tz * uz;
        tx -= ux * tu; ty -= uy * tu; tz -= uz * tu;
        const cx = ty * uz - tz * uy, cy = tz * ux - tx * uz, cz = tx * uy - ty * ux;
        const cl = Math.hypot(cx, cy, cz);
        if (cl > 1e-9) { sx = cx / cl; sy = cy / cl; sz = cz / cl; }
        const hw = p.w / 2;
        buf.pos.push(p.x + sx * hw, p.y + sy * hw, p.z + sz * hw, p.x - sx * hw, p.y - sy * hw, p.z - sz * hw);
        buf.depth.push(p.d, p.d);
        buf.fade.push(p.f, p.f);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2;
        buf.index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    };

    /** Spline through the control points, meander, then emit river and stream runs. */
    const emit = (cps: CP[]) => {
      if (cps.length < 2) return;
      const out: (Sample & { dir: number[]; h: number; cell: number })[] = [];
      const STEPS = 8;
      for (let k = 0; k < cps.length - 1; k++) {
        const p1 = cps[k].p, p2 = cps[k + 1].p;
        const p0 = k > 0 ? cps[k - 1].p : p1.map((v, i) => 2 * v - p2[i]);
        const p3 = k + 2 < cps.length ? cps[k + 2].p : p2.map((v, i) => 2 * v - p1[i]);
        const same = Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]) < 1e-9;
        const cell = cps[k].cell, hMid = cell >= 0 ? s.centerH(cell) : (cps[k].h + cps[k + 1].h) / 2;
        for (let st = k === 0 ? 0 : 1; st <= STEPS; st++) {
          if (same && st < STEPS) continue;       // a waterfall: just the drop
          const t = st / STEPS, t2 = t * t, t3 = t2 * t;
          const dir = unit(...([0, 1, 2].map((i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t
            + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3))) as [number, number, number]);
          const h = (1 - t) * (1 - t) * cps[k].h + 2 * t * (1 - t) * hMid + t * t * cps[k + 1].h;
          out.push({
            dir, h, cell, x: 0, y: 0, z: 0, river: cps[k + 1].river,
            w: cps[k].w + (cps[k + 1].w - cps[k].w) * t, d: cps[k].d + (cps[k + 1].d - cps[k].d) * t,
            f: (cps[k].f ?? 1) + ((cps[k + 1].f ?? 1) - (cps[k].f ?? 1)) * t,
          });
        }
      }
      // Meander sideways along the whole path, tapering to nothing at both ends so sources,
      // junctions and mouths stay put. Arc length tracks the taper.
      const arc = [0];
      for (let i = 1; i < out.length; i++) {
        const a = out[i - 1].dir, b = out[i].dir;
        arc.push(arc[i - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
      const total = arc[arc.length - 1], ramp = spacing * 0.7;
      for (let i = 0; i < out.length; i++) {
        const o = out[i], a = out[Math.max(0, i - 1)].dir, b = out[Math.min(out.length - 1, i + 1)].dir;
        const [ux, uy, uz] = o.dir;
        const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
        const perp = unit(uy * tz - uz * ty, uz * tx - ux * tz, ux * ty - uy * tx);
        const taper = Math.min(1, arc[i] / ramp, (total - arc[i]) / ramp);
        const off = taper * spacing * 0.17 * meander(ux * mf, uy * mf, uz * mf);
        const d = unit(ux + perp[0] * off, uy + perp[1] * off, uz + perp[2] * off);
        // Mouth points sit just above the sea; everything else rides LIFT above the ground.
        const h = (o.h < SEA ? o.h : Math.max(o.h, SEA)) + LIFT;
        o.x = d[0] * h; o.y = d[1] * h; o.z = d[2] * h;
        if (o.cell >= 0) {
          let list = cellSamples.get(o.cell);
          if (!list) cellSamples.set(o.cell, (list = []));
          list.push({ p: d, h: o.h });
        }
      }
      corridor(out);
      // Split into river and stream runs; the boundary point belongs to both.
      let start = 0;
      for (let i = 1; i <= out.length; i++) {
        if (i === out.length || out[i].river !== out[start].river) {
          strip(out[start].river ? riverBuf : streamBuf, out.slice(start, Math.min(out.length, i + 1)));
          start = i;
        }
      }
    };

    const nearest = (cell: number, p: number[]) => {
      let best: { p: number[]; h: number } | null = null, bd = Infinity;
      for (const smp of cellSamples.get(cell) ?? []) {
        const d = (smp.p[0] - p[0]) ** 2 + (smp.p[1] - p[1]) ** 2 + (smp.p[2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = smp; }
      }
      return best;
    };

    const drawPath = (cells: number[], junction: number) => {
      const first = cells[0], last = cells[cells.length - 1], down = w.downstream[last];
      // A river born a cell or two from the coast is a stub, not a river: skip it unless big.
      if (junction < 0 && cells.length < 3 && w.flow[last] < 4 * T) return;
      const cps: CP[] = [];
      const lakeIn = g.neighbors[first].findIndex((u) => w.downstream[u] === first && w.water[u] === WATER_LAKE);
      if (lakeIn >= 0) {
        cps.push({ p: edgePoint(first, lakeIn), h: s.edgeH(first, lakeIn)[0], w: widthOf(w.flow[first]), d: RIVER_DEPTH, river: !!w.river[first], cell: first });
      } else {
        cps.push({ p: center(first), h: s.centerH(first), w: widthOf(w.flow[first]) * 0.35, d: RIVER_DEPTH, river: !!w.river[first], cell: first });
      }
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i], next = i + 1 < cells.length ? cells[i + 1] : down;
        const j = g.neighbors[c].indexOf(next);
        if (j < 0) return;
        const [h0, h1] = s.edgeH(c, j);
        const wid = widthOf(w.flow[c]), river = !!w.river[c], e = edgePoint(c, j);
        if (i + 1 < cells.length) {
          cps.push({ p: e, h: h0, w: wid, d: RIVER_DEPTH, river, cell: next });
          if (h1 < h0 - 1e-5) cps.push({ p: e, h: h1, w: wid, d: RIVER_DEPTH, river, cell: next }); // terrace waterfall
        } else if (w.water[next] !== WATER_LAND) {
          // Mouth: a short way past the shore, widening a little and fading out, so the river
          // dissolves into the water instead of ending in a painted-on block.
          const sea = w.water[next] === WATER_OCEAN;
          const ctr = center(c);
          const outP = unit(e[0] + (e[0] - ctr[0]) * 0.25, e[1] + (e[1] - ctr[1]) * 0.25, e[2] + (e[2] - ctr[2]) * 0.25);
          cps.push({ p: e, h: h0, w: wid * 1.1, d: RIVER_DEPTH * 0.8, river, cell: -1, f: 0.9 });
          cps.push({ p: outP, h: sea ? SEA - LIFT + 0.0002 : h0, w: wid * 1.4, d: sea ? MOUTH_DEPTH : RIVER_DEPTH, river, cell: -1, f: 0 });
        } else if (junction >= 0) {
          cps.push({ p: e, h: h0, w: wid, d: RIVER_DEPTH, river, cell: junction });
          const join = nearest(junction, e) ?? { p: center(junction), h: s.centerH(junction) };
          cps.push({ p: join.p, h: join.h, w: wid, d: RIVER_DEPTH, river, cell: -1 });
        } else {
          cps.push({ p: e, h: h0, w: wid * 0.5, d: RIVER_DEPTH, river, cell: -1 }); // runs into frozen ground
        }
      }
      emit(cps);
    };

    // Trace: mouths first (biggest first), each up its biggest branch; side branches queue up
    // behind with the cell they join, so the channel they join is always drawn before them.
    const ups = (c: number) => g.neighbors[c].filter((u) => w.downstream[u] === c && flows(u));
    const queue: { start: number; junction: number }[] = [];
    for (let c = 0; c < N; c++) if (flows(c) && !flows(w.downstream[c])) queue.push({ start: c, junction: -1 });
    queue.sort((a, b) => w.flow[b.start] - w.flow[a.start]);
    for (let qi = 0; qi < queue.length; qi++) {
      const { start, junction } = queue[qi];
      const cells = [start];
      let cur = start;
      for (;;) {
        const us = ups(cur).sort((a, b) => w.flow[b] - w.flow[a]);
        if (!us.length) break;
        for (const o of us.slice(1)) queue.push({ start: o, junction: cur });
        cur = us[0];
        cells.push(cur);
      }
      cells.reverse();                       // source first, mouth (or junction) last
      drawPath(cells, junction);
    }

    const mesh = (b: Buf) => {
      if (!b.index.length) return undefined;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('depth', new THREE.Float32BufferAttribute(b.depth, 1));
      geo.setAttribute('fade', new THREE.Float32BufferAttribute(b.fade, 1));
      geo.setIndex(b.index);
      const m = new THREE.Mesh(geo, b === streamBuf ? this.streamMat : this.riverMat);
      m.renderOrder = 3;
      this.planet.add(m);
      return m;
    };
    this.rivers = mesh(riverBuf);
    this.streams = mesh(streamBuf);
    if (green.index.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(green.pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(green.col, 4));
      geo.setIndex(green.index);
      geo.computeVertexNormals();
      this.corridors = new THREE.Mesh(geo, this.corridorMat);
      this.corridors.renderOrder = 2;
      this.planet.add(this.corridors);
    }
  }
}

/** Grid lines that dim on the night side instead of glowing white in the dark. */
function makeGridMaterial(sun: { uSunDir: { value: THREE.Vector3 } }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { ...sun, uOpacity: { value: 0.2 } },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir; uniform float uOpacity;
      varying vec3 vW;
      void main() {
        float day = 0.12 + 0.88 * smoothstep(-0.15, 0.25, dot(normalize(vW), uSunDir));
        gl_FragColor = vec4(vec3(1.0), uOpacity * day);
      }`,
  });
}

/** A gold disc with a dark rim, for settlement markers. */
function markerTexture(): THREE.Texture {
  const n = 32, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
    const i = (y * n + x) * 4;
    const rim = d > 0.62;
    data[i] = rim ? 40 : 255; data[i + 1] = rim ? 25 : 196; data[i + 2] = rim ? 10 : 70;
    data[i + 3] = d < 0.95 ? 255 : 0;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Photographic grade: softer saturation and contrast, a faint cool cast, deep blacks kept. */
const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 g = mix(vec3(l), c.rgb, 0.78);                 // desaturate
      g = mix(g, g * vec3(0.96, 0.99, 1.05), 0.6);        // cool cast
      g = pow(max(g, 0.0), vec3(1.06));                  // a touch more depth in the darks
      gl_FragColor = vec4(g, c.a);
    }`,
};

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  if (m.color) g.setAttribute('color', new THREE.BufferAttribute(m.color, 3));
  if (m.depth) g.setAttribute('depth', new THREE.BufferAttribute(m.depth, 1));
  if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}
