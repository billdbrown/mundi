/**
 * Builds the hex view's plant models from Quaternius's Ultimate Nature pack (CC0; see
 * public/assets/hex/CREDITS.md) into one compact file the view loads: public/assets/hex/plants.bin
 * plus plants.json (where each model is in it).
 *
 * Each model: scaled to one unit tall, its base at y = 0 and its trunk on the axis (the hex's
 * plantMetres() sizes plants by height). Two levels of detail: "far" (simplified to a few hundred
 * triangles, for the thousands across a hex) and "near" (the full model, for close to the camera).
 * Per vertex: position (float32 x3) and colour (uint8 x4, linear): rgb, and in a how much the
 * plant's own colour (the biome's, per instance) tints it: 255 for leaves, 0 for bark, snow and
 * flowers, which keep the colour given here. Normals are not stored: the material is flat shaded.
 *
 * Usage: node scripts/plantpack.mjs [path to the pack's FBX folder]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as THREE from 'three';
globalThis.self = globalThis;
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { MeshoptSimplifier } = await import('meshoptimizer');
await MeshoptSimplifier.ready;

const DIR = process.argv[2] ?? 'C:/Users/Bill/assets/cc0/quaternius/ultimatenature/FBX/';
const OUT = 'public/assets/hex/';
const range = (base, n, from = 1) => Array.from({ length: n }, (_, i) => `${base}_${i + from}`);
/** The models, by set (the view picks a set per plant, then a model in it by a hash). */
export const SETS = {
  pine: range('PineTree', 5), pineSnow: range('PineTree_Snow', 5),
  broadleaf: range('CommonTree', 5), broadleafSnow: range('CommonTree_Snow', 5), broadleafDead: range('CommonTree_Dead', 5),
  birch: range('BirchTree', 5), birchSnow: range('BirchTree_Snow', 5), birchDead: range('BirchTree_Dead', 5),
  broadleafDeadSnow: range('CommonTree_Dead_Snow', 5), birchDeadSnow: range('BirchTree_Dead_Snow', 5),
  willow: range('Willow', 5), willowSnow: range('Willow_Snow', 5), willowDead: range('Willow_Dead', 5), willowDeadSnow: range('Willow_Dead_Snow', 5),
  palm: range('PalmTree', 4),
  bush: ['Bush_1', 'Bush_2'], bushBerries: ['BushBerries_1', 'BushBerries_2'], bushSnow: ['Bush_Snow_1', 'Bush_Snow_2'],
  cactus: range('Cactus', 5), cactusFlowers: ['CactusFlower_1', ...range('CactusFlowers', 4, 2)],
  rock: range('Rock', 7), rockMoss: range('Rock_Moss', 7), rockSnow: range('Rock_Snow', 7),
  grass: ['Grass', 'Grass_2', 'Grass_Short'], plant: range('Plant', 5),
  // (One flower model in the pack; its petals recoloured for variety: "name~colour".)
  flowers: ['Flowers', 'Flowers~yellow', 'Flowers~white', 'Flowers~purple', 'Flowers~red'],
  stump: ['TreeStump', 'TreeStump_Moss', 'TreeStump_Snow'], log: ['WoodLog', 'WoodLog_Moss', 'WoodLog_Snow'],
  lilypad: ['Lilypad'],
};

/** Petal colours for recoloured copies ("Flowers~yellow"): replace the model's Cyan. */
const PETALS = { yellow: 0xe6c23c, white: 0xe9e5dc, purple: 0x8058b8, red: 0xc0383a };
/** Colour (sRGB hex) and tint (0..1) for a material, by its name (the pack's own are dimmed). */
function role(mat, model) {
  const n = mat.replace(/\.\d+$/, '');
  const petal = PETALS[model.split('~')[1]];
  if (petal && n === 'Cyan') return [petal, 0];
  const isRock = model.startsWith('Rock');
  switch (n) {
    case 'Green': return isRock ? [0x5d6b3a, 0] : [0xffffff, 1];
    case 'DarkGreen': return [0xb4b4b4, 1];
    case 'Leaves': return [0xd8d8d8, 1];
    case 'Wood': return [0x4b3d31, 0];
    case 'LightWood': return [0x66523f, 0];
    case 'Coconuts': return [0x5a4128, 0];
    case 'White': return [0xd9d5c9, 0];
    case 'Black': return [0x2d2a26, 0];
    case 'Snow': return [0xf1f3f5, 0];
    case 'Rock': return [0xffffff, 1];
    case 'Berry': return [0xa3222c, 0];
    case 'Pink': return [0xd2558d, 0];
    case 'Yellow': return [0xe2c247, 0];
    case 'Cyan': return [0x4aa7c4, 0];
    case 'Orange': return [0xc0612a, 0];
    case 'LightOrange': return [0xd89a3c, 0];
    case 'Mushroom_Top': return [0xa8402e, 0];
    case 'Mushroom_Bottom': return [0xd9c8a8, 0];
    default: console.warn('unknown material', n, 'in', model); return [0xff00ff, 0];
  }
}

