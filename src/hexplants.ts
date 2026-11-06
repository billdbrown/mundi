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
import { H_STUMP, H_LOG, H_FLOWERS, H_LILYPAD, H_DEAD, H_FERN, isFlower } from './hexlocal.ts';
import { swayMaterial, swayDepth } from './hexwind.ts';

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
  // Less sky light low in a plant and toward its middle: crowns read as round masses, not cut-outs.
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vPlantAO;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlantAO = clamp(0.45 + 0.55 * smoothstep(0.0, 0.85, position.y) + 0.25 * smoothstep(0.1, 0.45, length(position.xz)), 0.0, 1.0);');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPlantAO;')
    .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= vPlantAO;');
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
/** Rocks, stumps, logs and lily pads: the same, but still in the wind (packMaterial sways). */
export const packStill = packMaterial.clone();
packStill.onBeforeCompile = packMaterial.onBeforeCompile;
packStill.customProgramCacheKey = () => 'hexpackstill';
swayMaterial(packMaterial);

const hash = (i: number, salt: number) => (((i * 2654435761) ^ (salt * 40503)) >>> 0) % 1000 / 1000;

/**
 * The pack model for plant i of a kind, or null to keep the planet's own. snow: 0..1 snow cover
 * where it stands; wet: 0..1 lushness or forest shade (moss on rocks, stumps and logs).
 */
export function packModel(p: Pack, kind: number, i: number, snow: number, wet: number): string | null {
  let set: string | null = null;
  const fam = kind >= FIRST ? FAMILIES[Math.floor((kind - FIRST) / VARIANTS)] : null;
  const cold = snow > 0.35;
  if (kind === CONIFER || fam === 'spruce') set = cold ? 'pineSnow' : 'pine';
  else if (kind === BROADLEAF || fam === 'oak' || fam === 'poplar') set = cold ? 'broadleafSnow' : 'broadleaf';
  else if (kind === BIRCH) set = cold ? 'birchSnow' : 'birch';
  else if (fam === 'willow') set = cold ? 'willowSnow' : 'willow';
  else if (kind === PALM || fam === 'royalPalm') set = 'palm';
  else if (kind === SCRUB || fam === 'roundShrub') set = cold ? 'bushSnow' : hash(i, 3) < 0.2 ? 'bushBerries' : 'bush';
  else if (kind === CACTUS || fam === 'pricklyPear') set = hash(i, 5) < 0.3 ? 'cactusFlowers' : 'cactus';
  else if (kind === ROCK) set = cold ? 'rockSnow' : wet > 0.4 ? 'rockMoss' : 'rock';
  else if (kind === TUFT) set = cold ? null : hash(i, 7) < 0.12 ? 'plant' : 'grass';
  else if (kind === H_DEAD) { const d = hash(i, 9) < 0.8 ? 'broadleafDead' : 'birchDead'; set = cold ? d + 'Snow' : d; }
  else if (isFlower(kind)) return cold ? null : p.index.sets.flowers[(kind - H_FLOWERS) % p.index.sets.flowers.length];
  else if (kind === H_FERN) set = cold ? null : 'plant';
  else if (kind === H_LILYPAD) set = 'lilypad';
  else if (kind === H_STUMP || kind === H_LOG) return p.index.sets[kind === H_STUMP ? 'stump' : 'log'][cold ? 2 : wet > 0.4 || hash(i, 9) < 0.3 ? 1 : 0];
  if (!set) return null;
  const list = p.index.sets[set];
  return list[Math.floor(hash(i, 11) * list.length)];
}

/**
 * Pack plants as instanced meshes, a pair per model: the simplified model everywhere, and within
 * `near` metres of the camera the full one, swapped as the camera moves.
 */
export class PackPlants {
  readonly group = new THREE.Group();
  private sets: { far: THREE.InstancedMesh | null; near: THREE.InstancedMesh | null; mtx: Float32Array; col: Float32Array; pos: Float32Array }[] = [];
  private last = new THREE.Vector3(Infinity, 0, 0);
  private near: number;

  constructor(p: Pack, byModel: Map<string, { mtx: number[]; col: number[]; nearOnly?: boolean }>, near: number) {
    this.near = near;
    const still = new Set(['rock', 'rockMoss', 'rockSnow', 'stump', 'log', 'lilypad'].flatMap((k) => p.index.sets[k] ?? []));
    for (const [name, d] of byModel) {
      const sways = !still.has(name);
      const n = d.mtx.length / 16;
      const mtx = new Float32Array(d.mtx), col = new Float32Array(d.col), pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { pos[k * 3] = mtx[k * 16 + 12]; pos[k * 3 + 1] = mtx[k * 16 + 13]; pos[k * 3 + 2] = mtx[k * 16 + 14]; }
      const make = (geo: THREE.BufferGeometry) => {
        const m = new THREE.InstancedMesh(geo, sways ? packMaterial : packStill, n);
        if (sways) m.customDepthMaterial = swayDepth;
        (m.instanceMatrix.array as Float32Array).set(mtx);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(col), 3);
        m.castShadow = true; m.receiveShadow = true; m.name = 'plants';
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      };
      let nearMesh: THREE.InstancedMesh | null = null;
      if (near > 0) { nearMesh = make(packGeometry(p, name, 'near')); nearMesh.count = 0; }
      // Small things (flowers, ferns, stumps) only up close: from further they are under a pixel.
      const farMesh = d.nearOnly && nearMesh ? null : make(packGeometry(p, name, 'far'));
      this.sets.push({ far: farMesh, near: nearMesh, mtx, col, pos });
    }
  }

  /** Swap models near the camera (cam: in the plants' own coordinates). Cheap unless it moved. */
  update(cam: THREE.Vector3) {
    if (this.near <= 0 || cam.distanceToSquared(this.last) < (this.near * 0.1) ** 2) return;
    this.last.copy(cam);
    const r2 = this.near * this.near;
    for (const s of this.sets) {
      const F = s.far?.instanceMatrix.array as Float32Array | undefined, N = s.near!.instanceMatrix.array as Float32Array;
      const FC = s.far?.instanceColor!.array as Float32Array | undefined, NC = s.near!.instanceColor!.array as Float32Array;
      let nf = 0, nn = 0;
      for (let k = 0; k < s.pos.length / 3; k++) {
        const dx = s.pos[k * 3] - cam.x, dy = s.pos[k * 3 + 1] - cam.y, dz = s.pos[k * 3 + 2] - cam.z;
        if (dx * dx + dy * dy + dz * dz < r2) { N.set(s.mtx.subarray(k * 16, k * 16 + 16), nn * 16); NC.set(s.col.subarray(k * 3, k * 3 + 3), nn * 3); nn++; }
        else if (F && FC) { F.set(s.mtx.subarray(k * 16, k * 16 + 16), nf * 16); FC.set(s.col.subarray(k * 3, k * 3 + 3), nf * 3); nf++; }
      }
      s.near!.count = nn; s.near!.instanceMatrix.needsUpdate = true; s.near!.instanceColor!.needsUpdate = true;
      if (s.far) { s.far.count = nf; s.far.instanceMatrix.needsUpdate = true; s.far.instanceColor!.needsUpdate = true; }
    }
  }

  dispose() { for (const s of this.sets) { s.far?.dispose(); s.near?.dispose(); } }
}
