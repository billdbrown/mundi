/**
 * Buildings from Quaternius's CC0 packs for the hex view's towns (scripts/housepack.mjs builds
 * public/assets/hex/houses.bin). Three families to compare (2026-11-06): the Medieval Village
 * pack, and the Fantasy RTS pack's First Age (timber) and Second Age (stone); and "by people",
 * which gives each realm one of them, so crossing a border looks like one.
 *
 * Roofs and walls are tinted per building, leaning to a colour per people; windows glow at night.
 */
import * as THREE from 'three';

export type HouseMode = 'plain' | 'village' | 'timber' | 'stone' | 'people';
export const HOUSE_MODES: [HouseMode, string][] = [['people', 'By people'], ['village', 'Village'], ['timber', 'Timber'], ['stone', 'Stone'], ['plain', 'Plain boxes']];
type Family = 'village' | 'timber' | 'stone';
const FAMILIES: Family[] = ['village', 'timber', 'stone'];

interface ModelInfo { verts: number; tris: number; pos: number; col: number; idx: number; wide: boolean; size: [number, number, number] }
interface PackIndex { families: Record<Family, { house: string[]; extra: string[]; hall: string[] }>; props: string[]; models: Record<string, ModelInfo> }
export interface HousePack { index: PackIndex; geos: Map<string, THREE.BufferGeometry> }

let packing: Promise<HousePack> | null = null;
export function loadHouses(): Promise<HousePack> {
  packing ??= Promise.all([
    fetch('/assets/hex/houses.json').then((r) => r.json() as Promise<PackIndex>),
    fetch('/assets/hex/houses.bin').then((r) => r.arrayBuffer()),
  ]).then(([index, buf]) => {
    const geos = new Map<string, THREE.BufferGeometry>();
    for (const [name, m] of Object.entries(index.models)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, m.pos, m.verts * 3), 3));
      const c4 = new Uint8Array(buf, m.col, m.verts * 4), rgb = new Uint8Array(m.verts * 3), role = new Float32Array(m.verts);
      for (let i = 0; i < m.verts; i++) { rgb[i * 3] = c4[i * 4]; rgb[i * 3 + 1] = c4[i * 4 + 1]; rgb[i * 3 + 2] = c4[i * 4 + 2]; role[i] = c4[i * 4 + 3] / 255; }
      g.setAttribute('color', new THREE.BufferAttribute(rgb, 3, true));
      g.setAttribute('aRole', new THREE.BufferAttribute(role, 1));
      g.setIndex(new THREE.BufferAttribute(m.wide ? new Uint32Array(buf, m.idx, m.tris * 3) : new Uint16Array(buf, m.idx, m.tris * 3), 1));
      geos.set(name, g);
    }
    return { index, geos };
  });
  return packing;
}

/** Night, 0..1, for the windows (set by the hex view's time of day). */
export const houseNight = { value: 0 };
/** A new material for one drawing of the towns. Not shared across drawings: the hex view adds its
 * atmosphere and shadow code to a material each time it builds, and adding it twice breaks the
 * shader (the buildings vanished on a second hex, leaving only their shadows). */
export function houseMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = houseNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRole;\nattribute vec3 aRoof;\nattribute vec3 aWall;\nvarying float vWin;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        if (aRole > 0.2 && aRole < 0.5) vColor.rgb *= aRoof;
        else if (aRole > 0.5 && aRole < 0.8) vColor.rgb *= aWall;
        vWin = step(0.9, aRole);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vWin;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vWin * uNight * vec3(1.7, 0.85, 0.28);');
  };
  m.customProgramCacheKey = () => 'mundi-houses';
  return m;
}

/** Roof and wall colours (sRGB) per family; a people leans to one roof colour. */
const ROOFS: Record<Family, number[]> = {
  village: [0xa4412e, 0x3f7480, 0x7a4f2e, 0x5d6470, 0x8a6a3a],
  timber: [0x8a6a42, 0x7a5c38, 0x95774a, 0x6e5434, 0x9c7f55],
  stone: [0xb15945, 0x9a4a3a, 0x7f5f52, 0x5f6a74, 0xa86a3a],
};
const WALLS: Record<Family, number[]> = {
  village: [0xe6dcc0, 0xd9cba6, 0xeee6d2, 0xd8c8a8],
  timber: [0xc9b48e, 0xb8a27a],
  stone: [0xe8e6dc, 0xd8d2c0, 0xe2d8c4],
};

/** One building to draw: map position, ground height, heading, footprint (m), kind and people. */
export interface Building { x: number; y: number; gy: number; rot: number; wd: number; dp: number; ch: number; kind: number; culture: number }

