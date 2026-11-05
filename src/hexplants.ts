/**
 * The hex view's plants from a free model pack (Quaternius Ultimate Nature, CC0), in place of the
 * planet's own low-poly ones: built by scripts/plantpack.mjs into public/assets/hex/plants.*.
 *
 * Each Mundi plant kind (flora.ts, species.ts) maps to a set of pack models; a hash of the plant
 * picks one. Snowy ground gets the snowy versions. Kinds the pack has nothing for (acacia, baobab,
 * reeds...) stay the planet's own (null here).
 *
 * Leaves take the plant's colour (the biome's, per instance); bark, snow, berries and flowers keep
 * their own (the vertex colour's alpha says how much the instance colour tints it).
 */
import * as THREE from 'three';
import { CONIFER, BROADLEAF, SCRUB, PALM, ROCK, CACTUS, BIRCH, TUFT } from './flora.ts';
import { FIRST, FAMILIES, VARIANTS } from './species.ts';

interface Lod { verts: number; tris: number; pos: number; col: number; idx: number; wide: boolean }
interface PackIndex { sets: Record<string, string[]>; models: Record<string, { near: Lod; far: Lod; w: number }> }
export interface Pack { index: PackIndex; bin: ArrayBuffer; geo: Map<string, THREE.BufferGeometry> }

let loading: Promise<Pack> | null = null;
/** The pack, fetched once. */
export function loadPack(): Promise<Pack> {
  loading ??= Promise.all([
    fetch('/assets/hex/plants.json').then((r) => r.json() as Promise<PackIndex>),
    fetch('/assets/hex/plants.bin').then((r) => r.arrayBuffer()),
  ]).then(([index, bin]) => ({ index, bin, geo: new Map() }));
  return loading;
}

/** A model's geometry at a level of detail. */
export function packGeometry(p: Pack, name: string, lod: 'near' | 'far'): THREE.BufferGeometry {
  const key = name + '/' + lod;
  let g = p.geo.get(key);
  if (!g) {
    const L = p.index.models[name][lod];
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.bin, L.pos, L.verts * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(p.bin, L.col, L.verts * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(L.wide ? new Uint32Array(p.bin, L.idx, L.tris * 3) : new Uint16Array(p.bin, L.idx, L.tris * 3), 1));
    g.computeBoundingSphere();
    p.geo.set(key, g);
  }
  return g;
}

/** Flat shaded; the instance colour tints each vertex by its colour's alpha (leaves, not bark). */
export const packMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, vertexColors: true });
packMaterial.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `
    #if defined( USE_COLOR_ALPHA )
      vColor = vec4( color.rgb, 1.0 );
      #ifdef USE_INSTANCING_COLOR
        vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, color.a );
      #endif
    #else
      #include <color_vertex>
    #endif`);
};
packMaterial.customProgramCacheKey = () => 'hexpack';

const hash = (i: number, salt: number) => (((i * 2654435761) ^ (salt * 40503)) >>> 0) % 1000 / 1000;

/**
 * The pack model for plant i of a kind, or null to keep the planet's own. snow: 0..1 snow cover
 * where it stands; wet: 0..1 lushness (moss on rocks).
 */
export function packModel(p: Pack, kind: number, i: number, snow: number, wet: number): string | null {
  let set: string | null = null;
  const fam = kind >= FIRST ? FAMILIES[Math.floor((kind - FIRST) / VARIANTS)] : null;
  const cold = snow > 0.35;
  if (kind === CONIFER || fam === 'spruce') set = cold ? 'pineSnow' : 'pine';
  else if (kind === BROADLEAF || fam === 'oak' || fam === 'poplar') set = cold ? 'broadleafSnow' : 'broadleaf';
  else if (kind === BIRCH) set = cold ? 'birchSnow' : 'birch';
  else if (fam === 'willow') set = 'willow';
  else if (kind === PALM || fam === 'royalPalm') set = 'palm';
  else if (kind === SCRUB || fam === 'roundShrub') set = cold ? 'bushSnow' : hash(i, 3) < 0.2 ? 'bushBerries' : 'bush';
  else if (kind === CACTUS || fam === 'pricklyPear') set = hash(i, 5) < 0.3 ? 'cactusFlowers' : 'cactus';
  else if (kind === ROCK) set = cold ? 'rockSnow' : wet > 0.4 ? 'rockMoss' : 'rock';
  else if (kind === TUFT) set = cold ? null : hash(i, 7) < 0.12 ? 'plant' : 'grass';
  if (!set) return null;
  const list = p.index.sets[set];
  return list[Math.floor(hash(i, 11) * list.length)];
}

