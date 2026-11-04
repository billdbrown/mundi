/**
 * The hex view: one planet hex opened up as a walkable local map (hex.html). Opened from the
 * planet by double-clicking a hex. Variants of how the hex is scaled can be switched live
 * (keys 1–4) to compare; see hexlocal.ts for what each option does.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULT_PARAMS, type WorldParams } from './world.ts';
import { parseSeed } from './seedname.ts';
import { LOCAL_DEFAULTS, VARIANTS, localHeights, TREE_BROAD, TREE_CONIFER, TREE_PALM, TREE_SHRUB, type LocalMap, type LocalOptions } from './hexlocal.ts';
import type { Spot } from './debug.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// --- What to build, from the link: the world's settings, the cell, and the variant. ---
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
let variant = h.get('v') ?? 'aware10';
const chosen = VARIANTS.find((v) => v.id === variant);
if (chosen) opts = { ...opts, ...chosen.o };
for (const k of ['mag', 'vScale', 'vSoft', 'res'] as const) if (h.get(k)) opts[k] = Number(h.get(k));
if (h.get('river') === 'scaled' || h.get('river') === 'flow') opts.riverMode = h.get('river') as LocalOptions['riverMode'];
if (h.get('crags')) opts.crags = h.get('crags') === '1';
const back = new URLSearchParams(h);
for (const k of ['cell', 'spot', 'v', 'mag', 'vScale', 'vSoft', 'res', 'river', 'crags']) back.delete(k);
$<HTMLAnchorElement>('back').href = '/#' + back.toString();

// --- Scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const SKY = new THREE.Color(0xa9c3d6);
scene.background = SKY;
scene.fog = new THREE.FogExp2(SKY, 0.0005);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 50000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
const walker = new PointerLockControls(camera, document.body);
scene.add(new THREE.HemisphereLight(0xd6e6f2, 0x5b5242, 1.3));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let map: LocalMap | null = null;
let world = new THREE.Group();
scene.add(world);
let outline: THREE.Line | null = null;

/** Ground height under (x, y) in map metres (y north). */
function groundAt(x: number, y: number): number {
  if (!map) return 0;
  const { res, size, heights } = map, step = size / (res - 1), half = size / 2;
  const fi = Math.max(0, Math.min(res - 1.001, (x + half) / step)), fj = Math.max(0, Math.min(res - 1.001, (y + half) / step));
  const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0;
  const a = heights[j0 * res + i0], b = heights[j0 * res + i0 + 1], c = heights[(j0 + 1) * res + i0], d = heights[(j0 + 1) * res + i0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
const waterAt = (x: number, y: number) => Math.max(map?.sea ? 0 : -Infinity, groundAt(x, y));

function dispose(o: THREE.Object3D) {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
}

const waterMat = () => new THREE.MeshStandardMaterial({ color: 0x24505e, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.9 });

function treeGeometries(): THREE.BufferGeometry[] {
  const paint = (geo: THREE.BufferGeometry, hex: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const at = (geo: THREE.BufferGeometry, y: number, sy = 1) => { geo.scale(1, sy, 1); geo.translate(0, y, 0); return geo; };
  const trunk = (r: number, hgt: number) => paint(at(new THREE.CylinderGeometry(r * 0.7, r, hgt, 6), hgt / 2), 0x4a3a2a);
  return [
    mergeGeometries([trunk(0.016, 0.3), paint(at(new THREE.ConeGeometry(0.2, 0.8, 8), 0.6), 0x2c4a2e)])!,
    mergeGeometries([trunk(0.018, 0.45), paint(at(new THREE.IcosahedronGeometry(0.3, 1), 0.66, 0.85), 0x46682f)])!,
    mergeGeometries([trunk(0.016, 0.9), paint(at(new THREE.IcosahedronGeometry(0.22, 1), 0.92, 0.35), 0x56783a)])!,
    paint(at(new THREE.IcosahedronGeometry(0.5, 1), 0.42, 0.8), 0x5d6639),
  ];
}

function build(m: LocalMap) {
  scene.remove(world); dispose(world);
  world = new THREE.Group();
  const { res, size } = m, half = size / 2, step = size / (res - 1);

  // Terrain.
  const pos = new Float32Array(res * res * 3);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const v = j * res + i;
    pos[v * 3] = -half + i * step; pos[v * 3 + 1] = m.heights[v]; pos[v * 3 + 2] = -(-half + j * step);
  }
  const idx = new Uint32Array((res - 1) * (res - 1) * 6);
  let n = 0;
  for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
    const a = j * res + i, b = a + 1, c = a + res, d = c + 1;
    idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c;
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  tg.setIndex(new THREE.BufferAttribute(idx, 1));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97 }));
  terrain.receiveShadow = true; terrain.castShadow = true;
  world.add(terrain);

  // Earthen sides, so the map reads as a tile cut from the planet (and nothing shows under it).
  let lo = 0;
  for (const h of m.heights) lo = Math.min(lo, h);
  const floor = lo - Math.max(15, size * 0.02), sp: number[] = [];
  const edge = (i: number, j: number) => [-half + i * step, m.heights[j * res + i], half - j * step];
  const sideRun = (pts: number[][]) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay, az] = pts[k], [bx, by, bz] = pts[k + 1];
      sp.push(ax, ay, az, ax, floor, az, bx, by, bz, bx, by, bz, ax, floor, az, bx, floor, bz);
    }
  };
  const S: number[][] = [], E: number[][] = [], Nn: number[][] = [], Wt: number[][] = [];
  for (let i = 0; i < res; i++) { S.push(edge(i, 0)); Nn.push(edge(res - 1 - i, res - 1)); }
  for (let j = 0; j < res; j++) { E.push(edge(res - 1, j)); Wt.push(edge(0, res - 1 - j)); }
  sideRun(S); sideRun(E); sideRun(Nn); sideRun(Wt);
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sg.computeVertexNormals();
  world.add(new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x4a3c2e, roughness: 1, side: THREE.DoubleSide })));

  // Sea and lake: water only over ground that is below it, so no sheet sticks out past the map.
  const waterOver = (level: number, mask: Float32Array | null) => {
    const lp: number[] = [];
    for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
      const v = j * res + i;
      if (mask && Math.max(mask[v], mask[v + 1], mask[v + res], mask[v + res + 1]) < 0.5) continue;
      if (Math.min(m.heights[v], m.heights[v + 1], m.heights[v + res], m.heights[v + res + 1]) > level) continue;
      const x0 = -half + i * step, x1 = x0 + step, z0 = half - j * step, z1 = z0 - step, y = level;
      lp.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z0, x1, y, z1, x0, y, z1);
    }
    if (!lp.length) return;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
    lg.computeVertexNormals();
    const mesh = new THREE.Mesh(lg, waterMat()); mesh.receiveShadow = true;
    world.add(mesh);
  };
  if (m.sea) waterOver(0, null);
  if (!Number.isNaN(m.lakeLevel)) waterOver(m.lakeLevel, m.lakeMask);
  const inside = (x: number, y: number) => Math.abs(x) <= half && Math.abs(y) <= half;
  for (const r of m.rivers) {
    const p = r.pts, k = p.length / 4, rp = new Float32Array(k * 6), ri: number[] = [];
    for (let s = 0; s < k; s++) {
      const a = Math.max(0, s - 1), b = Math.min(k - 1, s + 1);
      let tx = p[b * 4] - p[a * 4], ty = p[b * 4 + 1] - p[a * 4 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const hw = p[s * 4 + 3] * 0.55, x = p[s * 4], y = p[s * 4 + 1], lv = p[s * 4 + 2] + 0.05;
      rp.set([x - ty * hw, lv, -(y + tx * hw), x + ty * hw, lv, -(y - tx * hw)], s * 6);
      // Only the stretch on the map: pieces from cells further out ran past its edge.
      if (s < k - 1 && inside(x, y) && inside(p[s * 4 + 4], p[s * 4 + 5])) ri.push(s * 2, s * 2 + 1, s * 2 + 2, s * 2 + 1, s * 2 + 3, s * 2 + 2);
    }
    if (!ri.length) continue;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setIndex(ri);
    rg.computeVertexNormals();
    const mat = waterMat(); mat.color.setHex(0x2f5853); mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(rg, mat); mesh.receiveShadow = true;
    world.add(mesh);
  }

  // Trees, one instanced mesh per kind.
  const geos = treeGeometries(), T = m.trees, count = T.length / 5;
  const kinds = [TREE_CONIFER, TREE_BROAD, TREE_PALM, TREE_SHRUB];
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  for (const kind of kinds) {
    let c = 0;
    for (let i = 0; i < count; i++) if (T[i * 5 + 4] === kind) c++;
    if (!c) continue;
    const mesh = new THREE.InstancedMesh(geos[kind], new THREE.MeshLambertMaterial({ vertexColors: true }), c);
    let k = 0;
    for (let i = 0; i < count; i++) {
      if (T[i * 5 + 4] !== kind) continue;
      const hgt = T[i * 5 + 3], jit = ((i * 2654435761) >>> 0) / 4294967296;
      q.setFromAxisAngle(up, jit * Math.PI * 2);
      sc.set(hgt * (0.85 + 0.3 * jit), hgt, hgt * (0.85 + 0.3 * jit));
      ps.set(T[i * 5], T[i * 5 + 2] - 0.2, -T[i * 5 + 1]);
      mesh.setMatrixAt(k, mtx.compose(ps, q, sc));
      mesh.setColorAt(k, col.setScalar(0.8 + 0.4 * jit));
      k++;
    }
    mesh.castShadow = true; mesh.receiveShadow = true;
    world.add(mesh);
  }
  for (const g of geos) g.dispose();

  // A person (1.8 m) and a cottage at the centre, for scale.
  const gy = groundAtMap(m, 6, 0);
  const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.3, 4, 8), new THREE.MeshStandardMaterial({ color: 0xc0392b }));
  person.position.set(6, gy + 0.9, 0); person.castShadow = true;
  person.name = 'person';
  const cy = groundAtMap(m, 0, 0);
  const cottage = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 6), new THREE.MeshStandardMaterial({ color: 0xd8cdb4 }));
  walls.position.y = 2;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 9.6, 3, 1), new THREE.MeshStandardMaterial({ color: 0x7a3b2a }));
  roof.rotation.z = Math.PI / 2; roof.position.y = 4 + 1.05; roof.scale.set(1, 1, 0.82);
  cottage.add(walls, roof);
  cottage.position.set(0, cy - 0.5, 0);
  cottage.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  world.add(person, cottage);

  // The hex outline, draped over the ground.
  const ol: number[] = [], H = m.hex, nc = H.length / 2;
  for (let k = 0; k <= nc; k++) {
    const a = k % nc, b = (k + 1) % nc;
    for (let t = 0; t < 160 && k < nc; t++) {
      const x = H[a * 2] + (H[b * 2] - H[a * 2]) * t / 160, y = H[a * 2 + 1] + (H[b * 2 + 1] - H[a * 2 + 1]) * t / 160;
      ol.push(x, Math.max(groundAtMap(m, x, y), m.sea ? 0 : -1e9) + size * 0.002, -y);
    }
  }
  ol.push(ol[0], ol[1], ol[2]);
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.Float32BufferAttribute(ol, 3));
  const showOutline = outline ? outline.visible : true;
  outline = new THREE.Line(og, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
  outline.visible = showOutline;
  world.add(outline);

  scene.add(world);
  (scene.fog as THREE.FogExp2).density = 0.55 / size;
  camera.far = size * 6; camera.updateProjectionMatrix();
  sun.position.set(size * 0.45, size * 0.7, size * 0.35);
  const sc2 = sun.shadow.camera;
  sc2.left = -size * 0.75; sc2.right = size * 0.75; sc2.top = size * 0.75; sc2.bottom = -size * 0.75;
  sc2.near = 1; sc2.far = size * 3; sc2.updateProjectionMatrix();
  sun.shadow.normalBias = step * 0.5;
}
function groundAtMap(m: LocalMap, x: number, y: number) { const old = map; map = m; const g = groundAt(x, y); map = old; return g; }

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
const variantsEl = $('variants');
VARIANTS.forEach((v, i) => {
  const b = document.createElement('button');
  b.dataset.id = v.id;
  b.innerHTML = `<kbd>${i + 1}</kbd>${v.label}<small>${v.blurb}</small>`;
  b.onclick = () => pickVariant(v.id);
  variantsEl.appendChild(b);
});
function pickVariant(id: string) {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) return;
  variant = id; opts = { ...opts, ...v.o };
  syncPanel(); request();
}
function syncPanel() {
  for (const b of variantsEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === variant);
  $<HTMLInputElement>('mag').value = String(opts.mag); $('mag-out').textContent = `${opts.mag}×`;
  $<HTMLInputElement>('vscale').value = String(opts.vScale); $('vscale-out').textContent = String(opts.vScale);
  $<HTMLSelectElement>('river').value = opts.riverMode;
  $<HTMLSelectElement>('vsoft').value = String(opts.vSoft);
  $<HTMLInputElement>('crags').checked = opts.crags;
  $<HTMLSelectElement>('res').value = String(opts.res);
}
const custom = () => { variant = 'custom'; syncPanel(); request(); };
$<HTMLInputElement>('mag').oninput = (e) => { opts.mag = Number((e.target as HTMLInputElement).value); $('mag-out').textContent = `${opts.mag}×`; };
$<HTMLInputElement>('mag').onchange = custom;
$<HTMLInputElement>('vscale').oninput = (e) => { opts.vScale = Number((e.target as HTMLInputElement).value); $('vscale-out').textContent = String(opts.vScale); };
$<HTMLInputElement>('vscale').onchange = custom;
$<HTMLSelectElement>('vsoft').onchange = (e) => { opts.vSoft = Number((e.target as HTMLSelectElement).value); custom(); };
$<HTMLSelectElement>('river').onchange = (e) => { opts.riverMode = (e.target as HTMLSelectElement).value as LocalOptions['riverMode']; custom(); };
$<HTMLInputElement>('crags').onchange = (e) => { opts.crags = (e.target as HTMLInputElement).checked; custom(); };
$<HTMLSelectElement>('res').onchange = (e) => { opts.res = Number((e.target as HTMLSelectElement).value); request(); };

