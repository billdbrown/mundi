/**
 * Primundi in the hex view: the caravan on the ground, moved by tapping (2026-11-06, Bill: "tap to
 * go", so a phone never has to steer). Tap the ground and the leader walks there, round houses,
 * fences, water and cliffs, keeping to streets where it can, the cart behind; tap a town building
 * (or its label) and they walk to its door, and the game opens that part of the town.
 *
 * - Nav: a walking grid over the hex (2 m), built once a map is in.
 * - Caravan: the figures, a marker that stays a fixed size on screen, footsteps ahead.
 * - townSpots: the buildings that are the town's menus (market, notice board, inn, tavern, stores).
 *
 * Coordinates: map metres, x east, y north (three's frame is x, h, -y).
 */
import * as THREE from 'three';
import { HOUSE_STRIDE, PROP_STRIDE, PROPS } from '../hextown.ts';

const CS = 2;                     // walking grid, metres a cell
/** The cart model's turn, so its shafts lead. */
const CART_TURN = -Math.PI / 2;
const SQ2 = Math.SQRT2;

export interface NavInput {
  houses: Float32Array; props: Float32Array;
  /** Town buildings' scale (the style's, as hex.ts draws them). */
  K: number;
  /** Corners of the hex, x y pairs; the walk stays inside. */
  hex: Float32Array;
  inside: (x: number, y: number) => boolean;
  ground: (x: number, y: number) => number;
  /** 0 dry; 1 a stream or river (crossable, slowly); 2 sea or lake (not). */
  water: (x: number, y: number) => number;
  /** 0..1: how much of a path or street is here. */
  path: (x: number, y: number) => number;
  /** 0..1: how wooded. */
  wood: (x: number, y: number) => number;
}

/** The walking grid: a cost per cell (0: can't go), and A* over it. */
export class Nav {
  readonly x0: number; readonly y0: number; readonly nx: number; readonly ny: number;
  readonly cost: Float32Array;
  private g: Float32Array; private from: Int32Array; private seen: Uint32Array; private closed: Uint32Array; private stamp = 0;
  private heap: Int32Array; private hf: Float32Array;

