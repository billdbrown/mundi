/**
 * A town's trade, shown round its edge in the hex (towns.ts says what it is): a jetty and boats
 * on the shore for a fishing town, a pit head and spoil on the hill for a mining one, and so on.
 * Low-poly placeholders built here, in the scene's own frame (x, height, -y), sized by the town's
 * scale K. Game only: Mundi's hex view doesn't call it.
 */
import * as THREE from 'three';
import { makeRng } from '../rng.ts';
import type { Trade } from './towns.ts';

const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true });
const WOOD = 0x6b4a2f, DARK = 0x3d2b1c, STONE = 0x8a867c, CLOTH = 0xd8cfb4;
function box(w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), mat(c));
  m.castShadow = true;
  return m;
}
function post(h: number, x: number, z: number, c = DARK, r = 0.08) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 5).translate(x, h / 2, z), mat(c));
  m.castShadow = true;
  return m;
}
/** An A-frame rack with things hung on it (fish, hides, cloth). */
function rack(hang: number, n = 4) {
  const g = new THREE.Group();
  for (const x of [-1.2, 1.2]) for (const z of [-0.4, 0.4]) { const p = post(2.1, x, z); p.rotation.x = z > 0 ? -0.18 : 0.18; g.add(p); }
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 5).rotateZ(Math.PI / 2).translate(0, 2, 0), mat(DARK))));
  for (let i = 0; i < n; i++) g.add(box(0.35, 0.7, 0.06, hang, -0.9 + i * (1.8 / Math.max(1, n - 1)), 1.25, 0));
  return g;
}
function boat(c: number) {
  const g = new THREE.Group();
  // A hull pulled up on the shore: a long box, a pointed bow, a thwart, oars.
  g.add(box(1.3, 0.55, 3.0, c, 0, 0, 0));
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.3, 4, 1).rotateY(Math.PI / 4).scale(0.87, 1, 0.42).rotateX(Math.PI / 2).translate(0, 0.32, 2.1), mat(c));
  bow.castShadow = true;
  g.add(bow, box(1.2, 0.08, 0.3, DARK, 0, 0.5, 0.3), box(1.36, 0.08, 3.0, 0xcfc6ae, 0, 0.55, 0));
  for (const x of [-0.3, 0.3]) { const o = box(0.06, 0.06, 2.6, DARK, x, 0.62, -0.2); o.rotation.y = x * 0.3; g.add(o); }
  return g;
}
function jetty(len: number) {
  const g = new THREE.Group();
  g.add(box(1.6, 0.15, len, WOOD, 0, 0.9, len / 2));
  for (let z = 0.5; z < len; z += 2.2) for (const x of [-0.7, 0.7]) g.add(post(1.6, x, z, DARK, 0.1));
  return g;
}
function heap(r: number, h: number, c: number) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7).translate(0, h / 2, 0), mat(c));
  m.castShadow = true;
  return m;
}
function headframe() {
  const g = new THREE.Group();
  for (const [x, z] of [[-1.3, -1], [1.3, -1], [-1.3, 1], [1.3, 1]]) { const p = post(6, x * 0.6, z * 0.6, WOOD, 0.13); p.rotation.set(z * -0.12, 0, x * 0.1); g.add(p); }
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.08, 5, 12).translate(0, 6.1, 0), mat(DARK));
  g.add(wheel, box(2.6, 0.2, 2.6, WOOD, 0, 5.6, 0), box(1.8, 0.4, 1.8, DARK, 0, 0, 0));
  return g;
}
function pen(w: number, d: number) {
  const g = new THREE.Group();
  const rail = (x0: number, z0: number, x1: number, z1: number) => {
    const L = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(x1 - x0, z1 - z0);
    for (const y of [0.45, 0.85]) { const r = box(0.06, 0.06, L, WOOD, 0, y, 0); r.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2); r.rotation.y = a; r.geometry.translate(0, 0, 0); g.add(r); }
    for (let k = 0; k <= Math.ceil(L / 2.5); k++) { const t = k / Math.ceil(L / 2.5); g.add(post(1.1, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)); }
  };
  rail(-w / 2, -d / 2, w / 2, -d / 2); rail(w / 2, -d / 2, w / 2, d / 2); rail(w / 2, d / 2, -w / 2, d / 2); rail(-w / 2, d / 2, -w / 2, -d / 2 + 2);
  return g;
}
function sheep(rng: () => number) {
  const g = new THREE.Group();
  g.add(box(0.7, 0.5, 1.0, 0xe8e2d2, 0, 0.35, 0), box(0.28, 0.3, 0.35, 0x2c241c, 0, 0.6, 0.6));
  for (const [x, z] of [[-0.2, 0.3], [0.2, 0.3], [-0.2, -0.3], [0.2, -0.3]]) g.add(box(0.08, 0.35, 0.08, 0x2c241c, x, 0, z));
  g.rotation.y = rng() * Math.PI * 2;
  return g;
}
function stall(c: number) {
  const g = new THREE.Group();
  for (const [x, z] of [[-1, -0.7], [1, -0.7], [-1, 0.7], [1, 0.7]]) g.add(post(2.2, x, z));
  g.add(box(2.4, 0.08, 1.8, c, 0, 2.2, 0), box(2.1, 0.7, 0.8, WOOD, 0, 0, -0.3));
  return g;
}
function standingStones(rng: () => number) {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2, h = 2 + rng() * 1.6; const s = box(0.7, h, 0.45, STONE, Math.cos(a) * 5, 0, Math.sin(a) * 5); s.rotation.y = -a; g.add(s); }
  g.add(box(1.6, 0.9, 1.0, STONE, 0, 0, 0));
  return g;
}

