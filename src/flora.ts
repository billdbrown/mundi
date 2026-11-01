/** Low-poly trees, drawn as one instanced mesh per kind. */
import * as THREE from 'three';
import { hash01 } from './rng.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { B } from './biomes.ts';

export const CONIFER = 0, BROADLEAF = 1, SCRUB = 2, PALM = 3, ROCK = 4, CACTUS = 5, ICEBERG = 6;
export type TreeKind = typeof CONIFER | typeof BROADLEAF | typeof SCRUB | typeof PALM | typeof ROCK | typeof CACTUS | typeof ICEBERG;
const KINDS = 7;

export interface TreeSpot {
  x: number; y: number; z: number;
  kind: TreeKind;
  color: number;
  /** World size. */
  s: number;
  spin: number;
  /** Brightness variation. */
  shade: number;
}

/** Trees packed into typed arrays, so they cross from the worker cheaply. */
export interface TreeData {
  pos: Float32Array;    // xyz per tree
  size: Float32Array;
  spin: Float32Array;
  shade: Float32Array;
  kind: Uint8Array;
  color: Uint32Array;
}

export function packTrees(spots: TreeSpot[]): TreeData {
  const n = spots.length;
  const d: TreeData = {
    pos: new Float32Array(n * 3), size: new Float32Array(n), spin: new Float32Array(n),
    shade: new Float32Array(n), kind: new Uint8Array(n), color: new Uint32Array(n),
  };
  spots.forEach((t, i) => {
    d.pos[i * 3] = t.x; d.pos[i * 3 + 1] = t.y; d.pos[i * 3 + 2] = t.z;
    d.size[i] = t.s; d.spin[i] = t.spin; d.shade[i] = t.shade; d.kind[i] = t.kind; d.color[i] = t.color;
  });
  return d;
}

/** Per biome: [kind, colour, expected trees per cell, size multiplier]. */
export const FLORA: Partial<Record<number, [TreeKind, number, number, number?][]>> = {
  [B.TAIGA]: [[CONIFER, 0x2d4a30, 8, 1.1]],
  [B.FOREST]: [[BROADLEAF, 0x3d6b2c, 6], [BROADLEAF, 0x5a7a2c, 1.2], [CONIFER, 0x33553a, 1.5]],
  [B.TEMPERATE_RAIN]: [[CONIFER, 0x2a4c34, 6, 1.25], [BROADLEAF, 0x335f2e, 3]],
  // Palms belong to coasts and dry tropics; in rainforest they read as mushrooms.
  [B.RAINFOREST]: [[BROADLEAF, 0x2a5c24, 11, 1.25], [BROADLEAF, 0x3b6e22, 3, 1.5], [BROADLEAF, 0x1f4a1f, 3, 1.1]],
  [B.BEACH]: [[PALM, 0x4a8a30, 0.5]],
  [B.DRY_FOREST]: [[BROADLEAF, 0x687a35, 4], [SCRUB, 0x7b8440, 1]],
  [B.SAVANNA]: [[SCRUB, 0x7c873d, 1.3], [ROCK, 0x9a8466, 0.2, 0.5]],
  [B.DESERT]: [[CACTUS, 0x5d7d3c, 0.7, 0.75], [ROCK, 0xa58462, 0.7, 0.6]],
  [B.GRASSLAND]: [[BROADLEAF, 0x4b7834, 0.4]],
  [B.TUNDRA]: [[CONIFER, 0x485b43, 0.35], [ROCK, 0x77776f, 1, 0.55]],
  [B.STEPPE]: [[SCRUB, 0x86884e, 0.2], [ROCK, 0x8d8670, 0.4, 0.5]],
  [B.MOUNTAIN]: [[CONIFER, 0x385036, 0.6], [ROCK, 0x6d645a, 2.2, 0.7]],
};

function trunk(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.05, 0.07, 0.3, 4).translate(0, 0.15, 0).toNonIndexed();
}