  constructor(n: NavInput) {
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
    for (let k = 0; k < n.hex.length; k += 2) { lx = Math.min(lx, n.hex[k]); hx = Math.max(hx, n.hex[k]); ly = Math.min(ly, n.hex[k + 1]); hy = Math.max(hy, n.hex[k + 1]); }
    this.x0 = lx; this.y0 = ly;
    this.nx = Math.ceil((hx - lx) / CS) + 1; this.ny = Math.ceil((hy - ly) / CS) + 1;
    const N = this.nx * this.ny, cost = (this.cost = new Float32Array(N));
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const x = lx + i * CS, y = ly + j * CS, v = j * this.nx + i;
      if (!n.inside(x, y)) continue;
      const wet = n.water(x, y);
      if (wet === 2) continue;
      const s = Math.hypot(n.ground(x + CS, y) - n.ground(x - CS, y), n.ground(x, y + CS) - n.ground(x, y - CS)) / (2 * CS);
      if (s > 0.85) continue;                                   // a cliff
      let c = 1 + s * s * 6;
      const p = n.path(x, y);
      c *= 1 - 0.45 * p;                                          // streets and roads are quicker
      c *= 1 + 0.5 * n.wood(x, y);
      if (wet === 1) c += 6;                                      // a ford
      cost[v] = c;
    }
    // Buildings: their footprints (as hexhouses.ts scales them), a little wider.
    const H = n.houses, K = n.K;
    for (let o = 0; o < H.length; o += HOUSE_STRIDE) {
      const r = H[o + 3], kind = H[o + 8];
      let w = H[o + 4] * K, d = H[o + 5] * K;
      if (kind > 0) w = d = [12, 18, 26][Math.min(2, kind - 1)] * K * 0.8;
      else if ((H[o + 7] * 9973) % 1 < 0.18) { w *= 1.3; d *= 1.3; }      // a workshop (can be bigger)
      this.block(H[o], H[o + 1], r, w + 1, d + 1);
    }
    // Things that stand in the way: wells, stalls, carts, hay, woodpiles, fences.
    const P = n.props, solid = new Set(['Well', 'MarketStand_1', 'MarketStand_2', 'Cart', 'Hay', 'Logs', 'Fence'].map((k) => PROPS.indexOf(k)));
    const fence = PROPS.indexOf('Fence');
    for (let o = 0; o < P.length; o += PROP_STRIDE) {
      const kind = P[o + 4], s = P[o + 5];
      if (!solid.has(kind)) continue;
      if (kind === fence) this.block(P[o], P[o + 1], P[o + 3], s, 0.6);
      else this.block(P[o], P[o + 1], P[o + 3], s * 0.9, s * 0.9);
    }
    this.g = new Float32Array(N); this.from = new Int32Array(N); this.seen = new Uint32Array(N); this.closed = new Uint32Array(N);
    this.heap = new Int32Array(N); this.hf = new Float32Array(N);
  }

  /** Mark a rectangle (centre, heading as hextown's `facing`, width across the front, depth) as solid. */
  block(cx: number, cy: number, rot: number, w: number, d: number) {
    const fx = Math.sin(rot), fy = -Math.cos(rot), ux = -fy, uy = fx;
    const R = Math.hypot(w, d) / 2 + CS;
    for (let y = cy - R; y <= cy + R; y += CS / 2) for (let x = cx - R; x <= cx + R; x += CS / 2) {
      const dx = x - cx, dy = y - cy;
      if (Math.abs(dx * ux + dy * uy) > w / 2 || Math.abs(dx * fx + dy * fy) > d / 2) continue;
      const v = this.at(x, y);
      if (v >= 0) this.cost[v] = 0;
    }
  }

  at(x: number, y: number) {
    const i = Math.round((x - this.x0) / CS), j = Math.round((y - this.y0) / CS);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  xy(v: number): [number, number] { return [this.x0 + (v % this.nx) * CS, this.y0 + Math.floor(v / this.nx) * CS]; }
  ok(x: number, y: number) { const v = this.at(x, y); return v >= 0 && this.cost[v] > 0; }

  /** The nearest cell you can stand on, within `reach` metres, or -1. */
  nearest(x: number, y: number, reach = 40): number {
    const v0 = this.at(x, y);
    if (v0 >= 0 && this.cost[v0] > 0) return v0;
    const ci = Math.round((x - this.x0) / CS), cj = Math.round((y - this.y0) / CS), R = Math.ceil(reach / CS);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= R && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
        const v = j * this.nx + i, d = di * di + dj * dj;
        if (this.cost[v] > 0 && d < bd) { bd = d; best = v; }
      }
    }
    return best;
  }

  /** A walk from a to b (map metres), smoothed, or null. Ends as near b as can be stood on. */
  find(ax: number, ay: number, bx: number, by: number): [number, number][] | null {
    const a = this.nearest(ax, ay, 60), b = this.nearest(bx, by, 60);
    if (a < 0 || b < 0) return null;
    if (a === b) return [[ax, ay], this.xy(b)];
    const nx = this.nx, cost = this.cost, g = this.g, from = this.from, seen = this.seen, closed = this.closed;
    const st = ++this.stamp;
    const [tx, ty] = [b % nx, Math.floor(b / nx)];
    const hMin = 0.5;                                            // the cheapest cost a cell can have, near enough
    const heur = (v: number) => { const dx = Math.abs(v % nx - tx), dy = Math.abs(Math.floor(v / nx) - ty); return hMin * (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)); };
    const heap = this.heap, hf = this.hf;
    let hn = 0;
    const push = (v: number, f: number) => {
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; heap[i] = heap[p]; hf[i] = hf[p]; i = p; }
      heap[i] = v; hf[i] = f;
    };
    const pop = () => {
      const top = heap[0], lv = heap[--hn], lf = hf[hn];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        heap[i] = heap[c]; hf[i] = hf[c]; i = c;
      }
      heap[i] = lv; hf[i] = lf;
      return top;
    };
    g[a] = 0; from[a] = -1; seen[a] = st; push(a, heur(a));
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
    let found = false, iters = 0;
    while (hn > 0 && iters++ < 600000) {
      const v = pop();
      if (closed[v] === st) continue;
      closed[v] = st;
      if (v === b) { found = true; break; }
      const i = v % nx, j = (v - i) / nx;
      for (let k = 0; k < 8; k++) {
        const ii = i + DI[k], jj = j + DJ[k];
        if (ii < 0 || jj < 0 || ii >= nx || jj >= this.ny) continue;
        const u = jj * nx + ii;
        if (cost[u] <= 0 || closed[u] === st) continue;
        // No cutting a corner past something solid.
        if (k >= 4 && (cost[j * nx + ii] <= 0 || cost[jj * nx + i] <= 0)) continue;
        const ng = g[v] + (k >= 4 ? SQ2 : 1) * (cost[v] + cost[u]) / 2;
        if (seen[u] === st && ng >= g[u]) continue;
        seen[u] = st; g[u] = ng; from[u] = v;
        push(u, ng + heur(u));
      }
    }
    if (!found) return null;
    const cells: number[] = [];
    for (let v = b; v >= 0; v = from[v]) cells.push(v);
    cells.reverse();
    // Straighten: from each point, on to the furthest one in clear sight that isn't over dearer
    // ground than its ends (so a walk down a street doesn't cut across the gardens).
    const pts: [number, number][] = [[ax, ay]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = Math.min(cells.length - 1, i + 1);
      for (let k = Math.min(cells.length - 1, i + 80); k > i + 1; k--) if (this.clear(cells[i], cells[k])) { j = k; break; }
      pts.push(this.xy(cells[j]));
      i = j;
    }
    return pts;
  }

  private clear(a: number, b: number) {
    const [ax, ay] = this.xy(a), [bx, by] = this.xy(b);
    const lim = Math.max(this.cost[a], this.cost[b]) * 1.2 + 0.05;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (CS * 0.5));
    for (let s = 1; s < n; s++) {
      const v = this.at(ax + (bx - ax) * (s / n), ay + (by - ay) * (s / n));
      if (v < 0 || this.cost[v] <= 0 || this.cost[v] > lim) return false;
    }
    return true;
  }
}

