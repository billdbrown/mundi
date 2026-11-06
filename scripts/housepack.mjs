/**
 * Builds the hex view's building models from Quaternius's CC0 packs into one file the view loads:
 * public/assets/hex/houses.bin plus houses.json (where each model is in it). For comparing house
 * families in the hex view (2026-11-06, Bill: "building the towns using those cc0 assets"):
 *
 * - village: Medieval Village (timber-framed houses, an inn, a bell tower, a well, workshops);
 * - timber: Ultimate Fantasy RTS, First Age (log and plank, palisades);
 * - stone: Ultimate Fantasy RTS, Second Age (whitewash and stone, tiled roofs).
 *
 * Each family has houses, extras (workshops, mills, stores), and three town landmarks for the
 * square (village, town, city). Each model: footprint centred, base at y = 0, scaled so its wider
 * side is one unit; simplified to a few thousand triangles. Per vertex: position (float32 x3) and
 * colour (uint8 x4): rgb in linear, and in a its role: 0 keeps its colour, 85 is roof and 170 wall
 * (both tinted per house by the view), 255 window (lit at night).
 *
 * Usage: node scripts/housepack.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as THREE from 'three';
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class extends Event { constructor(t, o) { super(t); Object.assign(this, o); } };
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptSimplifier } = await import('meshoptimizer');
await MeshoptSimplifier.ready;

const Q = 'C:/Users/Bill/assets/cc0/quaternius/';
const OUT = 'public/assets/hex/';
const VB = Q + 'medievalvillage/Buildings/FBX/', VP = Q + 'medievalvillage/Props/FBX/', RTS = Q + 'ultimatefantasyrts/glTF/';
const lv = (base) => [1, 2, 3].map((l) => `${base}_Level${l}`);
/** Small things for the towns, in hextown.ts PROPS order. */
export const PROPS = ['Well', 'MarketStand_1', 'MarketStand_2', 'Bench_1', 'Cart', 'Barrel', 'Crate', 'Bags', 'Hay', 'Logs', 'Fence']
  .map((n) => (n === 'Logs' ? RTS + 'Logs.gltf' : VP + n + '.fbx'));
export const FAMILIES = {
  village: {
    source: 'Quaternius Medieval Village (CC0)',
    // (House_3 and House_4 are flat-topped stone blocks: they read as boxes from above.)
    house: ['House_1', 'House_2'].map((n) => VB + n + '.fbx'),
    extra: ['Blacksmith', 'Sawmill', 'Stable', 'Mill'].map((n) => VB + n + '.fbx'),
    hall: [VP + 'Well.fbx', VB + 'Inn.fbx', VB + 'Bell_Tower.fbx'],
  },
  timber: {
    source: 'Quaternius Ultimate Fantasy RTS, First Age (CC0)',
    house: [1, 2, 3].flatMap((i) => lv(`Houses_FirstAge_${i}`)).map((n) => RTS + n + '.gltf'),
    extra: ['Windmill_FirstAge', 'Storage_FirstAge_Level1', 'Barracks_FirstAge_Level1'].map((n) => RTS + n + '.gltf'),
    hall: ['Market_FirstAge_Level1', 'TownCenter_FirstAge_Level2', 'TownCenter_FirstAge_Level3'].map((n) => RTS + n + '.gltf'),
  },
  stone: {
    source: 'Quaternius Ultimate Fantasy RTS, Second Age (CC0)',
    house: [1, 2, 3].flatMap((i) => lv(`Houses_SecondAge_${i}`)).map((n) => RTS + n + '.gltf'),
    extra: ['Windmill_SecondAge', 'Storage_SecondAge_Level1', 'Temple_SecondAge_Level1'].map((n) => RTS + n + '.gltf'),
    hall: ['Market_SecondAge_Level2', 'TownCenter_SecondAge_Level2', 'Temple_SecondAge_Level3'].map((n) => RTS + n + '.gltf'),
  },
};

const ROOF = 85, WALL = 170, WINDOW = 255;
/** Colour (sRGB hex) and role for a material, by its name. Roofs and walls are white here: the view
 * tints them per house. */
function role(name, file) {
  const n = name.replace(/\.\d+$/, '');
  if (/^RoofTiles|^Main$|^Roof/.test(n)) return [0xffffff, ROOF];
  if (/^(Plaster|Beige|Walls|White)$/.test(n)) return [0xffffff, WALL];
  if (/^Window/.test(n)) return [0x2a2420, WINDOW];
  const fixed = {
    Wood: 0x6b4a2f, Wood_Light: 0x8c6a45, Wood_Side: 0x7d5c3b, Wood_Dark: 0x4f3622,
    Stone: 0x7c7a72, Stone_Dark: 0x5f5e59, Stone_Light: 0x9b988f, Bell: 0xb38a3a, Metal: 0x6a6d70,
    Green: 0x5d7a2e, Yellow: 0xc9b23a, Red: 0xa8322a, Water: 0x4f8790, Fabric: 0xd8c49a, Black: 0x2a2826,
    Rope: 0xa58a5c, Hay: 0xc9ad5a, Bag: 0xc2a878, DarkWood: 0x4a3322, Metal_Light: 0x9a9da0, Dirt: 0x6b5a44, Leaves: 0x587a32, Gold: 0xc9a13a, Blue: 0x3d6a9c,
  };
  if (fixed[n] != null) return [fixed[n], 0];
  console.warn('unknown material', n, 'in', file.split('/').pop());
  return [0x9a9a9a, 0];
}

