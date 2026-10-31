import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { BIOMES, B } from './biomes.ts';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { hash01 } from './rng.ts';

export type ViewMode = 'biome' | 'elevation' | 'temperature' | 'moisture' | 'plates';

export interface ViewOptions {
  mode: ViewMode;
  grid: boolean;
  rivers: boolean;
  blend: boolean;
  relief: number;
}

const SEA = 1.0;
const LAND_BASE = 1.0025;

export class PlanetView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private planet = new THREE.Group();
  private terrain?: THREE.Mesh;
  private gridLines?: THREE.LineSegments;
  private riverLines: LineSegments2[] = [];
  private riverMats: LineMaterial[] = [];
  private hover: THREE.LineLoop;
  private ocean: THREE.Mesh;
  private faceCell = new Int32Array(0);
  private top = new Float32Array(0);
  private world?: World;
  private opts: ViewOptions = { mode: 'biome', grid: true, rivers: true, blend: true, relief: 1 };
  private raycaster = new THREE.Raycaster();

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.005, 200);
    this.camera.position.set(0, 0.9, 3.4);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x05070d);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.16;
    this.controls.maxDistance = 7;
    this.controls.zoomSpeed = 0.8;

    // Light rides with the camera so the side you look at is always lit.
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.position.set(-2.5, 2.2, 3);
    this.camera.add(sun);
    // Ambient, not hemisphere: a hemisphere light's 'up' is world +Y, which means nothing on a sphere.
    this.scene.add(new THREE.AmbientLight(0xc8d8f0, 0.9));

    this.ocean = new THREE.Mesh(
      new THREE.SphereGeometry(SEA, 192, 96),
      new THREE.MeshStandardMaterial({
        color: 0x1d6aa0, transparent: true, opacity: 0.72, roughness: 0.16, metalness: 0.05,
      }),
    );
    this.ocean.renderOrder = 1;
    this.planet.add(this.ocean);

    this.hover = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.hover.renderOrder = 10;
    this.hover.visible = false;
    this.planet.add(this.hover);

    this.scene.add(this.planet);
    this.scene.add(makeAtmosphere());
    this.scene.add(makeStars());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setWorld(world: World) {
    this.world = world;
    this.rebuild();
  }

  setOptions(o: Partial<ViewOptions>) {
    const needsRebuild = o.mode !== undefined && o.mode !== this.opts.mode
      || o.blend !== undefined && o.blend !== this.opts.blend
      || o.relief !== undefined && o.relief !== this.opts.relief;
    this.opts = { ...this.opts, ...o };
    if (needsRebuild) this.rebuild();
    if (this.gridLines) this.gridLines.visible = this.opts.grid;
    for (const r of this.riverLines) r.visible = this.opts.rivers && this.opts.mode === 'biome';
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
    if (cell < 0 || !this.world) { this.hover.visible = false; return; }
    const g = this.world.grid;
    const pts: number[] = [];
    const h = Math.max(this.top[cell], SEA) + 0.002;
    for (const k of g.corners[cell]) pts.push(g.cornerPos[k * 3] * h, g.cornerPos[k * 3 + 1] * h, g.cornerPos[k * 3 + 2] * h);
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
    for (const m of this.riverMats) m.resolution.set(w, h);
  }

  private frame() {
    const d = this.camera.position.length();
    // Slow the orbit as you close in, so ground-level views stay controllable.
    this.controls.rotateSpeed = Math.min(1, (d - 1) * 0.55);
    this.controls.update();
    if (this.gridLines) {
      const m = this.gridLines.material as THREE.LineBasicMaterial;
      m.opacity = THREE.MathUtils.clamp(0.06 + (d - 1.15) * 0.16, 0.06, 0.4);
    }
    const px = THREE.MathUtils.clamp(5 / d, 1.5, 6);
    if (this.riverMats[0]) this.riverMats[0].linewidth = px * 0.55;
    if (this.riverMats[1]) this.riverMats[1].linewidth = px;
    this.renderer.render(this.scene, this.camera);
  }

  private dispose() {
    for (const o of [this.terrain, this.gridLines, ...this.riverLines]) {
      if (!o) continue;
      this.planet.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.riverLines = [];
    this.riverMats = [];
  }

  private rebuild() {
    const w = this.world;
    if (!w) return;
    this.dispose();
    const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos;
    const relief = 0.04 * this.opts.relief;

    // Height of each cell's flat top.
    const top = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (w.water[c] === WATER_OCEAN) top[c] = w.biome[c] === B.SEA_ICE ? SEA + 0.0018 : SEA + w.elevation[c] * 0.035;
      else if (w.water[c] === WATER_LAKE) top[c] = LAND_BASE + w.surface[c] * relief;
      else top[c] = LAND_BASE + w.elevation[c] * relief;
    }
    this.top = top;

    const cellColor = new Float32Array(N * 3);
    const tmp = new THREE.Color();
    for (let c = 0; c < N; c++) {
      colorFor(w, c, this.opts.mode, tmp);
      const j = 0.95 + 0.1 * hash01(c);
      cellColor[c * 3] = tmp.r * j; cellColor[c * 3 + 1] = tmp.g * j; cellColor[c * 3 + 2] = tmp.b * j;
    }

    // Corner colours average the cells meeting there (same side of the waterline only),
    // which softens tile borders without muddying coasts.
    const cornerCells: number[][] = Array.from({ length: C.length / 3 }, () => []);
    for (let c = 0; c < N; c++) for (const k of g.corners[c]) cornerCells[k].push(c);
    const wet = (c: number) => w.water[c] !== WATER_LAND || w.biome[c] === B.SEA_ICE ? 1 : 0;

    const pos: number[] = [], col: number[] = [], faces: number[] = [];
    const push = (x: number, y: number, z: number, h: number, r: number, gg: number, b: number) => {
      pos.push(x * h, y * h, z * h); col.push(r, gg, b);
    };

    for (let c = 0; c < N; c++) {
      const ks = g.corners[c], m = ks.length, h = top[c];
      const r = cellColor[c * 3], gg = cellColor[c * 3 + 1], b = cellColor[c * 3 + 2];
      const cc: number[] = [];
      for (const k of ks) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        if (this.opts.blend) {
          for (const o of cornerCells[k]) {
            if (wet(o) !== wet(c)) continue;
            sr += cellColor[o * 3]; sg += cellColor[o * 3 + 1]; sb += cellColor[o * 3 + 2]; n++;
          }
        }
        if (n) cc.push((r + sr / n) / 2, (gg + sg / n) / 2, (b + sb / n) / 2);
        else cc.push(r, gg, b);
      }
      for (let i = 0; i < m; i++) {
        const k0 = ks[i], k1 = ks[(i + 1) % m], i1 = (i + 1) % m;
        push(P[c * 3], P[c * 3 + 1], P[c * 3 + 2], h, r, gg, b);
        push(C[k0 * 3], C[k0 * 3 + 1], C[k0 * 3 + 2], h, cc[i * 3], cc[i * 3 + 1], cc[i * 3 + 2]);
        push(C[k1 * 3], C[k1 * 3 + 1], C[k1 * 3 + 2], h, cc[i1 * 3], cc[i1 * 3 + 1], cc[i1 * 3 + 2]);
        faces.push(c);
      }
      // Cliff walls down to each lower neighbour.
      for (let i = 0; i < m; i++) {
        const nb = g.neighbors[c][i];
        const hn = top[nb];
        if (hn >= h) continue;
        const k0 = ks[i], k1 = ks[(i + 1) % m];
        const dr = r * 0.72, dg = gg * 0.72, db = b * 0.72;
        const ax = C[k0 * 3], ay = C[k0 * 3 + 1], az = C[k0 * 3 + 2];
        const bx = C[k1 * 3], by = C[k1 * 3 + 1], bz = C[k1 * 3 + 2];
        // Seen from outside, k0 → k1 runs counter-clockwise around c, so (k1·h, k0·h, k0·hn)
        // faces away from c, towards the lower neighbour.
        push(bx, by, bz, h, dr, dg, db); push(ax, ay, az, h, dr, dg, db); push(ax, ay, az, hn, dr, dg, db);
        push(bx, by, bz, h, dr, dg, db); push(ax, ay, az, hn, dr, dg, db); push(bx, by, bz, hn, dr, dg, db);
        faces.push(c, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    this.faceCell = Int32Array.from(faces);
    this.planet.add(this.terrain);
    this.ocean.visible = this.opts.mode === 'biome';

    // Grid outlines, each edge once, sitting on the higher side (or the water surface).
    const gl: number[] = [];
    for (let c = 0; c < N; c++) {
      const ks = g.corners[c], m = ks.length;
      for (let i = 0; i < m; i++) {
        const nb = g.neighbors[c][i];
        if (nb < c) continue;
        const h = Math.max(top[c], top[nb], SEA) + 0.0006;
        const k0 = ks[i], k1 = ks[(i + 1) % m];
        gl.push(C[k0 * 3] * h, C[k0 * 3 + 1] * h, C[k0 * 3 + 2] * h, C[k1 * 3] * h, C[k1 * 3 + 1] * h, C[k1 * 3 + 2] * h);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    this.gridLines = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
    this.gridLines.renderOrder = 2;
    this.gridLines.visible = this.opts.grid;
    this.planet.add(this.gridLines);

    // Rivers: centre → a jittered point on the shared edge → downstream centre.
    const tiers: number[][] = [[], []];
    for (let c = 0; c < N; c++) {
      if (!w.river[c]) continue;
      const d = w.downstream[c];
      if (d < 0) continue;
      const i = g.neighbors[c].indexOf(d);
      if (i < 0) continue;
      const ks = g.corners[c], k0 = ks[i], k1 = ks[(i + 1) % ks.length];
      const t = 0.3 + 0.4 * hash01(c * 31 + d);
      const mx = C[k0 * 3] + (C[k1 * 3] - C[k0 * 3]) * t;
      const my = C[k0 * 3 + 1] + (C[k1 * 3 + 1] - C[k0 * 3 + 1]) * t;
      const mz = C[k0 * 3 + 2] + (C[k1 * 3 + 2] - C[k0 * 3 + 2]) * t;
      const ml = Math.hypot(mx, my, mz);
      const hc = top[c] + 0.0012;
      const hd = Math.max(top[d], SEA) + 0.0012;
      const seg = tiers[w.river[c] - 1];
      const ex = mx / ml, ey = my / ml, ez = mz / ml;
      seg.push(P[c * 3] * hc, P[c * 3 + 1] * hc, P[c * 3 + 2] * hc, ex * hc, ey * hc, ez * hc);
      if (hd < hc) seg.push(ex * hc, ey * hc, ez * hc, ex * hd, ey * hd, ez * hd);
      if (w.water[d] === WATER_LAND) seg.push(ex * hd, ey * hd, ez * hd, P[d * 3] * hd, P[d * 3 + 1] * hd, P[d * 3 + 2] * hd);
    }
    for (const seg of tiers) {
      const lg = new LineSegmentsGeometry();
      lg.setPositions(seg.length ? seg : [0, 0, 0, 0, 0, 0]);
      const lm = new LineMaterial({ color: 0x4a9be0, linewidth: 2, worldUnits: false });
      lm.resolution.set(this.container.clientWidth, this.container.clientHeight);
      const line = new LineSegments2(lg, lm);
      line.renderOrder = 3;
      line.visible = this.opts.rivers && this.opts.mode === 'biome';
      this.riverLines.push(line);
      this.riverMats.push(lm);
      this.planet.add(line);
    }
    this.highlight(-1);
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

function makeAtmosphere(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), 4.0);
        gl_FragColor = vec4(vec3(0.42, 0.68, 1.0) * f * 1.4, 1.0);
      }`,
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 48), mat);
}

function makeStars(): THREE.Points {
  const n = 2500, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = hash01(i) * 2 - 1, a = hash01(i + n) * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a) * 80; pos[i * 3 + 1] = r * Math.sin(a) * 80; pos[i * 3 + 2] = z * 80;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.7 }));
}

