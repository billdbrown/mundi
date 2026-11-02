import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { B } from './biomes.ts';

import { hash01 } from './rng.ts';
import { makeSimplex } from './noise.ts';
import { SEA, RELIEF, surfaceQueries, type MeshData, type SurfaceData, type SurfaceQueries } from './surface.ts';
import { buildForest, treeMaterial, treeGeometry } from './flora.ts';
import { LodFlora } from './lodflora.ts';
import { makeWaterMaterial, makeClouds, cloudTexturesFromPixels, makeAtmosphere, makeStars, makeSky, makeCloudUniforms, applyCloudShadow, makeTerrainMaterial } from './sky.ts';
import type { CloudPixels } from './clouds.ts';
import { groveFreq } from './groves.ts';
import { DunePatch } from './dunepatch.ts';
import { TerrainShadow } from './terrainshadow.ts';
import { Atmosphere, applyAerial } from './atmosphere.ts';
import { CivLayer } from './civview.ts';
import { Weather } from './weather.ts';
import { GroundProbe } from './ground.ts';
import type { History } from './civ.ts';
import { MERC_GLSL, MERC_DISCARD, MERC_MAX_Y, mercVertex, mercY, mercLat, setMercator } from './mercator.ts';
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
  private renderPass: RenderPass;
  private atmosphere: THREE.Object3D;
  private stars: THREE.Points;
  /** Physically based sky and air (atmosphere.ts). */
  private atmo = new Atmosphere();
  /**
   * TEMPORARY, for choosing by comparison: the new atmosphere or the old (A key, ?atmo=), and
   * whether the clouds take the new atmosphere's light (C key, ?cloudlight=). Remove once chosen.
   */
  private atmoNew = true;
  private cloudAtmo = { value: 1 };
  /** Low-altitude sky, aerial haze, and how far the camera has pitched up toward the horizon. */
  private sky: THREE.Mesh;
  private haze = new THREE.FogExp2(0x8fa8c8, 0);
  private tilt = 0;
  /** Flat map: an orthographic camera over Mercator space (see mercator.ts). */
  private mapMode = false;
  readonly mapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 20);
  /** Middle of the view (longitude, Mercator y) and half the view's height, in map units. */
  private map = { x: 0, y: 0, half: Math.PI };
  private graticule: THREE.LineSegments;
  /** Centuries: the history being shown, its drawing, and whether borders are on. */
  private history: History | null = null;
  private civ!: CivLayer;
  private atmoSwitch() {
    const label = document.createElement('div');
    label.className = 'ui';   // hidden in screenshots (body.capture .ui)
    label.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);padding:4px 10px;border-radius:8px;background:rgba(10,14,22,.75);color:#dfe6ef;font:12px system-ui;pointer-events:none;z-index:50';
    document.body.appendChild(label);
    const show = () => {
      label.textContent = `Atmosphere: ${this.atmoNew ? 'NEW' : 'old'} (A) · Clouds: ${this.cloudAtmo.value ? 'new light' : 'as before'} (C)`;
      const q = new URLSearchParams(location.search);
      q.set('atmo', this.atmoNew ? 'new' : 'old');
      q.set('cloudlight', this.cloudAtmo.value ? 'new' : 'old');
      history.replaceState(null, '', '?' + q.toString() + location.hash);
    };
    const q = new URLSearchParams(location.search);
    this.atmoNew = q.get('atmo') !== 'old';
    this.cloudAtmo.value = q.get('cloudlight') === 'old' ? 0 : 1;
    show();
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'a' || e.key === 'A') this.atmoNew = !this.atmoNew;
      else if (e.key === 'c' || e.key === 'C') this.cloudAtmo.value = 1 - this.cloudAtmo.value;
      else return;
      show();
    });
  }
  private prewarmed = false;
  /**
   * Shaders first needed near the ground (the ground patch, trees, the low sky) compile in the
   * background once the first world is up, rather than stalling the first descent for seconds.
   * Compiled against the target they'll draw into (the photo look renders off-screen first).
   */
  private prewarm() {
    const r = this.renderer, prev = r.getRenderTarget();
    const tree = new THREE.InstancedMesh(treeGeometry(0), treeMaterial, 1);
    tree.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
    tree.visible = false;
    this.planet.add(tree);
    const target = this.opts.look === 'photo' && this.composer ? this.composer.readBuffer : null;
    r.setRenderTarget(target);
    const jobs = [r.compileAsync(this.scene, this.camera), this.dunePatch.prewarm(r, this.camera, this.scene, target)];
    r.setRenderTarget(prev);
    Promise.all(jobs).catch(() => {}).finally(() => { this.planet.remove(tree); tree.dispose(); });
  }
  /** Fine ground under the middle of the view, where dunes stand up as shapes (dunepatch.ts). */
  private dunePatch!: DunePatch;
  /** Shadows cast by the terrain (terrainshadow.ts). */
  private terrainShadow = new TerrainShadow();
  private civBorders = false;
  /** Weather: storm schedule for this world, and weather time in days. */
  private weather?: Weather;
  private weatherDays = 4;
  /** Exact ground height on the current terrain mesh (smooth style only). */
  private probe: GroundProbe | null = null;   // a few days in, so storms are already about at load
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
    // How quickly a flung globe stops. The default 0.05 coasted too long; 0.1 halves the glide.
    this.controls.dampingFactor = 0.1;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.006;   // raised over high ground each frame (applyTilt)
    this.controls.maxDistance = 7;
    // Zoom is ours (globeZoomInput): it scales height above the ground, not distance from the
    // centre, so it is as gentle at treetop height as in orbit.
    this.controls.enableZoom = false;
    // The controls also update themselves inside pointer events, not only from frame(). Each
    // update must start from the untilted camera, or it adopts the tilted (lower) position as
    // its own and the view sinks a little with every finger or mouse movement.
    const update = this.controls.update.bind(this.controls);
    this.controls.update = (dt?: number | null) => {
      if (this.tiltActive && this.camera.position.equals(this.tiltedPos)) {
        this.camera.position.copy(this.virtualPos);
        this.camera.up.set(0, 1, 0);
      }
      const moved = update(dt);
      this.virtualPos.copy(this.camera.position);
      return moved;
    };

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
    for (const m of this.clouds.children as THREE.Mesh[]) applyAerial(m.material as THREE.Material, true, this.cloudAtmo);
    applyCloudShadow(treeMaterial, this.cloudU, this.sunU, this.flora.fade);
    applyAerial(treeMaterial, true);
    // Plants at 1/6 their first size: in proportion with the hills and dunes (chosen by comparison).
    this.flora.setScale(1 / 6);

    this.scene.add(this.planet);
    this.atmosphere = makeAtmosphere(this.sunU);
    this.stars = makeStars();
    this.scene.add(this.atmosphere, this.stars);
    this.sky = makeSky(this.sunU);
    this.scene.add(this.sky);
    this.scene.add(this.atmo.sky);
    this.atmoSwitch();
    this.scene.fog = this.haze;
    this.graticule = makeGraticule();
    this.planet.add(this.graticule);
    this.civ = new CivLayer(this.cloudU.uYear);
    this.planet.add(this.civ.group);
    this.dunePatch = new DunePatch(this.cloudU);
    this.planet.add(this.dunePatch.mesh);
    this.terrainShadow.setExtras([this.dunePatch.heightMesh]);
    this.dunePatch.onCapture = () => this.terrainShadow.invalidate();
    this.mapInput();
    this.globeZoomInput();

    // Photo look: render, grade (in linear light), then tone map and encode.
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
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
  /**
   * Sun angle round the axis for the current day. The generator's east is +longitude
   * (atan2(x, z)); the sun moves west, toward −longitude, as on Earth.
   */
  private sunAngle() { return 0.6 - (((this.day % 1) + 1) % 1) * Math.PI * 2; }
  /** Longitude angle of the point under the middle of the view. */
  private viewAngle() { return Math.atan2(this.camera.position.x, this.camera.position.z); }
  /** Local solar time (0..24) at the middle of the view, in cycle lighting. */
  localHour() {
    const h = 12 + ((this.viewAngle() - this.sunAngle()) / (Math.PI * 2)) * 24;   // east of the sun: afternoon
    return ((h % 24) + 24) % 24;
  }
  /** Move the clock within the current day so it is `hour` o'clock under the middle of the view. */
  setLocalHour(hour: number) {
    const a = this.viewAngle() - ((hour - 12) / 24) * Math.PI * 2;
    const frac = ((((0.6 - a) / (Math.PI * 2)) % 1) + 1) % 1;
    this.day = Math.floor(this.day) + frac;
  }

  freeze(t: number | null) {
    this.frozen = t;
    this.clock.getDelta();
  }

  /** Draws a world from worker-built data. */
  setData(world: World, data: SurfaceData) {
    this.cloudU.uHeat.value = world.params.heat;
    this.cloudU.uGrove.value = groveFreq(world.grid.count);
    if (this.world !== world) this.weather = new Weather(world);
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
    if (this.mapMode) {
      // The map is lit from the north-west and mostly overhead, the cartographer's hillshade.
      this.scene.add(this.sun);
      this.sun.position.set(-0.45, 0.55, 1).normalize().multiplyScalar(5);
      this.ambient.intensity = 0.8;
      this.ambient.color.set(0xc8d8f0);
    } else if (this.opts.light === 'cycle') {
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
    void d; void photo;
    if (this.siteMarks) this.siteMarks.visible = this.opts.sites && !photo;
    for (const f of this.forest) f.visible = this.opts.trees && real;
    if (this.water) this.water.visible = real;
    // The flat map is cloud-free, like the satellite composites world maps are made from:
    // flat and evenly lit, clouds hide the land (and Mercator swells the polar ones).
    this.clouds.visible = this.opts.clouds && real && !this.mapMode;
    this.stars.visible = !this.mapMode;
    if (this.mapMode) this.atmosphere.visible = false;   // on the globe, applyTilt decides
    if (this.mapMode) { this.sky.visible = false; this.haze.density = 0; }
    this.graticule.visible = this.mapMode;
    if (this.mapMode) for (const f of this.forest) f.visible = false;
  }

  /**
   * Low over the ground, look toward the horizon instead of straight down: the camera pitches
   * up as it descends (OrbitControls re-aims it at the planet's centre every frame, so the
   * pitch is reapplied each time), the sky fades in over black space, and distance fades into
   * haze. From orbit none of this applies.
   */
  private groundCell = 0;
  private virtualPos = new THREE.Vector3();
  private tiltedPos = new THREE.Vector3();
  private tiltActive = false;
  /** The cell under the camera, by walking from the last one toward the camera's direction. */
  private cellBelow(): number {
    const w = this.world;
    if (!w) return -1;
    const P = w.grid.centers, p = this.camera.position;
    let c = Math.min(this.groundCell, w.grid.count - 1);
    const score = (k: number) => P[k * 3] * p.x + P[k * 3 + 1] * p.y + P[k * 3 + 2] * p.z;
    for (let guard = 0; guard < 400; guard++) {
      let best = c, bs = score(c);
      for (const nb of w.grid.neighbors[c]) { const s = score(nb); if (s > bs) { bs = s; best = nb; } }
      if (best === c) break;
      c = best;
    }
    return (this.groundCell = c);
  }

  private applyTilt(d: number) {
    const s = (a: number, b: number) => THREE.MathUtils.smoothstep(d, a, b);
    // Keep a little clearance over the ground below, so you can skim valleys but not enter hills.
    const c = this.cellBelow();
    if (c >= 0 && this.surface) this.controls.minDistance = Math.max(1.008, Math.max(this.surface.centerH(c), SEA) + 0.007);
    // Tilt grows smoothly all the way down from 1.5 radii, most of it near the ground, up to
    // ~66°. The view pivots about the ground point at the middle of the screen, which stays put:
    // zooming in always closes on the spot you were looking at.
    const t = 1 - s(1.012, 1.5);
    // Up to ~75° at the lowest: with a 40° view the horizon stays in frame.
    this.tilt = 1.3 * t * t;
    this.tiltActive = this.tilt > 1e-4;
    if (this.tiltActive) {
      const up = this.camera.position.clone().normalize();
      const ground = this.probe ? Math.max(SEA, this.probe.heightAt(up.x, up.y, up.z, SEA)) : SEA;
      const target = up.clone().multiplyScalar(ground);
      let north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y);
      if (north.lengthSq() < 1e-6) north = new THREE.Vector3(0, 0, -1).addScaledVector(up, up.z);
      north.normalize();
      const dist = Math.max(0.006, d - ground);
      const pos = target.clone()
        .addScaledVector(up, Math.cos(this.tilt) * dist)
        .addScaledVector(north, -Math.sin(this.tilt) * dist);
      // Keep clear of hills between the camera and its target.
      const l = pos.length();
      const under = this.probe ? Math.max(SEA, this.probe.heightAt(pos.x, pos.y, pos.z, SEA)) : SEA;
      if (l < under + 0.0025) pos.multiplyScalar((under + 0.0025) / l);
      this.camera.position.copy(pos);
      this.camera.up.copy(up);
      this.camera.lookAt(target);
      this.tiltedPos.copy(pos);
    }
    const low = 1 - s(1.06, 1.26);
    (this.sky.material as THREE.ShaderMaterial).uniforms.uLow.value = low;
    this.sky.visible = low > 0.001;
    this.sky.position.copy(this.camera.position);
    // The space-view atmosphere shells would wrap the camera in white once it is inside them.
    this.atmosphere.visible = low < 0.6 && !this.mapMode;
    const day = THREE.MathUtils.smoothstep(this.camera.position.clone().normalize().dot(this.sunDir), -0.12, 0.25);
    (this.stars.material as THREE.PointsMaterial).opacity = 0.7 * (1 - low * day);
    // Haze colour follows the sky at the horizon (dark at night); density grows as you descend.
    this.haze.color.setRGB(0.36, 0.48, 0.66).multiplyScalar(0.12 + 0.88 * day);
    this.haze.density = low * low * 1.3;
    // Low down, the follow-light swings round to the side and drops, so it rakes across the
    // terrain and relief reads (from the camera's side, slopes shade almost evenly).
    if (this.opts.light === 'follow' && this.sun.parent === this.camera) {
      const k = 1 - s(1.03, 1.4);
      this.sun.position.set(-3 - 1.5 * k, 1.6 - 0.9 * k, 2.2 - 2.4 * k);
    }
  }

  // --- Centuries ------------------------------------------------------------------------------

  /** Show a history (null clears it). Drawn on the current surface, and again after rebuilds. */
  setHistory(h: History | null) {
    this.history = h;
    this.buildCiv();
  }
  /** The year shown (−1 hides civilisation); borders on or off. */
  setCiv(year: number, borders: boolean) {
    this.cloudU.uYear.value = year;
    this.civBorders = borders && year >= 0;
  }
  private buildCiv() {
    const mat = this.terrain?.material as THREE.MeshStandardMaterial | undefined;
    const on = !!(this.history && this.terrain && this.world && this.surface && this.opts.style === 'smooth');
    if (on) this.civ.build(this.world!, this.history!, this.terrain!, this.faceCell, this.surface!);
    else this.civ.dispose();
    this.flora.setClearing(on ? this.civ.clearYear : null);
    if (mat) {
      const d = (mat.defines ??= {});
      if (on !== ('USE_CIV' in d)) {
        if (on) d.USE_CIV = ''; else delete d.USE_CIV;
        mat.needsUpdate = true;
      }
    }
    if (this.mapMode) setMercator(this.civ.group, true);
  }

  // --- Flat map -------------------------------------------------------------------------------

  isMap() { return this.mapMode; }

  /** Switch between the globe and the flat map. The map opens centred on what the globe showed. */
  setMap(on: boolean) {
    if (on === this.mapMode) return;
    this.mapMode = on;
    if (on) {
      const p = this.camera.position;
      this.map.x = Math.atan2(p.x, p.z);
      this.map.y = mercY(Math.asin(p.y / p.length()));
      this.map.half = this.maxHalf();
      this.clampMap();
    } else {
      // Back on the globe, look at whatever was in the middle of the map, from the same height.
      const lat = mercLat(this.map.y), lon = this.map.x, d = this.camera.position.length();
      this.camera.position.set(Math.cos(lat) * Math.sin(lon) * d, Math.sin(lat) * d, Math.cos(lat) * Math.cos(lon) * d);
      this.camera.lookAt(0, 0, 0);
    }
    setMercator(this.planet, on);
    this.controls.enabled = !on;
    this.applyLighting();
    this.applyVisibility();
  }

  private aspect() { return this.container.clientWidth / Math.max(1, this.container.clientHeight); }
  /** Zoomed fully out, the map is exactly one world wide (or tall, on a portrait screen). */
  private maxHalf() { return Math.min(MERC_MAX_Y, Math.PI / this.aspect()); }
  private clampMap() {
    const m = this.map;
    m.half = THREE.MathUtils.clamp(m.half, 0.004, this.maxHalf());
    m.y = THREE.MathUtils.clamp(m.y, -MERC_MAX_Y + m.half, MERC_MAX_Y - m.half);
    m.x = THREE.MathUtils.euclideanModulo(m.x + Math.PI, Math.PI * 2) - Math.PI;
  }
  /** Map coordinates under a screen point. */
  private mapAt(clientX: number, clientY: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -((clientY - r.top) / r.height) * 2 + 1;
    return { x: this.map.x + nx * this.map.half * this.aspect(), y: this.map.y + ny * this.map.half, nx, ny };
  }
  private zoomMap(clientX: number, clientY: number, factor: number) {
    const a = this.mapAt(clientX, clientY);
    this.map.half *= factor;
    this.clampMap();
    this.map.x = a.x - a.nx * this.map.half * this.aspect();
    this.map.y = a.y - a.ny * this.map.half;
    this.clampMap();
  }
  /** Drag to pan (it wraps east-west), wheel or pinch to zoom about the pointer. */
  private mapInput() {
    const el = this.renderer.domElement;
    const ptrs = new Map<number, { x: number; y: number }>();
    el.addEventListener('pointerdown', (e) => {
      if (!this.mapMode) return;
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', (e) => {
      const prev = ptrs.get(e.pointerId);
      if (!this.mapMode || !prev) return;
      if (ptrs.size === 1) {
        const u = (2 * this.map.half) / el.clientHeight;
        this.map.x -= (e.clientX - prev.x) * u;
        this.map.y += (e.clientY - prev.y) * u;
        this.clampMap();
      } else if (ptrs.size === 2) {
        const other = [...ptrs.entries()].find(([id]) => id !== e.pointerId)![1];
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0 && after > 0) this.zoomMap((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, before / after);
      }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      if (!this.mapMode) return;
      e.preventDefault();
      this.zoomMap(e.clientX, e.clientY, Math.exp(e.deltaY * 0.001));
    }, { passive: false });
  }
  /**
   * Wheel and pinch on the globe. Each gesture multiplies the height above the ground, applied
   * in frame() to the untilted camera. Scaling distance from the centre instead (the controls'
   * own dolly) made a small pinch near the ground jump to orbit or snap onto the surface.
   */
  private zoomPending = 1;
  private globeZoomInput() {
    const el = this.renderer.domElement;
    const touches = new Map<number, { x: number; y: number }>();
    // iOS Safari ignores user-scalable=no; its own gesture events are the way to stop page zoom.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', (e) => {
      const prev = touches.get(e.pointerId);
      if (!prev) return;
      if (touches.size === 2 && !this.mapMode) {
        const other = [...touches.entries()].find(([id]) => id !== e.pointerId)![1];
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 4 && after > 4) this.zoomPending *= Math.pow(before / after, 1.6);
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const up = (e: PointerEvent) => { touches.delete(e.pointerId); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      if (this.mapMode) return;
      e.preventDefault();
      // Lines or pages from some mice; pixels from trackpads.
      const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      this.zoomPending *= Math.exp(THREE.MathUtils.clamp(px, -300, 300) * 0.0016);
    }, { passive: false });
  }
  /** Apply pending zoom to the (untilted) camera: height above the ground times the factor. */
  private applyZoom() {
    if (this.zoomPending === 1) return;
    const p = this.camera.position, d = p.length();
    const ground = this.controls.minDistance - 0.007;
    const nd = THREE.MathUtils.clamp(ground + (d - ground) * this.zoomPending, this.controls.minDistance, this.controls.maxDistance);
    p.setLength(nd);
    this.zoomPending = 1;
  }
  private updateMapCam() {
    const m = this.map, a = this.aspect(), c = this.mapCam;
    c.left = -m.half * a; c.right = m.half * a; c.top = m.half; c.bottom = -m.half;
    c.position.set(m.x, m.y, 5);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }
  /** Ground distance (planet radii) per screen pixel at the middle of the view: the scale bar. */
  groundPerPx(): number {
    const h = Math.max(1, this.renderer.domElement.clientHeight);
    if (this.mapMode) return ((2 * this.map.half) / h) * Math.cos(mercLat(this.map.y));
    const above = Math.max(1e-4, this.camera.position.length() - 1);
    return (2 * above * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
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
    if (this.mapMode) setMercator(this.siteMarks, true);
  }

  /** Cell under a screen point, or −1. */
  pick(clientX: number, clientY: number): number {
    if (!this.terrain) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    if (this.mapMode) {
      // Straight down onto the globe from above the map point.
      const a = this.mapAt(clientX, clientY);
      if (Math.abs(a.y) > MERC_MAX_Y) return -1;
      const lat = mercLat(a.y), dir = new THREE.Vector3(Math.cos(lat) * Math.sin(a.x), Math.sin(lat), Math.cos(lat) * Math.cos(a.x));
      this.raycaster.set(dir.clone().multiplyScalar(1.5), dir.negate());
    } else {
      this.raycaster.setFromCamera(ndc, this.camera);
    }
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

  /**
   * Resolution follows the frame rate. A Retina screen has four times the pixels of a plain one,
   * and the terrain shader is heavy close in; when frames run slow the render resolution steps
   * down (to 1x at worst), and creeps back up when there is room. Raising waits longer than
   * lowering, and a raise that has to be undone soon after lowers the ceiling for a while, so it
   * settles instead of see-sawing. Off while frozen (tests and captures stay repeatable).
   */
  private res = { max: Math.min(devicePixelRatio, 2), ratio: Math.min(devicePixelRatio, 2), ceil: Math.min(devicePixelRatio, 2), ema: 16, last: 0, slow: 0, fast: 0, raisedAt: -1e9, ceilAt: -1e9 };
  private adaptResolution() {
    const r = this.res, now = performance.now(), dt = now - r.last;
    r.last = now;
    if (this.frozen !== null || dt <= 0 || dt > 250) { r.slow = r.fast = 0; return; }
    r.ema += (dt - r.ema) * 0.1;
    if (now - r.ceilAt > 30000) r.ceil = r.max;
    r.slow = r.ema > 24 ? r.slow + dt : 0;
    r.fast = r.ema < 18 ? r.fast + dt : 0;
    let next = r.ratio;
    if (r.slow > 800 && r.ratio > 1) {
      next = Math.max(1, r.ratio - 0.25);
      if (now - r.raisedAt < 4000) { r.ceil = next; r.ceilAt = now; }
    } else if (r.fast > 3000 && r.ratio < r.ceil) {
      next = Math.min(r.ceil, r.ratio + 0.25);
      r.raisedAt = now;
    }
    if (next === r.ratio) return;
    r.ratio = next; r.slow = r.fast = 0; r.ema = 16;
    this.renderer.setPixelRatio(next);
    this.composer?.setPixelRatio(next);
  }

  private frame() {
    this.adaptResolution();
    const dt = this.frozen === null ? this.clock.getDelta() : 0;
    this.time = this.frozen ?? this.time + dt;
    this.day += dt * this.clockRate;
    const season = Math.sin((2 * Math.PI * (this.day - EQUINOX_DAY)) / YEAR_DAYS);
    this.cloudU.uSeason.value = season;
    this.cloudU.uSnow.value = this.opts.mode === 'biome' ? 1 : 0;
    if (this.opts.light === 'cycle' && !this.mapMode) {
      // The sun goes round once a day, and swings north and south with the season (the tilt).
      const a = this.sunAngle();
      const dec = ((TILT * Math.PI) / 180) * season;
      this.sun.position.set(Math.sin(a) * Math.cos(dec) * 5, Math.sin(dec) * 5, Math.cos(a) * Math.cos(dec) * 5);
    }
    // On the map, an equivalent "camera distance" from the zoom (the globe's camera sees about
    // 0.73 radii of ground per radius of height), so fades and detail behave the same.
    let d: number;
    if (this.mapMode) {
      this.updateMapCam();
      this.dunePatch.update(this.renderer, this.virtualPos, 99, false);
      const dist = 2.75 * this.map.half * Math.cos(mercLat(this.map.y));
      this.cloudU.uMapDist.value = dist;
      d = 1 + dist;
    } else {
      // The controls drive a "virtual" camera that always looks at the centre; the drawn camera
      // is that one, tilted (applyTilt). Put the virtual one back first, unless something else
      // (flyTo, a test) has moved the camera since.
      if (this.tiltActive && this.camera.position.equals(this.tiltedPos)) this.camera.position.copy(this.virtualPos);
      this.camera.up.set(0, 1, 0);
      this.applyZoom();
      d = this.camera.position.length();
      // Slow the orbit as you close in, so ground-level views stay controllable.
      this.controls.rotateSpeed = Math.min(1, (d - 1) * 0.55);
      this.controls.update();
      this.virtualPos.copy(this.camera.position);
      this.applyTilt(d);
      // The patch centres on the point in the middle of the view: the untilted camera's nadir.
      this.dunePatch.update(this.renderer, this.virtualPos, d, this.opts.mode === 'biome' && this.opts.style === 'smooth', this.frozen === null);
    }

    this.sun.getWorldPosition(this.sunDir).normalize();
    this.terrainShadow.update(this.renderer, this.virtualPos, this.mapMode ? 99 : this.virtualPos.length(), this.sunDir, !this.mapMode);
    this.sunU.uSunDir.value.copy(this.sunDir);
    this.waterMat.uniforms.uTime.value += dt;
    this.waterMat.uniforms.uSunDir.value.copy(this.sunDir);

    if (this.gridLines) {
      const top = this.opts.style === 'smooth' ? 0.13 : 0.3;
      (this.gridLines.material as THREE.ShaderMaterial).uniforms.uOpacity.value = THREE.MathUtils.clamp(0.04 + (d - 1.1) * 0.08, 0.09, top);
    }
    // Clouds thin out as you descend; their shadows stay, a little softer, so the ground keeps
    // its dappled light.
    const fade = THREE.MathUtils.clamp((d - 1.3) / 1.0, 0, 1);
    const [deck, cirrus] = this.clouds.children as THREE.Mesh[];
    for (const m of [deck, cirrus]) (m.material as THREE.MeshStandardMaterial).opacity = m.userData.baseOpacity * fade;
    // The deck stays put; the wind bands move its clouds (coverAt). Weather time runs with the
    // Day clock; otherwise (idle, or the Year clock, which would strobe) it drifts slowly.
    deck.rotation.y = 0;
    cirrus.rotation.y += dt * 0.011;
    this.weatherDays += dt * (this.clockRate > 0 && this.clockRate <= 1 ? this.clockRate : 0.01);
    if (this.frozen !== null) {
      this.waterMat.uniforms.uTime.value = this.frozen;
      cirrus.rotation.y = this.frozen * 0.011;
      this.weatherDays = 4 + this.frozen * 0.01;
    }
    this.cloudU.uCloudRot.value = 0;
    this.cloudU.uWeather.value = this.weatherDays;
    this.weather?.update(this.weatherDays, this.cloudU.uStorms.value);
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

    this.flora.update(this.camera.position, this.opts.trees && this.opts.mode === 'biome' && !this.mapMode, this.frozen !== null);
    const civOn = this.cloudU.uYear.value >= 0;
    this.civ.group.visible = civOn;
    if (civOn) this.civ.setVisibility(this.mapMode ? 2 : d, this.civBorders);
    // The new atmosphere replaces the old sky dome, limb shells and haze.
    const atmoOn = this.atmoNew && !this.mapMode;
    this.atmo.update(this.renderer, this.camera, this.sunDir, atmoOn);
    if (atmoOn) {
      this.sky.visible = false;
      this.atmosphere.visible = false;
      this.haze.density = 0;
    }
    const sm = this.stars.material as THREE.PointsMaterial;
    // Under the new sky, stars draw before it (as opaque, without depth) so it can dim them.
    if (sm.transparent === atmoOn) { sm.transparent = !atmoOn; sm.depthWrite = false; sm.needsUpdate = true; }
    const cam = this.mapMode ? this.mapCam : this.camera;
    if (this.opts.look === 'photo') {
      this.applyVisibility();
      this.renderPass.camera = cam;
      this.composer!.render();
    } else {
      this.renderer.render(this.scene, cam);
    }
  }

  private dispose() {
    for (const o of [this.terrain, this.water, this.gridLines, this.rivers, this.streams]) {
      if (!o) continue;
      this.planet.remove(o);
      o.geometry.dispose();
      if (o.material !== this.waterMat && o.material !== this.riverMat && o.material !== this.streamMat) (o.material as THREE.Material).dispose();
    }
    for (const f of this.forest) { this.planet.remove(f); f.dispose(); }
    this.terrain = this.water = this.gridLines = this.rivers = this.streams = undefined;
    this.dunePatch?.setTerrain(null);
    this.terrainShadow?.setTerrain(null);
    this.dunePatch?.setRivers([]);
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

    this.terrain = new THREE.Mesh(toGeometry(data.terrain), makeTerrainMaterial(this.cloudU, !!data.terrain.climate));
    this.faceCell = data.faces;
    this.planet.add(this.terrain);
    this.dunePatch.setTerrain(data.style === 'smooth' ? this.terrain : null);
    this.terrainShadow.setTerrain(this.terrain);
    if (!this.prewarmed && data.style === 'smooth') { this.prewarmed = true; setTimeout(() => this.prewarm(), 0); }

    if (data.water) {
      this.water = new THREE.Mesh(toGeometry(data.water), this.waterMat);
      this.water.renderOrder = 1;
      this.planet.add(this.water);
    }

    this.forest = buildForest(data.trees);
    for (const f of this.forest) this.planet.add(f);
    this.flora.setSurface(w, data, RELIEF * o.relief);

    this.probe = data.style === 'smooth' ? GroundProbe.fromMesh(g, this.terrain, data.faces) : null;
    // Grid outlines, each edge once. On the smooth surface each edge is draped over the ground
    // in a few steps (over water, at the water level), so lines lie on the land rather than
    // floating over valleys.
    const gl: number[] = [];
    const probe = this.probe, SUB = 4, GLIFT = 0.00035;
    const drape = (x: number, y: number, z: number, cell: number) => {
      const l = Math.hypot(x, y, z);
      const h = Math.max(probe!.heightAt(x, y, z, SEA, probe!.cellOf(x, y, z, cell)), SEA) + GLIFT;
      return [(x / l) * h, (y / l) * h, (z / l) * h];
    };
    for (let c = 0; c < N && !data.grid; c++) {
      const ks = g.corners[c], m = ks.length;
      for (let i = 0; i < m; i++) {
        const nb = g.neighbors[c][i];
        if (nb < c) continue;
        const k0 = ks[i], k1 = ks[(i + 1) % m];
        if (probe) {
          let prev = drape(C[k0 * 3], C[k0 * 3 + 1], C[k0 * 3 + 2], c);
          for (let j = 1; j <= SUB; j++) {
            const t = j / SUB;
            const next = drape(C[k0 * 3] + (C[k1 * 3] - C[k0 * 3]) * t, C[k0 * 3 + 1] + (C[k1 * 3 + 1] - C[k0 * 3 + 1]) * t,
              C[k0 * 3 + 2] + (C[k1 * 3 + 2] - C[k0 * 3 + 2]) * t, c);
            gl.push(...prev, ...next);
            prev = next;
          }
          continue;
        }
        let h0 = s.outlineH(c, i), h1 = s.outlineH(c, (i + 1) % m);
        if (data.style === 'tiles') h0 = h1 = Math.max(h0, s.outlineH(nb, 0));
        gl.push(C[k0 * 3] * h0, C[k0 * 3 + 1] * h0, C[k0 * 3 + 2] * h0, C[k1 * 3] * h1, C[k1 * 3 + 1] * h1, C[k1 * 3 + 2] * h1);
      }
    }
    const gg = new THREE.BufferGeometry();
    // The worker drapes the grid on the smooth surface (exact mesh vertices); fall back otherwise.
    gg.setAttribute('position', data.grid ? new THREE.BufferAttribute(data.grid, 3) : new THREE.Float32BufferAttribute(gl, 3));
    this.gridLines = new THREE.LineSegments(gg, makeGridMaterial(this.sunU));
    this.gridLines.renderOrder = 2;
    this.planet.add(this.gridLines);

    this.buildRivers(w, s, P, C);
    this.buildSites();
    this.buildCiv();
    if (this.mapMode) setMercator(this.planet, true);
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
    /** Drawn channel points per cell (x, y, z, half-width), so trees keep out of the water. */
    const riverPts = new Map<number, number[]>();
    /** Drawn river segments (not streams) per cell: a (3), b (3), width. For riverside trees. */
    const riverSegs = new Map<number, number[]>();
    /** Green-corridor segments along rivers through dry land: a, b (unit directions), half-width, strength, cell. */
    const corr: number[] = [];
    const DRY = new Set<number>([B.DESERT, B.SAVANNA, B.STEPPE, B.BEACH, B.TUNDRA]);


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
        // Mouth points sit just above the sea; on land the water lies just above the ground as
        // drawn (the lowest of the channel's middle and its two banks), so it never floats.
        let h = (o.h < SEA ? o.h : Math.max(o.h, SEA)) + LIFT;
        if (this.probe && o.h >= SEA && o.f > 0.5) {
          const hw = o.w;
          const g0 = this.probe.heightAt(d[0], d[1], d[2], h);
          const g1 = this.probe.heightAt(d[0] + perp[0] * hw, d[1] + perp[1] * hw, d[2] + perp[2] * hw, g0);
          const g2 = this.probe.heightAt(d[0] - perp[0] * hw, d[1] - perp[1] * hw, d[2] - perp[2] * hw, g0);
          h = Math.max(SEA + 0.0002, Math.min(g0, g1, g2) + 0.0002);
        }
        o.x = d[0] * h; o.y = d[1] * h; o.z = d[2] * h;
        if (o.cell >= 0) {
          let list = cellSamples.get(o.cell);
          if (!list) cellSamples.set(o.cell, (list = []));
          list.push({ p: d, h: o.h });
          let rp = riverPts.get(o.cell);
          if (!rp) riverPts.set(o.cell, (rp = []));
          rp.push(d[0], d[1], d[2], o.w);
          if (i > 0 && o.river && out[i - 1].river) {
            const pr = out[i - 1], pl = Math.hypot(pr.x, pr.y, pr.z) || 1;
            let rs = riverSegs.get(o.cell);
            if (!rs) riverSegs.set(o.cell, (rs = []));
            rs.push(pr.x / pl, pr.y / pl, pr.z / pl, d[0], d[1], d[2], o.w);
          }
        }
      }
      // Corridor segments for the river (not stream) parts, with dryness smoothed along the path
      // so the green fades in and out rather than switching at a cell edge.
      const dry = out.map((o) => (o.cell >= 0 && DRY.has(w.biome[o.cell]) ? 1 : 0));
      for (let i = 1; i < out.length; i++) {
        const a = out[i - 1], b = out[i];
        if (!a.river || !b.river || b.cell < 0) continue;
        let sd = 0, n = 0;
        for (let j = Math.max(0, i - 6); j <= Math.min(out.length - 1, i + 6); j++) { sd += dry[j]; n++; }
        if (sd / n < 0.05) continue;
        const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
        corr.push(a.x / la, a.y / la, a.z / la, b.x / lb, b.y / lb, b.z / lb, Math.max(b.w * 5, spacing * 0.24), sd / n, b.cell);
      }
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
    this.dunePatch.setRivers([this.rivers, this.streams]);
    this.terrainShadow.setRivers(this.rivers, this.streams);
    this.paintCorridors(w, corr);
    const gap = spacing / 8;
    // Riverside trees: how far a point is from the nearest drawn river, in radians past its bank.
    this.flora.setRiverside((x, y, z, cell) => {
      const l = Math.hypot(x, y, z), px = x / l, py = y / l, pz = z / l;
      let best = Infinity;
      for (const k of [cell, ...g.neighbors[cell]]) {
        const a = riverSegs.get(k);
        if (!a) continue;
        for (let i = 0; i < a.length; i += 7) {
          const bx = a[i + 3] - a[i], by = a[i + 4] - a[i + 1], bz = a[i + 5] - a[i + 2];
          const qx = px - a[i], qy = py - a[i + 1], qz = pz - a[i + 2];
          const t = Math.max(0, Math.min(1, (qx * bx + qy * by + qz * bz) / Math.max(1e-14, bx * bx + by * by + bz * bz)));
          best = Math.min(best, Math.hypot(qx - bx * t, qy - by * t, qz - bz * t) - a[i + 6] * 0.5);
        }
      }
      return best;
    }, (cell) => !!w.river[cell] || g.neighbors[cell].some((n) => !!w.river[n]));
    this.flora.setWater((x, y, z, cell) => {
      const l = Math.hypot(x, y, z);
      for (const k of [cell, ...g.neighbors[cell]]) {
        const a = riverPts.get(k);
        if (!a) continue;
        for (let i = 0; i < a.length; i += 4) {
          const r = Math.max(a[i + 3] * 1.5, gap * 0.6);
          const dx = x / l - a[i], dy = y / l - a[i + 1], dz = z / l - a[i + 2];
          if (dx * dx + dy * dy + dz * dz < r * r) return true;
        }
      }
      return false;
    });
  }

  /**
   * Green corridors along rivers through dry land (the Nile from space), painted into the
   * terrain's vertex colours so they lie on the ground. (They used to be a separate flat strip
   * at river level, which poked up through the valley's creases as long thin wedges.)
   * Distances are to the drawn, meandering river, so the green follows the water.
   */
  private paintCorridors(w: World, seg: number[]) {
    if (!this.terrain || this.opts.mode !== 'biome' || !seg.length) return;
    const g = w.grid, S = 9;
    const byCell = new Map<number, number[]>();
    const put = (c: number, i: number) => { let l = byCell.get(c); if (!l) byCell.set(c, (l = [])); l.push(i); };
    for (let i = 0; i < seg.length; i += S) {
      const c = seg[i + 8];
      put(c, i);
      for (const nb of g.neighbors[c]) put(nb, i);
    }
    const geo = this.terrain.geometry, pos = geo.getAttribute('position'), col = geo.getAttribute('color');
    const index = geo.getIndex(), faces = this.faceCell, done = new Uint8Array(pos.count);
    const green = new THREE.Color(0x3f5a22);
    for (let t = 0; t < faces.length; t++) {
      const list = byCell.get(faces[t]);
      if (!list) continue;
      for (let j = 0; j < 3; j++) {
        const v = index ? index.getX(t * 3 + j) : t * 3 + j;
        if (done[v]) continue;
        done[v] = 1;
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v), l = Math.hypot(x, y, z);
        if (l <= SEA) continue;
        const px = x / l, py = y / l, pz = z / l;
        let best = 0;
        for (const i of list) {
          const ax = seg[i], ay = seg[i + 1], az = seg[i + 2];
          const bx = seg[i + 3] - ax, by = seg[i + 4] - ay, bz = seg[i + 5] - az;
          const qx = px - ax, qy = py - ay, qz = pz - az;
          const tt = Math.max(0, Math.min(1, (qx * bx + qy * by + qz * bz) / Math.max(1e-14, bx * bx + by * by + bz * bz)));
          const f = 1 - Math.hypot(qx - bx * tt, qy - by * tt, qz - bz * tt) / seg[i + 6];
          if (f > 0) best = Math.max(best, f * seg[i + 7]);
        }
        if (best <= 0) continue;
        const k = best * best * (3 - 2 * best) * 0.9;
        col.setXYZ(v, col.getX(v) + (green.r - col.getX(v)) * k, col.getY(v) + (green.g - col.getY(v)) * k, col.getZ(v) + (green.b - col.getZ(v)) * k);
      }
    }
    col.needsUpdate = true;
  }
}