/** A part of town you can walk to: which of the town card's tabs it opens, where its door is, and
 * where its label floats. */
export interface TownSpot { tab: string; label: string; door: [number, number]; top: [number, number, number]; centre: [number, number]; radius: number }

/** What a town's landmark is, by the family it's drawn in and its tier (hexhouses.ts and
 * scripts/housepack.mjs: the families' three halls), so it can be what it looks like. */
export type Landmark = 'well' | 'market' | 'inn' | 'hall' | 'temple';
export const LANDMARKS: Record<string, Landmark[]> = {
  village: ['well', 'inn', 'hall'],          // Well, Inn, Bell_Tower
  timber: ['market', 'hall', 'hall'],        // Market, TownCenter x2
  stone: ['market', 'hall', 'temple'],       // Market, TownCenter, Temple
};

/** The square's landmark nearest the hex's middle: its index in the houses, or -1. */
export function townLandmark(H: Float32Array): number {
  let lm = -1, ld = 400;
  for (let o = 0; o < H.length; o += HOUSE_STRIDE) if (H[o + 8] > 0) { const d = Math.hypot(H[o], H[o + 1]); if (d < ld) { ld = d; lm = o; } }
  return lm;
}

/** The town at the hex's middle, and the things on and round its square that are its menus: a
 * notice board standing on the square (`board`, where to put it); the landmark when it's a market or
 * an inn; the houses nearest the square for the rest. Empty when there's no town drawn here. */