function writeHash() {
  const out = new URLSearchParams(back);
  out.set('cell', String(cell));
  if (variant !== 'custom') out.set('v', variant);
  else { out.set('mag', String(opts.mag)); out.set('vScale', String(opts.vScale)); out.set('vSoft', String(opts.vSoft)); out.set('river', opts.riverMode); out.set('crags', opts.crags ? '1' : '0'); }
  if (opts.res !== LOCAL_DEFAULTS.res) out.set('res', String(opts.res));
  history.replaceState(null, '', location.pathname + '#' + out.toString());
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

// --- Building, off the main thread. One request in flight; later changes collapse into one. ---
const worker = new Worker(new URL('./hexworker.ts', import.meta.url), { type: 'module' });
let busy = false, again = false, firstBuild = true;
function request() {
  writeHash();
  if (busy) { again = true; return; }
  busy = true; $('busy').hidden = false;
  worker.postMessage({ params, cell, spot: cell < 0 ? (spot ?? 'river') : undefined, opts });
}
worker.onmessage = (e: MessageEvent<{ map: LocalMap; ms: { world: number; local: number } }>) => {
  busy = false;
  const m = e.data.map;
  // Keep the camera's place relative to the map size, so variants compare from the same angle.
  const rel = map && !firstBuild ? { p: camera.position.clone().divideScalar(map.size), t: controls.target.clone().divideScalar(map.size) } : null;
  cell = m.cell;
  build(m);
  map = m;
  drawInset(m); facts(m);
  if (rel) { camera.position.copy(rel.p.multiplyScalar(m.size)); controls.target.copy(rel.t.multiplyScalar(m.size)); }
  else resetView();
  firstBuild = false;
  $('timing').textContent = `world ${Math.round(e.data.ms.world)} ms · hex ${Math.round(e.data.ms.local)} ms · ${(m.trees.length / 5).toLocaleString()} trees`;
  writeHash();
  if (again) { again = false; request(); } else $('busy').hidden = true;
};

function resetView() {
  if (!map) return;
  const g = groundAt(0, 0);
  controls.target.set(0, g, 0);
  camera.position.set(map.size * 0.05, g + map.size * 0.42, map.size * 0.62);
  controls.update();
}
$('reset').onclick = resetView;

// --- Walking ---
const keys = new Set<string>();
let saved: { p: THREE.Vector3; t: THREE.Vector3 } | null = null;
$('walk').onclick = () => {
  if (!map) return;
  saved = { p: camera.position.clone(), t: controls.target.clone() };
  camera.position.set(8, waterAt(8, 3) + 1.7, -3);
  camera.lookAt(0, groundAt(0, 0) + 2, 0);
  controls.enabled = false;
  walker.lock();
};
walker.addEventListener('unlock', () => {
  controls.enabled = true;
  if (saved) { camera.position.copy(saved.p); controls.target.copy(saved.t); controls.update(); saved = null; }
});
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (walker.isLocked) return;
  const n = Number(e.key);
  if (n >= 1 && n <= VARIANTS.length) pickVariant(VARIANTS[n - 1].id);
  if (e.code === 'KeyH' && outline) outline.visible = !outline.visible;
});
addEventListener('keyup', (e) => keys.delete(e.code));

const timer = new THREE.Timer();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(0.1, timer.getDelta());
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
  renderer.render(scene, camera);
});

syncPanel();
request();
(window as unknown as Record<string, unknown>).hex = {
  get map() { return map; },
  get busy() { return busy; },
  pickVariant, resetView, scene,
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