function treeGeometries(): THREE.BufferGeometry[] {
  const conifer = mergeGeometries([
    new THREE.ConeGeometry(0.34, 0.7, 6).translate(0, 0.55, 0).toNonIndexed(),
    new THREE.ConeGeometry(0.24, 0.5, 6).translate(0, 0.95, 0).toNonIndexed(),
    trunk(),
  ]);
  // A crown of three lumpy blobs (subdivided and jittered), not one faceted ball.
  const blob = (r: number, x: number, y: number, z: number, seed: number) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = 0.86 + 0.28 * hash01(seed * 131 + Math.round((p.getX(i) + 3) * 97) * 7 + Math.round((p.getY(i) + 3) * 89) * 3 + Math.round((p.getZ(i) + 3) * 83));
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
    }
    return g.translate(x, y, z).toNonIndexed();
  };
  const broadleaf = mergeGeometries([
    blob(0.34, 0, 0.72, 0, 1), blob(0.26, 0.2, 0.58, 0.08, 2), blob(0.25, -0.16, 0.6, -0.12, 3),
    trunk(),
  ]);
  const scrub = mergeGeometries([
    blob(0.36, 0, 0, 0, 4).scale(1.35, 0.55, 1.35).translate(0, 0.42, 0),
    trunk(),
  ]);
  // Palm: a tall thin trunk with a flat, drooping crown.
  const palm = mergeGeometries([
    new THREE.CylinderGeometry(0.035, 0.06, 1.0, 4).translate(0, 0.5, 0).toNonIndexed(),
    new THREE.ConeGeometry(0.42, 0.22, 7).rotateX(Math.PI).translate(0, 1.0, 0).toNonIndexed(),
  ]);
  // Props: a squat boulder, a saguaro-ish cactus, an iceberg that sits low in the water.
  const rock = new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.55, 0.8).translate(0, 0.12, 0);
  const cactus = mergeGeometries([
    new THREE.CylinderGeometry(0.08, 0.09, 0.9, 6).translate(0, 0.45, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.05, 0.05, 0.3, 5).translate(0.17, 0.6, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.04, 0.04, 0.18, 4).rotateZ(Math.PI / 2).translate(0.09, 0.45, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.05, 0.05, 0.22, 5).translate(-0.16, 0.48, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.04, 0.04, 0.16, 4).rotateZ(Math.PI / 2).translate(-0.08, 0.38, 0).toNonIndexed(),
  ]);
  const iceberg = new THREE.IcosahedronGeometry(0.5, 0).scale(1.4, 0.75, 1.1).translate(0, 0.02, 0);
  return [conifer, broadleaf, scrub, palm, rock, cactus, iceberg];
}

let shared: THREE.BufferGeometry[] | null = null;

/** The shared low-poly geometry for one kind of plant or prop. */
export function treeGeometry(kind: number): THREE.BufferGeometry {
  shared ??= treeGeometries();
  return shared[kind];
}
export const treeMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });

export function buildForest(t: TreeData): THREE.InstancedMesh[] {
  shared ??= treeGeometries();
  const byKind: number[][] = Array.from({ length: KINDS }, () => []);
  for (let i = 0; i < t.kind.length; i++) byKind[t.kind[i]].push(i);
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(),
    spin = new THREE.Quaternion(), m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3(),
    color = new THREE.Color();
  return byKind.map((list, kind) => {
    const mesh = new THREE.InstancedMesh(shared![kind], treeMaterial, Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((j, i) => {
      const x = t.pos[j * 3], y = t.pos[j * 3 + 1], z = t.pos[j * 3 + 2], s = t.size[j];
      n.set(x, y, z).normalize();
      q.setFromUnitVectors(up, n);
      spin.setFromAxisAngle(n, t.spin[j]);
      q.premultiply(spin);
      p.set(x, y, z).addScaledVector(n, -0.04 * s);
      sc.setScalar(s);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      color.setHex(t.color[j]).multiplyScalar(t.shade[j]);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  });
}