export function townSpots(H: Float32Array, P: Float32Array, K: number, home: boolean, landmark: Landmark | null,
  ground: (x: number, y: number) => number, free: (x: number, y: number) => boolean): { spots: TownSpot[]; board: [number, number, number] | null } {
  const lm = townLandmark(H);
  if (lm < 0) return { spots: [], board: null };
  const sx = H[lm], sy = H[lm + 1], tier = H[lm + 8], lw = [12, 18, 26][Math.min(2, tier - 1)] * K;
  const front = (o: number, out: number): [number, number] => {
    const r = H[o + 3];
    return [H[o] + Math.sin(r) * out, H[o + 1] - Math.cos(r) * out];
  };
  const spots: TownSpot[] = [];
  const g0 = ground(sx, sy);
  // The notice board: on the square beside the landmark, on open ground about level with it, the
  // south side first (where the camera looks from at first).
  let board: [number, number, number] | null = null;
  for (let k = 0; k < 16 && !board; k++) {
    const a = -Math.PI / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
    const rr = lw * 0.55 + 4;
    const x = sx + Math.cos(a) * rr, y = sy + Math.sin(a) * rr;
    if (free(x, y) && free(x + Math.cos(a) * 3, y + Math.sin(a) * 3) && Math.abs(ground(x, y) - g0) < 3) board = [x, y, Math.atan2(Math.cos(a), -Math.sin(a))];
  }
  if (!board) board = [sx, sy - lw * 0.55 - 4, 0];
  {
    const [bx, by, br] = board;
    // (The board faces away from the landmark; its door is in front of it.)
    spots.push({ tab: 'work', label: 'Notice board', door: [bx + Math.sin(br) * 2.5, by - Math.cos(br) * 2.5], top: [bx, by, ground(bx, by) + 2.6 * K], centre: [bx, by], radius: 1.5 * K });
  }
  const lmSpot = (tab: string, label: string): TownSpot => {
    // Its door: the side towards the board, so the square is where things happen.
    const k = Math.hypot(board![0] - sx, board![1] - sy) || 1;
    const out = lw * 0.5 + 2;
    return { tab, label, door: [sx + (board![0] - sx) / k * out, sy + (board![1] - sy) / k * out], top: [sx, sy, g0 + lw * 0.85], centre: [sx, sy], radius: lw * 0.5 };
  };
  const roles: [string, string][] = [];
  if (landmark === 'market') spots.push(lmSpot('market', 'Market'));
  if (landmark === 'inn') spots.push(lmSpot('rest', home ? 'Home' : 'Inn'));
  // Stalls on the square: the market, if the landmark isn't one.
  if (landmark !== 'market') {
    const stall = [PROPS.indexOf('MarketStand_1'), PROPS.indexOf('MarketStand_2')];
    let mx = 0, my = 0, ms = 0;
    for (let o = 0; o < P.length; o += PROP_STRIDE) if (stall.includes(P[o + 4]) && Math.hypot(P[o] - sx, P[o + 1] - sy) < 25) { mx += P[o]; my += P[o + 1]; ms++; }
    if (ms) {
      mx /= ms; my /= ms;
      const k = Math.hypot(mx - sx, my - sy) || 1;
      spots.push({ tab: 'market', label: 'Market', door: [sx + (mx - sx) / k * Math.max(4, k - 4), sy + (my - sy) / k * Math.max(4, k - 4)], top: [mx, my, ground(mx, my) + 5 * K], centre: [mx, my], radius: 6 });
    } else roles.push(['market', 'Market']);
  }
  if (landmark !== 'inn') roles.push(['rest', home ? 'Home' : 'Inn']);
  roles.push(['tavern', 'Tavern'], ['supplies', 'Stores']);
  // Houses round the square, nearest first (the bigger ones a little ahead).
  const near: { o: number; d: number }[] = [];
  for (let o = 0; o < H.length; o += HOUSE_STRIDE) {
    if (H[o + 8] > 0) continue;
    const d = Math.hypot(H[o] - sx, H[o + 1] - sy);
    if (d < 120) near.push({ o, d: d - H[o + 4] * H[o + 5] * 0.15 });
  }
  near.sort((p, q) => p.d - q.d);
  near.slice(0, roles.length).forEach(({ o }, n) => {
    const s = Math.max(H[o + 4], H[o + 5]) * K;
    spots.push({ tab: roles[n][0], label: roles[n][1], door: front(o, H[o + 5] * K / 2 + 2.5), top: [H[o], H[o + 1], H[o + 2] + s * 0.95], centre: [H[o], H[o + 1]], radius: s * 0.55 });
  });
  return { spots, board };
}