const fbx = new FBXLoader(), gltf = new GLTFLoader();
async function loadRoot(file) {
  const b = readFileSync(file);
  if (file.endsWith('.fbx')) return fbx.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
  return await new Promise((res, rej) => gltf.parse(b.toString(), '', (g) => res(g.scene), rej));
}
/** One model as groups of triangles by colour and role. */
async function load(file) {
  const root = await loadRoot(file);
  root.updateMatrixWorld(true);
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const p = g.attributes.position, mats = [o.material].flat();
    const ranges = g.groups.length ? g.groups : [{ start: 0, count: p.count, materialIndex: 0 }];
    const v = new THREE.Vector3();
    for (const r of ranges) {
      const m = mats[r.materialIndex] ?? mats[0];
      const [hex, rl] = role(m.name, file);
      const key = hex + ':' + rl;
      if (!groups.has(key)) { const c = new THREE.Color(hex); groups.set(key, { pos: [], col: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), rl] }); }
      const G = groups.get(key);
      for (let i = r.start; i < Math.min(p.count, r.start + r.count); i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); G.pos.push(v.x, v.y, v.z); }
    }
  });
  return [...groups.values()];
}
function weld(soup) {
  const map = new Map(), pos = [], idx = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i].toFixed(4) + ',' + soup[i + 1].toFixed(4) + ',' + soup[i + 2].toFixed(4);
    let j = map.get(k);
    if (j === undefined) { j = pos.length / 3; map.set(k, j); pos.push(soup[i], soup[i + 1], soup[i + 2]); }
    idx.push(j);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}
function simplify(w, ratio) {
  if (ratio >= 1 || w.idx.length < 90) return w;
  const target = Math.max(12, Math.floor((w.idx.length * ratio) / 3) * 3);
  const [idx] = MeshoptSimplifier.simplify(w.idx, w.pos, 3, target, 0.01, []);
  return { pos: w.pos, idx };
}

const MAX_TRIS = { house: 1800, extra: 2600, hall: 4500, prop: 400 };
const models = {}, chunks = [];
let offset = 0;
const push = (buf) => { const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; } chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); const at = offset; offset += buf.byteLength; return at; };
const index = {};
const props = [];
const jobs = [...Object.entries(FAMILIES).flatMap(([fam, F]) => ['house', 'extra', 'hall'].flatMap((kind) => F[kind].map((file) => ({ fam, kind, file })))),
  ...PROPS.map((file) => ({ fam: 'prop', kind: 'prop', file }))];
for (const [fam, F] of Object.entries(FAMILIES)) index[fam] = { source: F.source, house: [], extra: [], hall: [] };
{
  for (const { fam, kind, file } of jobs) {
    {
      const name = `${fam}/${file.split('/').pop().replace(/\.(fbx|gltf)$/, '')}`;
      const groups = (await load(file)).map((g) => ({ ...weld(g.pos), col: g.col }));
      // Footprint centred, base at 0, the wider side one unit.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g.pos[i + a]); hi[a] = Math.max(hi[a], g.pos[i + a]); }
      const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, S = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
      for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) { g.pos[i] = (g.pos[i] - cx) / S; g.pos[i + 1] = (g.pos[i + 1] - lo[1]) / S; g.pos[i + 2] = (g.pos[i + 2] - cz) / S; }
      const tris = groups.reduce((a, g) => a + g.idx.length / 3, 0);
      const ratio = Math.min(1, MAX_TRIS[kind] / tris);
      const gs = groups.map((g) => simplify(g, ratio));
      const used = gs.map((g) => { const keep = new Map(); for (const i of g.idx) if (!keep.has(i)) keep.set(i, keep.size); return keep; });
      const nv = used.reduce((a, k) => a + k.size, 0), ni = gs.reduce((a, g) => a + g.idx.length, 0);
      const pos = new Float32Array(nv * 3), col = new Uint8Array(nv * 4), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
      let vb = 0, ib = 0;
      gs.forEach((g, gi) => {
        for (const [old, nu] of used[gi]) { pos.set(g.pos.subarray(old * 3, old * 3 + 3), (vb + nu) * 3); col.set(groups[gi].col, (vb + nu) * 4); }
        for (const i of g.idx) idx[ib++] = vb + used[gi].get(i);
        vb += used[gi].size;
      });
      models[name] = { verts: nv, tris: ni / 3, pos: push(pos), col: push(col), idx: push(idx), wide: idx instanceof Uint32Array,
        size: [(hi[0] - lo[0]) / S, (hi[1] - lo[1]) / S, (hi[2] - lo[2]) / S] };
      if (kind === 'prop') props.push(name); else index[fam][kind].push(name);
      console.log(name.padEnd(42), 'tris', String(tris).padStart(6), '->', String(ni / 3).padStart(5));
    }
  }
}
mkdirSync(OUT, { recursive: true });
const bin = new Uint8Array(offset);
let o = 0; for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
writeFileSync(OUT + 'houses.bin', bin);
writeFileSync(OUT + 'houses.json', JSON.stringify({ families: index, props, models }));
console.log(`houses.bin ${(offset / 1e6).toFixed(2)} MB`);
