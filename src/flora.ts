/** Low-poly trees, drawn as one instanced mesh per kind. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { B } from './biomes.ts';

export const CONIFER = 0, BROADLEAF = 1, SCRUB = 2;
export type TreeKind = typeof CONIFER | typeof BROADLEAF | typeof SCRUB;

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

/** Per biome: [kind, colour, expected trees per cell]. */
export const FLORA: Partial<Record<number, [TreeKind, number, number][]>> = {
  [B.TAIGA]: [[CONIFER, 0x2d4a30, 7]],
  [B.FOREST]: [[BROADLEAF, 0x3d6b2c, 6], [CONIFER, 0x33553a, 1.5]],
  [B.TEMPERATE_RAIN]: [[CONIFER, 0x2a4c34, 6], [BROADLEAF, 0x335f2e, 3]],
  [B.RAINFOREST]: [[BROADLEAF, 0x2a5c24, 10]],
  [B.DRY_FOREST]: [[BROADLEAF, 0x687a35, 4], [SCRUB, 0x7b8440, 1]],
  [B.SAVANNA]: [[SCRUB, 0x7c873d, 1.3]],
  [B.GRASSLAND]: [[BROADLEAF, 0x4b7834, 0.4]],
  [B.TUNDRA]: [[CONIFER, 0x485b43, 0.35]],
  [B.STEPPE]: [[SCRUB, 0x86884e, 0.2]],
  [B.MOUNTAIN]: [[CONIFER, 0x385036, 0.6]],
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
  const broadleaf = mergeGeometries([
    new THREE.IcosahedronGeometry(0.42, 0).scale(1, 1.1, 1).translate(0, 0.68, 0),
    trunk(),
  ]);
  const scrub = mergeGeometries([
    new THREE.IcosahedronGeometry(0.36, 0).scale(1.35, 0.55, 1.35).translate(0, 0.42, 0),
    trunk(),
  ]);
  return [conifer, broadleaf, scrub];
}

let shared: THREE.BufferGeometry[] | null = null;
export const treeMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });

export function buildForest(spots: TreeSpot[]): THREE.InstancedMesh[] {
  shared ??= treeGeometries();
  const byKind: TreeSpot[][] = [[], [], []];
  for (const s of spots) byKind[s.kind].push(s);
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(),
    spin = new THREE.Quaternion(), m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3(),
    color = new THREE.Color();
  return byKind.map((list, kind) => {
    const mesh = new THREE.InstancedMesh(shared![kind], treeMaterial, Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((t, i) => {
      n.set(t.x, t.y, t.z).normalize();
      q.setFromUnitVectors(up, n);
      spin.setFromAxisAngle(n, t.spin);
      q.premultiply(spin);
      p.set(t.x, t.y, t.z).addScaledVector(n, -0.04 * t.s);
      sc.setScalar(t.s);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      color.setHex(t.color).multiplyScalar(t.shade);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  });
}