/** A notice board: two posts, a board with papers pinned to it, a little roof. Faces +z. */
export function noticeBoard(K: number): THREE.Group {
  const g = new THREE.Group();
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true });
  const wood = mat(0x6b4a2f), dark = mat(0x4a3322), paper = mat(0xe8dfc8);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material) => { const o = new THREE.Mesh(geo, m); o.castShadow = true; o.receiveShadow = true; g.add(o); };
  for (const x of [-0.85, 0.85]) add(new THREE.BoxGeometry(0.14, 2.3, 0.14).translate(x, 1.15, 0), dark);
  add(new THREE.BoxGeometry(1.9, 1.1, 0.08).translate(0, 1.45, 0.02), wood);
  add(new THREE.BoxGeometry(2.2, 0.08, 0.6).translate(0, 2.32, 0.05), dark);
  const papers: [number, number, number, number][] = [[-0.5, 1.6, 0.42, 0.5], [0.05, 1.5, 0.36, 0.44], [0.55, 1.62, 0.4, 0.38], [-0.2, 1.15, 0.34, 0.3], [0.45, 1.18, 0.3, 0.34]];
  for (const [x, y, w, h] of papers) add(new THREE.BoxGeometry(w, h, 0.02).translate(x, y, 0.08), paper);
  g.scale.setScalar(K);
  return g;
}

/** A gold dot with a dark rim, for the marker over the leader. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath(); g.moveTo(32, 60); g.lineTo(14, 30); g.arc(32, 24, 19, Math.PI * 0.84, Math.PI * 0.16); g.closePath();
  g.fillStyle = 'rgba(20,16,10,0.85)'; g.fill();
  g.beginPath(); g.moveTo(32, 54); g.lineTo(18, 30); g.arc(32, 24, 15, Math.PI * 0.84, Math.PI * 0.16); g.closePath();
  g.fillStyle = '#f2c14e'; g.fill();
  g.beginPath(); g.arc(32, 24, 6, 0, Math.PI * 2); g.fillStyle = 'rgba(20,16,10,0.75)'; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The caravan in the hex: the leader on foot, a cart behind, walking a path. */
export class Caravan {
  readonly group = new THREE.Group();
  /** Where the leader is (map metres), and is going. */
  x = 0; y = 0;
  moving = false;
  /** Called on reaching the end of a walk. */
  onArrive: (() => void) | null = null;

  private leader: THREE.Group;
  private cart: THREE.Group;
  private marker: THREE.Sprite;
  private ring: THREE.Mesh;
  private steps: THREE.Points;
  private path: [number, number][] = [];
  private seg = 0;
  private speed = 0;
  private cruise = 6;
  private heading = 0;
  private trail: [number, number][] = [];
  private phase = 0;
  private t = 0;

  private ground: (x: number, y: number) => number;
  private K: number;