/** Grid lines that dim on the night side instead of glowing white in the dark. */
function makeGridMaterial(sun: { uSunDir: { value: THREE.Vector3 } }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { ...sun, uOpacity: { value: 0.2 } },
    vertexShader: /* glsl */`
      varying vec3 vW;
      ${MERC_GLSL}
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        #ifdef MERCATOR
          ${mercVertex('w.xyz')}
        #else
          gl_Position = projectionMatrix * viewMatrix * w;
        #endif
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir; uniform float uOpacity;
      varying vec3 vW;
      ${MERC_GLSL}
      void main() {
        ${MERC_DISCARD}
        #ifdef MERCATOR
          gl_FragColor = vec4(vec3(1.0), uOpacity);
          return;
        #endif
        float day = 0.12 + 0.88 * smoothstep(-0.15, 0.25, dot(normalize(vW), uSunDir));
        gl_FragColor = vec4(vec3(1.0), uOpacity * day);
      }`,
  });
}

/** Parallels and meridians every 30°, shown only on the flat map, above the clouds. */
function makeGraticule(): THREE.LineSegments {
  const r = 1.032, pts: number[] = [];
  const at = (lat: number, lon: number) => {
    const a = (lat * Math.PI) / 180, o = (lon * Math.PI) / 180;
    return [Math.cos(a) * Math.sin(o) * r, Math.sin(a) * r, Math.cos(a) * Math.cos(o) * r];
  };
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 2) pts.push(...at(lat, lon), ...at(lat, lon + 2));
  for (let lon = -150; lon < 180; lon += 30) for (let lat = -84; lat < 84; lat += 2) pts.push(...at(lat, lon), ...at(lat + 2, lon));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xdfe8f5, transparent: true, opacity: 0.1, depthWrite: false }));
  l.renderOrder = 6;
  l.visible = false;
  return l;
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
  if (m.climate) g.setAttribute('climate', new THREE.BufferAttribute(m.climate, 2));
  if (m.depth) g.setAttribute('depth', new THREE.BufferAttribute(m.depth, 1));
  if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}