// --- Textured trees (Quaternius Textured Tree Pack, CC0), for close to the camera ---
interface TexModel { w: number; verts: number; tris: number; wide: boolean; pos: number; nor: number; uv: number; idx: number; groups: { tex: string; leaves: boolean; start: number; count: number }[] }
interface TexIndex { sets: Record<string, string[]>; models: Record<string, TexModel> }
export interface TexPack { index: TexIndex; bin: ArrayBuffer; geo: Map<string, THREE.BufferGeometry>; mats: Map<string, THREE.Material> }
let texLoading: Promise<TexPack> | null = null;
export function loadTexPack(): Promise<TexPack> {
  texLoading ??= Promise.all([
    fetch('/assets/hex/texplants.json').then((r) => r.json() as Promise<TexIndex>),
    fetch('/assets/hex/texplants.bin').then((r) => r.arrayBuffer()),
  ]).then(([index, bin]) => ({ index, bin, geo: new Map(), mats: new Map() }));
  return texLoading;
}
/** Leaves are tinted toward the plant's colour relative to this green (linear), so biomes still
 * differ; bark keeps its texture. */
const LEAF_REF = new THREE.Color(0x4a7a30);
const texLoader = new THREE.TextureLoader();
/** Called on each new material (the view adds its atmosphere). */
export let onTexMaterial: (m: THREE.Material) => void = () => {};
export function setOnTexMaterial(f: (m: THREE.Material) => void) { onTexMaterial = f; }
function texMaterial(t: TexPack, tex: string, leaves: boolean): THREE.Material {
  let m = t.mats.get(tex);
  if (!m) {
    const map = texLoader.load('/assets/hex/trees/' + tex);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.9, alphaTest: leaves ? 0.5 : 0, side: leaves ? THREE.DoubleSide : THREE.FrontSide });
    if (leaves) {
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
          #ifdef USE_INSTANCING_COLOR
            vColor.xyz = mix( vec3( 1.0 ), instanceColor.xyz / vec3( ${LEAF_REF.r.toFixed(4)}, ${LEAF_REF.g.toFixed(4)}, ${LEAF_REF.b.toFixed(4)} ), 0.6 ) * 0.72;
          #endif`);
      };
      mat.customProgramCacheKey = () => 'texleaves';
    } else {
      // Bark: the instance colour (the leaves') stays off it.
      mat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvColor.xyz = vec3(1.0);\n#endif'); };
      mat.customProgramCacheKey = () => 'texbark';
    }
    onTexMaterial(mat);
    t.mats.set(tex, m = mat);
  }
  return m;
}
function texGeometry(t: TexPack, name: string): THREE.BufferGeometry {
  let g = t.geo.get(name);
  if (!g) {
    const M = t.index.models[name];
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(t.bin, M.pos, M.verts * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(t.bin, M.nor, M.verts * 4), 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(t.bin, M.uv, M.verts * 2), 2));
    g.setIndex(new THREE.BufferAttribute(M.wide ? new Uint32Array(t.bin, M.idx, M.tris * 3) : new Uint16Array(t.bin, M.idx, M.tris * 3), 1));
    M.groups.forEach((gr, k) => g!.addGroup(gr.start, gr.count, k));
    g.computeBoundingSphere();
    t.geo.set(name, g);
  }
  return g;
}
/** The textured tree for a pack model's set, or null (snowy, willow, bushes: none). */
export function texModel(t: TexPack, far: string, i: number): string | null {
  const set = /^PineTree_\d/.test(far) ? 'pine' : /^CommonTree_\d/.test(far) ? 'broadleaf' : /^BirchTree_\d/.test(far) ? 'birch' : /_Dead_\d/.test(far) ? 'dead' : null;
  if (!set) return null;
  const list = t.index.sets[set];
  return list[Math.floor(hash(i, 13) * list.length)];
}

