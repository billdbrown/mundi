import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BIOMES } from './biomes.ts';
import { WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { hash01 } from './rng.ts';
import { makeSimplex } from './noise.ts';
import { buildSmooth, buildTiles, SEA, type Surface } from './surface.ts';
import { buildForest, treeMaterial } from './flora.ts';
import { makeWaterMaterial, makeClouds, cloudTextures, makeAtmosphere, makeStars, makeCloudUniforms, applyCloudShadow, makeTerrainMaterial } from './sky.ts';

export type ViewMode = 'biome' | 'elevation' | 'temperature' | 'moisture' | 'plates';
export type TerrainStyle = 'smooth' | 'tiles';

export interface ViewOptions {
  mode: ViewMode;
  style: TerrainStyle;
  grid: boolean;
  rivers: boolean;
  trees: boolean;
  clouds: boolean;
  blend: boolean;
  relief: number;
}

const REBUILD_KEYS: (keyof ViewOptions)[] = ['mode', 'style', 'blend', 'relief'];

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
  private gridLines?: THREE.LineSegments;
  private rivers?: THREE.Mesh;
  private forest: THREE.InstancedMesh[] = [];
  private clouds: THREE.Group = makeClouds();
  private cloudSeed = -1;
  private hover: THREE.LineLoop;
  private sun: THREE.DirectionalLight;
  private surface?: Surface;
  private faceCell: Int32Array = new Int32Array(0);
  private world?: World;
  private opts: ViewOptions = { mode: 'biome', style: 'smooth', grid: true, rivers: true, trees: true, clouds: true, blend: true, relief: 1 };
  private raycaster = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private sunDir = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.003, 200);
    this.camera.position.set(0, 0.9, 3.4);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x04060b);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 7;
    this.controls.zoomSpeed = 0.8;

    // The sun rides with the camera, off to one side, so the view is lit but relief still shades.
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
    this.sun.position.set(-3, 1.6, 2.2);
    this.camera.add(this.sun);
    // Ambient, not hemisphere: a hemisphere light's "up" is world +Y, which means nothing on a sphere.
    this.scene.add(new THREE.AmbientLight(0xc8d8f0, 0.75));

    this.hover = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.hover.renderOrder = 10;
    this.hover.visible = false;
    this.planet.add(this.hover);
    this.planet.add(this.clouds);
    applyCloudShadow(treeMaterial, this.cloudU);

    this.scene.add(this.planet);
    this.scene.add(makeAtmosphere());
    this.scene.add(makeStars());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setWorld(world: World) {
    this.world = world;
    if (this.cloudSeed !== world.params.seed) {
      const tex = cloudTextures(world.params.seed);
      [tex.main, tex.cirrus].forEach((t, i) => {
        const m = (this.clouds.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
        m.map = t;
        m.needsUpdate = true;
      });
      this.cloudU.uCloudMap.value = tex.main;
      this.cloudSeed = world.params.seed;
    }
    this.rebuild();
  }

  setOptions(o: Partial<ViewOptions>) {
    const rebuild = REBUILD_KEYS.some((k) => o[k] !== undefined && o[k] !== this.opts[k])
      || (o.trees === true && !this.opts.trees);
    this.opts = { ...this.opts, ...o };
    if (rebuild) this.rebuild();
    this.applyVisibility();
  }

  private applyVisibility() {
    const real = this.opts.mode === 'biome';
    if (this.gridLines) this.gridLines.visible = this.opts.grid;
    if (this.rivers) this.rivers.visible = this.opts.rivers && real;
    for (const f of this.forest) f.visible = this.opts.trees && real;
    if (this.water) this.water.visible = real;
    this.clouds.visible = this.opts.clouds && real;
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const dt = this.clock.getDelta();
    const d = this.camera.position.length();
    // Slow the orbit as you close in, so ground-level views stay controllable.
    this.controls.rotateSpeed = Math.min(1, (d - 1) * 0.55);
    this.controls.update();

    this.sun.getWorldPosition(this.sunDir).normalize();
    this.waterMat.uniforms.uTime.value += dt;
    this.waterMat.uniforms.uSunDir.value.copy(this.sunDir);

    if (this.gridLines) {
      const top = this.opts.style === 'smooth' ? 0.13 : 0.3;
      (this.gridLines.material as THREE.LineBasicMaterial).opacity = THREE.MathUtils.clamp(0.04 + (d - 1.1) * 0.08, 0.04, top);
    }
    // Clouds thin out as you descend; their shadows stay, a little softer, so the ground keeps
    // its dappled light.
    const fade = THREE.MathUtils.clamp((d - 1.3) / 1.0, 0, 1);
    const [deck, cirrus] = this.clouds.children as THREE.Mesh[];
    for (const m of [deck, cirrus]) (m.material as THREE.MeshStandardMaterial).opacity = m.userData.baseOpacity * fade;
    deck.rotation.y += dt * 0.006;
    cirrus.rotation.y += dt * 0.011;
    this.cloudU.uCloudRot.value = deck.rotation.y;
    this.cloudU.uCloudShadow.value = this.clouds.visible ? 0.22 + 0.13 * fade : 0;

    this.renderer.render(this.scene, this.camera);
  }

  private dispose() {
    for (const o of [this.terrain, this.water, this.gridLines, this.rivers]) {
      if (!o) continue;
      this.planet.remove(o);
      o.geometry.dispose();
      if (o !== this.water && o !== this.rivers) (o.material as THREE.Material).dispose();
    }
    for (const f of this.forest) { this.planet.remove(f); f.dispose(); }
    this.terrain = this.water = this.gridLines = this.rivers = undefined;
    this.forest = [];
  }

  private rebuild() {
    const w = this.world;
    if (!w) return;
    this.dispose();
    const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos;
    const o = this.opts;

    const cellColor = new Float32Array(N * 3);
    const tmp = new THREE.Color();
    for (let c = 0; c < N; c++) {
      colorFor(w, c, o.mode, tmp);
      cellColor[c * 3] = tmp.r; cellColor[c * 3 + 1] = tmp.g; cellColor[c * 3 + 2] = tmp.b;
    }
    const seed = w.params.seed;
    const input = {
      world: w, cellColor, relief: o.relief, blend: o.blend, flora: o.trees, natural: o.mode === 'biome',
      tint: makeSimplex(seed * 5 + 11), rough: makeSimplex(seed * 5 + 12),
    };
    const s = o.style === 'smooth' ? buildSmooth(input) : buildTiles(input);
    this.surface = s;

    const terrainMat = makeTerrainMaterial(this.cloudU);
    this.terrain = new THREE.Mesh(s.terrain, terrainMat);
    this.faceCell = s.faces;
    this.planet.add(this.terrain);

    if (s.water) {
      this.water = new THREE.Mesh(s.water, this.waterMat);
      this.water.renderOrder = 1;
      this.planet.add(this.water);
    }

    this.forest = buildForest(s.trees);
    for (const f of this.forest) this.planet.add(f);

    // Grid outlines, each edge once.
    const gl: number[] = [];
    for (let c = 0; c < N; c++) {
      const ks = g.corners[c], m = ks.length;
      for (let i = 0; i < m; i++) {
        const nb = g.neighbors[c][i];
        if (nb < c) continue;
        let h0 = s.outlineH(c, i), h1 = s.outlineH(c, (i + 1) % m);
        if (o.style === 'tiles') h0 = h1 = Math.max(h0, s.outlineH(nb, 0));
        const k0 = ks[i], k1 = ks[(i + 1) % m];
        gl.push(C[k0 * 3] * h0, C[k0 * 3 + 1] * h0, C[k0 * 3 + 2] * h0, C[k1 * 3] * h1, C[k1 * 3 + 1] * h1, C[k1 * 3 + 2] * h1);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    this.gridLines = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false }));
    this.gridLines.renderOrder = 2;
    this.planet.add(this.gridLines);

    this.buildRivers(w, s, P, C);
    this.applyVisibility();
    this.highlight(-1);
  }

  /**
   * Rivers as ribbons of the water surface: in through one edge, bending through the cell centre
   * with a little meander, out through the next. Width grows with flow, so a river visibly
   * gathers its tributaries, and mouths flare where they meet the sea.
   */
  private buildRivers(w: World, s: Surface, P: Float32Array, C: Float32Array) {
    const g = w.grid, T = w.riverThreshold;
    const spacing = Math.sqrt((4 * Math.PI) / g.count);
    const meander = makeSimplex(w.params.seed * 5 + 13);
    const mf = 1.6 / spacing;
    const widthOf = (f: number) => spacing * Math.min(0.26, 0.035 + 0.045 * Math.log2(1 + f / T));
    const edgePoint = (c: number, i: number): number[] => {
      const ks = g.corners[c];
      let k0 = ks[i], k1 = ks[(i + 1) % ks.length];
      if (k0 > k1) [k0, k1] = [k1, k0]; // same point from both sides
      const t = 0.3 + 0.4 * hash01(k0 * 7919 + k1);
      const x = C[k0 * 3] + (C[k1 * 3] - C[k0 * 3]) * t;
      const y = C[k0 * 3 + 1] + (C[k1 * 3 + 1] - C[k0 * 3 + 1]) * t;
      const z = C[k0 * 3 + 2] + (C[k1 * 3 + 2] - C[k0 * 3 + 2]) * t;
      const l = Math.hypot(x, y, z);
      return [x / l, y / l, z / l];
    };

    const pos: number[] = [], depth: number[] = [], index: number[] = [];
    const LIFT = 0.0012, RIVER_DEPTH = 0.0045;
    const strip = (pts: number[][], widths: number[], side?: number[]) => {
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let sx: number, sy: number, sz: number;
        if (side) [sx, sy, sz] = side;
        else {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
          const l = Math.hypot(p[0], p[1], p[2]);
          const ux = p[0] / l, uy = p[1] / l, uz = p[2] / l;
          sx = ty * uz - tz * uy; sy = tz * ux - tx * uz; sz = tx * uy - ty * ux;
          const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
        }
        const hw = widths[i] / 2;
        pos.push(p[0] + sx * hw, p[1] + sy * hw, p[2] + sz * hw, p[0] - sx * hw, p[1] - sy * hw, p[2] - sz * hw);
        depth.push(RIVER_DEPTH, RIVER_DEPTH);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        if (side) index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // waterfalls: both faces
      }
    };

    for (let c = 0; c < g.count; c++) {
      if (!w.river[c]) continue;
      const d = w.downstream[c];
      const iOut = g.neighbors[c].indexOf(d);
      if (iOut < 0) continue;
      const out = edgePoint(c, iOut);
      const [hOut, hOutFar] = s.edgeH(c, iOut);
      const ctr = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
      const hC = s.centerH(c);
      let wOut = widthOf(w.flow[c]);
      if (w.water[d] !== 0) wOut *= 1.35; // mouth

      const starts: { p: number[]; h: number; w: number }[] = [];
      g.neighbors[c].forEach((u, j) => {
        if (w.river[u] && w.downstream[u] === c) starts.push({ p: edgePoint(c, j), h: s.edgeH(c, j)[0], w: widthOf(w.flow[u]) });
      });
      if (!starts.length) starts.push({ p: ctr, h: hC, w: wOut * 0.4 });

      for (const st of starts) {
        // Meander sideways, perpendicular to the chord, tapering to zero at both ends so
        // neighbouring cells still join up.
        const chx = out[0] - st.p[0], chy = out[1] - st.p[1], chz = out[2] - st.p[2];
        let px = chy * ctr[2] - chz * ctr[1], py = chz * ctr[0] - chx * ctr[2], pz = chx * ctr[1] - chy * ctr[0];
        const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
        const pts: number[][] = [], widths: number[] = [];
        const STEPS = 10;
        for (let k = 0; k <= STEPS; k++) {
          const t = k / STEPS, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), cc = t * t;
          let x = a * st.p[0] + b * ctr[0] + cc * out[0];
          let y = a * st.p[1] + b * ctr[1] + cc * out[1];
          let z = a * st.p[2] + b * ctr[2] + cc * out[2];
          const off = Math.sin(Math.PI * t) * spacing * 0.22 * meander(x * mf, y * mf, z * mf);
          x += px * off; y += py * off; z += pz * off;
          const l = Math.hypot(x, y, z);
          const h = Math.max(a * st.h + b * hC + cc * hOut, SEA) + LIFT;
          pts.push([(x / l) * h, (y / l) * h, (z / l) * h]);
          widths.push(st.w + (wOut - st.w) * t);
        }
        strip(pts, widths);
      }
      if (hOutFar < hOut - 1e-5) { // a waterfall down a terrace wall
        const h0 = hOut + LIFT, h1 = Math.max(hOutFar, SEA) + LIFT;
        const fx = P[d * 3] - ctr[0], fy = P[d * 3 + 1] - ctr[1], fz = P[d * 3 + 2] - ctr[2];
        let sx = out[1] * fz - out[2] * fy, sy = out[2] * fx - out[0] * fz, sz = out[0] * fy - out[1] * fx;
        const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
        strip([[out[0] * h0, out[1] * h0, out[2] * h0], [out[0] * h1, out[1] * h1, out[2] * h1]], [wOut, wOut], [sx, sy, sz]);
      }
    }
    if (!index.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
    geo.setIndex(index);
    this.rivers = new THREE.Mesh(geo, this.waterMat);
    this.rivers.renderOrder = 3;
    this.planet.add(this.rivers);
  }
}

function colorFor(w: World, c: number, mode: ViewMode, out: THREE.Color) {
  switch (mode) {
    case 'biome':
      return out.setHex(BIOMES[w.biome[c]].color);
    case 'elevation': {
      const e = w.water[c] === WATER_LAKE ? w.surface[c] : w.elevation[c];
      if (w.water[c] === WATER_OCEAN) return out.setHSL(0.6, 0.6, 0.15 + 0.3 * (1 + e));
      return out.setHSL(0.33 - 0.33 * e, 0.45, 0.3 + 0.45 * e);
    }
    case 'temperature':
      return out.setHSL(0.66 - 0.66 * w.temperature[c], 0.75, 0.5);
    case 'moisture':
      return out.setHSL(0.1 + 0.5 * w.moisture[c], 0.6, 0.6 - 0.25 * w.moisture[c]);
    case 'plates':
      return out.setHSL(hash01(w.plate[c] + 1), 0.55, w.water[c] === WATER_OCEAN ? 0.35 : 0.6);
  }
}