/** A thing to put down for a trade, and what kind of ground it wants. */
export interface TradeProp { obj: THREE.Object3D; want: 'shore' | 'high' | 'flat' | 'any'; /** Footprint (metres, unscaled) for the walk grid. */ size: number; /** Faces the water. */ faceWater?: boolean }

/** The props for a town's trade (its main one). */
export function tradeProps(trade: Trade, K: number, seed: number): TradeProp[] {
  const rng = makeRng(seed >>> 0);
  const out: TradeProp[] = [];
  const add = (o: THREE.Object3D, want: TradeProp['want'], size: number, faceWater = false) => { o.scale.multiplyScalar(K); out.push({ obj: o, want, size: size * K, faceWater }); };
  switch (trade) {
    case 'fishing': {
      add(jetty(14), 'shore', 4, true);
      for (let i = 0; i < 2; i++) { const b = boat([0x5a4632, 0x3f5a6a, 0x7a3a2a][i % 3]); b.rotation.y = rng() * 0.6; add(b, 'shore', 4); }
      for (let i = 0; i < 2; i++) add(rack(0x9aa0a0, 5), 'shore', 3);
      break;
    }
    case 'mining': add(headframe(), 'high', 5); add(heap(4, 3, 0x6a6660), 'high', 8); add(heap(2.5, 2, 0x5c5852), 'high', 5); break;
    case 'salt': for (let i = 0; i < 6; i++) add(box(5, 0.12, 3.5, 0xeeeee8, 0, 0, 0), 'flat', 6); add(heap(1.2, 1.2, 0xf4f2ec), 'flat', 3); break;
    case 'trapping': for (let i = 0; i < 3; i++) add(rack(0x7a5434, 3), 'any', 3); add(heap(1.6, 2.6, 0x5a4a3a), 'any', 3); break;
    case 'herding': { const p = pen(14, 10); for (let i = 0; i < 6; i++) { const s = sheep(rng); s.position.set((rng() - 0.5) * 11, 0, (rng() - 0.5) * 7); p.add(s); } add(p, 'flat', 15); break; }
    case 'farming': for (let i = 0; i < 5; i++) add(heap(1.4, 2.2, 0xc9a85a), 'flat', 3); add(box(5, 3, 4, WOOD), 'flat', 6); break;
    case 'timber': for (let i = 0; i < 3; i++) { const g = new THREE.Group(); for (let k = 0; k < 6; k++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 5, 6).rotateZ(Math.PI / 2).translate(0, 0.25 + Math.floor(k / 3) * 0.45, (k % 3 - 1) * 0.5 + (k >= 3 ? 0.25 : 0)), mat(0x7a5a38)); l.castShadow = true; g.add(l); } add(g, 'any', 5); } break;
    case 'weaving': for (let i = 0; i < 3; i++) add(rack([0xa83a3a, 0x3a5aa8, 0xd8b03a][i], 3), 'any', 3); break;
    case 'smithing': { const g = new THREE.Group(); g.add(box(4, 2.6, 3, STONE), box(0.9, 5, 0.9, 0x5c5852, 1.2, 0, 0.8), box(0.6, 0.7, 0.4, DARK, -1, 0, 2.2)); add(g, 'any', 6); add(heap(1.5, 1.2, 0x2a2622), 'any', 3); break; }
    case 'market': for (let i = 0; i < 4; i++) add(stall([0xa83a3a, 0x3a7a5a, 0xd8b03a, 0x6a4a8a][i]), 'flat', 3.5); break;
    case 'shrine': add(standingStones(rng), 'high', 12); break;
  }
  for (const p of out) p.obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  void CLOTH;
  return out;
}