/**
 * Pack plants as instanced meshes: far models everywhere, and (if near > 0) within `near` metres
 * of the camera the full models, or the textured trees where given, swapped as the camera moves.
 * byModel keys: "far model|near model", near being "un:Name" (the pack's full model) or "tx:Name".
 */
export class PackPlants {
  readonly group = new THREE.Group();
  private sets: { far: THREE.InstancedMesh; near: THREE.InstancedMesh | null; mtx: Float32Array; col: Float32Array; pos: Float32Array }[] = [];
  private last = new THREE.Vector3(Infinity, 0, 0);
  private near: number;

  constructor(p: Pack, tex: TexPack | null, byModel: Map<string, { mtx: number[]; col: number[] }>, near: number) {
    this.near = near;
    for (const [key, d] of byModel) {
      const [farName, nearKey] = key.split('|');
      const n = d.mtx.length / 16;
      const mtx = new Float32Array(d.mtx), col = new Float32Array(d.col), pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { pos[k * 3] = mtx[k * 16 + 12]; pos[k * 3 + 1] = mtx[k * 16 + 13]; pos[k * 3 + 2] = mtx[k * 16 + 14]; }
      const make = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[]) => {
        const m = new THREE.InstancedMesh(geo, mat, n);
        (m.instanceMatrix.array as Float32Array).set(mtx);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(col), 3);
        m.castShadow = true; m.receiveShadow = true; m.name = 'plants';
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      };
      let nearMesh: THREE.InstancedMesh | null = null;
      if (near > 0) {
        if (nearKey.startsWith('tx:') && tex) {
          const nm = nearKey.slice(3), M = tex.index.models[nm];
          nearMesh = make(texGeometry(tex, nm), M.groups.map((g) => texMaterial(tex, g.tex, g.leaves)));
        } else nearMesh = make(packGeometry(p, nearKey.slice(3) || farName, 'near'), packMaterial);
        nearMesh.count = 0;
      }
      this.sets.push({ far: make(packGeometry(p, farName, 'far'), packMaterial), near: nearMesh, mtx, col, pos });
    }
  }

  /** Swap models near the camera (cam: in the plants' own coordinates). Cheap unless it moved. */
  update(cam: THREE.Vector3) {
    if (this.near <= 0 || cam.distanceToSquared(this.last) < (this.near * 0.1) ** 2) return;
    this.last.copy(cam);
    const r2 = this.near * this.near;
    for (const s of this.sets) {
      const F = s.far.instanceMatrix.array as Float32Array, N = s.near!.instanceMatrix.array as Float32Array;
      const FC = s.far.instanceColor!.array as Float32Array, NC = s.near!.instanceColor!.array as Float32Array;
      let nf = 0, nn = 0;
      for (let k = 0; k < s.pos.length / 3; k++) {
        const dx = s.pos[k * 3] - cam.x, dy = s.pos[k * 3 + 1] - cam.y, dz = s.pos[k * 3 + 2] - cam.z;
        if (dx * dx + dy * dy + dz * dz < r2) { N.set(s.mtx.subarray(k * 16, k * 16 + 16), nn * 16); NC.set(s.col.subarray(k * 3, k * 3 + 3), nn * 3); nn++; }
        else { F.set(s.mtx.subarray(k * 16, k * 16 + 16), nf * 16); FC.set(s.col.subarray(k * 3, k * 3 + 3), nf * 3); nf++; }
      }
      s.far.count = nf; s.near!.count = nn;
      s.far.instanceMatrix.needsUpdate = true; s.near!.instanceMatrix.needsUpdate = true;
      s.far.instanceColor!.needsUpdate = true; s.near!.instanceColor!.needsUpdate = true;
    }
  }

  dispose() { for (const s of this.sets) { s.far.dispose(); s.near?.dispose(); } }
}