const loader = new FBXLoader();
/** One model as groups of welded triangles, one group per material: { pos: number[], idx: number[], col: [r,g,b,a] }. */
function load(name) {
  const b = readFileSync(DIR + name.split('~')[0] + '.fbx');
  const root = loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), DIR);
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
      const [hex, tint] = role(m.name, name);
      const key = hex + ':' + tint;
      if (!groups.has(key)) {
        const c = new THREE.Color(hex);   // to linear
        groups.set(key, { pos: [], col: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(tint * 255)] });
      }
      const G = groups.get(key);
      for (let i = r.start; i < r.start + r.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); G.pos.push(v.x, v.y, v.z); }
    }
  });
  return [...groups.values()];
}

/** Weld a triangle soup: shared corners become one vertex. */
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

/** Simplify one group to about `ratio` of its triangles, keeping its outline where it can. */
function simplify(w, ratio, scale) {
  if (ratio >= 1 || w.idx.length < 60) return w;
  const target = Math.max(12, Math.floor((w.idx.length * ratio) / 3) * 3);
  let [idx] = MeshoptSimplifier.simplify(w.idx, w.pos, 3, target, 0.08 * scale, []);
  if (idx.length > target * 1.6) idx = MeshoptSimplifier.simplifySloppy(w.idx, w.pos, 3, null, target, 0.08 * scale)[0];
  return { pos: w.pos, idx };
}

const FAR_TRIS = { tree: 320, small: 120 };
const models = {}, chunks = [];
let vBytes = 0, iBytes = 0, offset = 0;
const push = (buf) => { const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; } chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); const at = offset; offset += buf.byteLength; return at; };

for (const name of [...new Set(Object.values(SETS).flat())]) {
  const groups = load(name).map((g) => ({ ...weld(g.pos), col: g.col }));
  // Bounds: height to one unit; the trunk (lowest tenth) on the axis.
  let y0 = Infinity, y1 = -Infinity;
  for (const g of groups) for (let i = 1; i < g.pos.length; i += 3) { y0 = Math.min(y0, g.pos[i]); y1 = Math.max(y1, g.pos[i]); }
  const H = y1 - y0;
  let cx = 0, cz = 0, cn = 0;
  for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) if (g.pos[i + 1] < y0 + 0.1 * H) { cx += g.pos[i]; cz += g.pos[i + 2]; cn++; }
  cx /= cn || 1; cz /= cn || 1;
  for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) { g.pos[i] = (g.pos[i] - cx) / H; g.pos[i + 1] = (g.pos[i + 1] - y0) / H; g.pos[i + 2] = (g.pos[i + 2] - cz) / H; }
  const tris = groups.reduce((a, g) => a + g.idx.length / 3, 0);
  const small = /^(Bush|Grass|Plant|Flowers|Rock|TreeStump|WoodLog|Lilypad|Cactus)/.test(name);
  const ratio = Math.min(1, (small ? FAR_TRIS.small : FAR_TRIS.tree) / tris);
  const lods = {};
  for (const [lod, gs] of [['near', groups], ['far', groups.map((g) => simplify(g, ratio, 1))]]) {
    // One vertex/index buffer per level: groups appended, colours per vertex.
    const used = gs.map((g) => { const keep = new Map(); for (const i of g.idx) if (!keep.has(i)) keep.set(i, keep.size); return keep; });
    const nv = used.reduce((a, k) => a + k.size, 0), ni = gs.reduce((a, g) => a + g.idx.length, 0);
    const pos = new Float32Array(nv * 3), col = new Uint8Array(nv * 4), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vb = 0, ib = 0;
    gs.forEach((g, gi) => {
      for (const [old, nu] of used[gi]) { pos.set(g.pos.subarray(old * 3, old * 3 + 3), (vb + nu) * 3); col.set(groups[gi].col, (vb + nu) * 4); }
      for (const i of g.idx) idx[ib++] = vb + used[gi].get(i);
      vb += used[gi].size;
    });
    lods[lod] = { verts: nv, tris: ni / 3, pos: push(pos), col: push(col), idx: push(idx), wide: idx instanceof Uint32Array };
    vBytes += pos.byteLength + col.byteLength; iBytes += idx.byteLength;
  }
  // Crown width over height: the view keeps wide crowns to the footprint of Mundi's own.
  let r = 0; for (const g of groups) for (let i = 0; i < g.pos.length; i += 3) r = Math.max(r, Math.hypot(g.pos[i], g.pos[i + 2]));
  lods.w = 2 * r;
  models[name] = lods;
  console.log(name.padEnd(22), 'tris', String(tris).padStart(5), '-> far', String(lods.far.tris).padStart(4), ' near verts', lods.near.verts);
}
mkdirSync(OUT, { recursive: true });
const bin = new Uint8Array(offset);
let o = 0; for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
writeFileSync(OUT + 'plants.bin', bin);
writeFileSync(OUT + 'plants.json', JSON.stringify({ source: 'Quaternius Ultimate Nature (CC0)', sets: SETS, models }));
console.log(`plants.bin ${(offset / 1e6).toFixed(2)} MB (vertices ${(vBytes / 1e6).toFixed(2)}, indices ${(iBytes / 1e6).toFixed(2)})`);