/** The family a building is drawn in. */
export function familyOf(mode: HouseMode, culture: number): Family {
  return mode === 'people' ? FAMILIES[((culture % 3) + 3) % 3] : (mode as Family);
}

/** Instanced meshes for the buildings, one per model used. `K` scales them like the style's trees. */
export function buildHouses(pack: HousePack, mode: HouseMode, bs: Building[], K: number, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = 'houses';
  const byModel = new Map<string, { b: Building; s: number }[]>();
  for (const b of bs) {
    const fam = familyOf(mode, b.culture), F = pack.index.families[fam];
    const h = (b.ch * 9973) % 1;
    let name: string, s: number;
    if (b.kind > 0) {
      name = F.hall[Math.min(2, b.kind - 1)];
      s = [12, 18, 26][Math.min(2, b.kind - 1)] * K;
    } else if (h < (fam === 'village' ? 0.18 : 0.06) && F.extra.length) {
      name = F.extra[Math.floor(b.ch * 7919) % F.extra.length];
      s = Math.max(b.wd, b.dp) * 1.3 * K;
    } else {
      // Bigger plots get the bigger houses (the RTS pack's levels run small to large, in threes).
      const n = F.house.length, area = b.wd * b.dp;
      if (fam === 'village') name = F.house[Math.floor(b.ch * 7919) % n];
      else { const level = area < 45 ? 0 : area < 75 ? 1 : 2; name = F.house[(Math.floor(b.ch * 7919) % (n / 3)) * 3 + level]; }
      s = Math.max(b.wd, b.dp) * K;
    }
    if (!byModel.has(name)) byModel.set(name, []);
    byModel.get(name)!.push({ b, s });
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color();
  for (const [name, list] of byModel) {
    const geo = pack.geos.get(name)!.clone();
    const roof = new Float32Array(list.length * 3), wall = new Float32Array(list.length * 3);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(({ b, s }, i) => {
      const fam = familyOf(mode, b.culture);
      q.setFromAxisAngle(up, b.rot + ((b.ch * 13) % 1 < 0.5 ? 0 : Math.PI));
      mesh.setMatrixAt(i, m4.compose(p.set(b.x, b.gy - 0.15, -b.y), q, sc.set(s, s, s)));
      const R = ROOFS[fam], W = WALLS[fam];
      // A people leans to one roof colour; one house in four goes its own way.
      const ri = (b.ch * 31) % 1 < 0.75 ? (b.culture * 2) % R.length : Math.floor(b.ch * 977) % R.length;
      c.setHex(R[ri]).toArray(roof, i * 3);
      c.setHex(W[Math.floor(b.ch * 4241) % W.length]).toArray(wall, i * 3);
    });
    geo.setAttribute('aRoof', new THREE.InstancedBufferAttribute(roof, 3));
    geo.setAttribute('aWall', new THREE.InstancedBufferAttribute(wall, 3));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'house-models';
    group.add(mesh);
  }
  return group;
}

/** The towns' small things (hextown.ts PROPS, PROP_STRIDE values each), one mesh per kind. Their
 * own colours, but for canvas and cloth: stalls get a striped-awning red or green. */
export function buildProps(pack: HousePack, props: Float32Array, stride: number, keep: (x: number, y: number) => boolean, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const byKind = new Map<number, number[]>();
  for (let o = 0; o < props.length; o += stride) {
    if (!keep(props[o], props[o + 1])) continue;
    const k = props[o + 4];
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(o);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color();
  const CLOTH = [0xb0403a, 0x5f7a3a, 0xc9a24a, 0x3f6f8a];
  for (const [kind, list] of byKind) {
    const name = pack.index.props[kind];
    if (!name) continue;
    const geo = pack.geos.get(name)!.clone();
    const roof = new Float32Array(list.length * 3), wall = new Float32Array(list.length * 3);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((o, i) => {
      const s = props[o + 5];
      q.setFromAxisAngle(up, props[o + 3]);
      mesh.setMatrixAt(i, m4.compose(p.set(props[o], props[o + 2] - 0.05, -props[o + 1]), q, sc.set(s, s, s)));
      c.setHex(CLOTH[Math.floor(Math.abs(props[o] * 7 + props[o + 1] * 3)) % CLOTH.length]).toArray(roof, i * 3);
      c.setHex(0xe8e0cc).toArray(wall, i * 3);
    });
    geo.setAttribute('aRoof', new THREE.InstancedBufferAttribute(roof, 3));
    geo.setAttribute('aWall', new THREE.InstancedBufferAttribute(wall, 3));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'house-models';
    group.add(mesh);
  }
  return group;
}