  constructor(ground: (x: number, y: number) => number, K: number, cartGeo: THREE.BufferGeometry | null) {
    this.ground = ground; this.K = K;
    this.group.name = 'caravan';
    // The leader: a cloaked figure, a hat, a staff.
    const L = new THREE.Group();
    const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true });
    const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.35, 7).translate(0, 0.68, 0), mat(0x7a2e2a));
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.19, 1).translate(0, 1.5, 0), mat(0xd9b48c));
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.32, 8).translate(0, 1.72, 0), mat(0x3a2c20));
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 5).translate(0.36, 0.9, -0.08), mat(0x5a3e24));
    for (const m of [cloak, head, hat, staff]) { m.castShadow = true; L.add(m); }
    L.scale.setScalar(K);
    this.leader = L;
    // The cart: the town pack's, or a box until it is in.
    this.cart = new THREE.Group();
    if (cartGeo) this.setCart(cartGeo);
    else {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2.2).translate(0, 0.7, 0), mat(0x6b4a2f));
      c.scale.setScalar(K); c.castShadow = true; this.cart.add(c);
    }
    // A marker over them that keeps its size on screen, so they can be found from all the way out.
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), depthTest: false, transparent: true, sizeAttenuation: false }));
    this.marker.center.set(0.5, 0);
    this.marker.scale.set(0.045, 0.045, 1);
    this.marker.renderOrder = 20;
    // Where they're going: a ring; and footsteps along the way.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.9, depthTest: false }));
    this.ring.renderOrder = 19; this.ring.visible = false;
    this.steps = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xf2c14e, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.85, depthTest: false }));
    this.steps.renderOrder = 18; this.steps.frustumCulled = false;
    this.group.add(L, this.cart, this.marker, this.ring, this.steps);
  }

  /** The cart's model (the town pack's), once it is in. */
  setCart(geo: THREE.BufferGeometry) {
    for (const o of this.cart.children) (o as THREE.Mesh).geometry?.dispose();
    this.cart.clear();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
    m.scale.setScalar(2.6 * this.K); m.castShadow = true;
    m.rotation.y = CART_TURN;
    this.cart.add(m);
  }
  /** The marker's size on screen, against the scale of the group it's in. */
  markerScale(k: number) { this.marker.scale.set(0.045 * k, 0.045 * k, 1); }

  /** Stand at a point, facing a heading (radians, 0 north, as hextown's `facing`). */
  place(x: number, y: number, heading = 0) {
    this.x = x; this.y = y; this.heading = heading;
    this.path = []; this.moving = false; this.speed = 0;
    this.trail = [[x - Math.sin(heading) * 4 * this.K, y + Math.cos(heading) * 4 * this.K], [x, y]];
    this.ring.visible = false; this.steps.visible = false;
    this.pose(0);
  }

  /** Walk a path (from nav.find). Long walks go quicker, so none takes much over ten seconds. */
  walk(path: [number, number][], onArrive: (() => void) | null = null) {
    let len = 0;
    for (let k = 1; k < path.length; k++) len += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
    this.path = path; this.seg = 1; this.moving = len > 0.5; this.onArrive = onArrive;
    this.cruise = THREE.MathUtils.clamp(len / 8, 5, 60) * Math.sqrt(this.K);
    const [ex, ey] = path[path.length - 1];
    this.ring.position.set(ex, this.ground(ex, ey) + 0.25, -ey);
    this.ring.scale.setScalar(this.K);
    this.ring.visible = this.moving;
    // Footsteps every few metres.
    const gap = Math.max(3, len / 120), pts: number[] = [];
    for (let k = 1; k < path.length; k++) {
      const [x0, y0] = path[k - 1], [x1, y1] = path[k], L = Math.hypot(x1 - x0, y1 - y0);
      for (let s = gap; s < L; s += gap) { const x = x0 + (x1 - x0) * s / L, y = y0 + (y1 - y0) * s / L; pts.push(x, this.ground(x, y) + 0.3, -y); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.steps.geometry.dispose();
    this.steps.geometry = g;
    this.steps.visible = this.moving;
    if (!this.moving) { this.onArrive = null; onArrive?.(); }
  }

  stop() { this.path = []; this.moving = false; this.speed = 0; this.ring.visible = false; this.steps.visible = false; }

  update(dt: number) {
    this.t += dt;
    if (this.moving) {
      const [tx, ty] = this.path[this.seg];
      let left = 0;
      for (let k = this.seg; k < this.path.length; k++) { const [ax, ay] = k === this.seg ? [this.x, this.y] : this.path[k - 1]; left += Math.hypot(this.path[k][0] - ax, this.path[k][1] - ay); }
      // Speeding up from a stand, slowing into the end.
      const want = Math.min(this.cruise, Math.max(1.5 * this.K, left * 1.6));
      this.speed += (want - this.speed) * (1 - Math.exp(-dt * 3));
      let step = this.speed * dt;
      let x = this.x, y = this.y;
      while (step > 0 && this.seg < this.path.length) {
        const [px, py] = this.path[this.seg], d = Math.hypot(px - x, py - y);
        if (d <= step) { x = px; y = py; step -= d; this.seg++; } else { x += (px - x) / d * step; y += (py - y) / d * step; step = 0; }
      }
      const dx = x - this.x, dy = y - this.y;
      if (dx * dx + dy * dy > 1e-6) {
        const want = Math.atan2(dx, -dy);
        const d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
        this.heading += d * (1 - Math.exp(-dt * 10));
      }
      this.x = x; this.y = y;
      this.phase += Math.hypot(dx, dy) / (0.7 * this.K);
      const last = this.trail[this.trail.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) > 0.5) { this.trail.push([x, y]); if (this.trail.length > 200) this.trail.shift(); }
      void tx; void ty;
      if (this.seg >= this.path.length) {
        this.moving = false; this.speed = 0; this.ring.visible = false; this.steps.visible = false;
        const f = this.onArrive; this.onArrive = null; f?.();
      } else {
        // Footsteps already walked over go.
        const pos = this.steps.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (pos) {
          let k = 0;
          while (k < pos.count && Math.hypot(pos.getX(k) - x, -pos.getZ(k) - y) < 2.5 * this.K + 1) k++;
          if (k > 0 && k < pos.count) this.steps.geometry.setDrawRange(k, pos.count - k);
        }
      }
    }
    this.pose(dt);
  }

  private pose(dt: number) {
    void dt;
    const gy = this.ground(this.x, this.y), K = this.K;
    const bob = this.moving ? Math.abs(Math.sin(this.phase * Math.PI)) * 0.08 * K : 0;
    this.leader.position.set(this.x, gy + bob, -this.y);
    this.leader.rotation.set(0, this.heading, this.moving ? Math.sin(this.phase * Math.PI) * 0.05 : 0);
    // The cart: a few metres back along the way walked, turned along it.
    const back = 3.6 * K;
    let acc = 0, cx = this.x, cy = this.y, px = this.x, py = this.y;
    for (let k = this.trail.length - 1; k >= 0; k--) {
      const [qx, qy] = this.trail[k], d = Math.hypot(qx - px, qy - py);
      if (acc + d >= back) { const t = (back - acc) / (d || 1); cx = px + (qx - px) * t; cy = py + (qy - py) * t; break; }
      acc += d; px = qx; py = qy; cx = qx; cy = qy;
    }
    const ch = Math.atan2(this.x - cx, -(this.y - cy));
    this.cart.position.set(cx, this.ground(cx, cy), -cy);
    if (Math.hypot(this.x - cx, this.y - cy) > 0.3) this.cart.rotation.y = ch;
    this.marker.position.set(this.x, gy + 2.6 * K, -this.y);
    if (this.ring.visible) (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(this.t * 5);
  }
}
