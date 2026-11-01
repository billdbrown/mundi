/**
 * Draws a History (civ.ts) on the planet. Everything carries the year it appears, and one
 * uniform, uYear, decides what shows: farmland and towns painted into the terrain (a per-vertex
 * attribute the terrain shader reads), roads that grow along their routes, houses that rise,
 * and realm borders for each century.
 */
import * as THREE from 'three';
import type { World } from './world.ts';
import type { SurfaceQueries } from './surface.ts';
import { farmRadius, urbanRadius, arable, popAt, type History } from './civ.ts';
import { makeRng } from './rng.ts';

const NEVER = 1e9;

export class CivLayer {
  readonly group = new THREE.Group();
  private uYear: { value: number };
  private roads?: THREE.Mesh;
  private houses?: THREE.InstancedMesh;
  private borders?: THREE.LineSegments;
  private roadMat: THREE.MeshStandardMaterial;
  private houseMat: THREE.MeshStandardMaterial;
  private borderMat: THREE.LineBasicMaterial;
  /** For clearYear: each settlement's farm radius by tick, and which settlements reach each cell. */
  private farmBy: Float32Array[] = [];
  private near = new Map<number, number[]>();
  private hist: History | null = null;
  private worldRef: World | null = null;

  /** Year a spot is cleared for farming (0 = never): trees there are felled then. */
  readonly clearYear = (x: number, y: number, z: number, cell: number): number => {
    const h = this.hist, w = this.worldRef;
    if (!h || !w || !arable(w, cell)) return 0;
    const list = this.near.get(cell);
    if (!list) return 0;
    const P = w.grid.centers, spacing = Math.sqrt((4 * Math.PI) / w.grid.count), ticks = h.years / h.step + 1;
    const l = Math.hypot(x, y, z);
    let best = Infinity;
    for (const i of list) {
      const st = h.settlements[i], r = this.farmBy[i], c = st.cell;
      const d = Math.acos(Math.min(1, (x * P[c * 3] + y * P[c * 3 + 1] + z * P[c * 3 + 2]) / l)) / spacing;
      if (r[ticks - 1] < d) continue;
      let lo = 0, hi = ticks - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (r[m] >= d) hi = m; else lo = m + 1; }
      best = Math.min(best, Math.max(st.founded, lo * h.step));
    }
    return best === Infinity ? 0 : Math.max(1, best);
  };

  constructor(uYear: { value: number }) {
    this.uYear = uYear;
    const yearCull = (attr: string, varying: string, grow: string) => (sh: THREE.WebGLProgramParametersWithUniforms) => {
      sh.uniforms.uYear = this.uYear;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute float ${attr};\nvarying float ${varying};\nuniform float uYear;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${varying} = ${attr};\n${grow}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float ${varying};\nuniform float uYear;`)
        .replace('#include <clipping_planes_fragment>', `if (uYear < ${varying}) discard;\n#include <clipping_planes_fragment>`);
    };
    this.roadMat = new THREE.MeshStandardMaterial({ color: 0xb9aa86, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.roadMat.onBeforeCompile = yearCull('year', 'vYear', '');
    this.houseMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 });
    // Houses rise out of the ground over twenty years.
    this.houseMat.onBeforeCompile = yearCull('birth', 'vBirth', 'transformed *= clamp((uYear - birth) / 20.0, 0.0, 1.0);');
    this.borderMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
    // Each century's borders show only during that century.
    this.borderMat.onBeforeCompile = (sh) => {
      sh.uniforms.uYear = this.uYear;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float century;\nvarying float vCentury;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCentury = century;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCentury;\nuniform float uYear;')
        .replace('#include <clipping_planes_fragment>', 'if (abs(vCentury - floor(uYear / 100.0)) > 0.5) discard;\n#include <clipping_planes_fragment>');
    };
  }

  dispose() {
    for (const o of [this.roads, this.houses, this.borders]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
    }
    this.roads = this.houses = this.borders = undefined;
  }

  /**
   * Build everything for a history on the current terrain. `terrain` is the terrain mesh,
   * `faces` its triangle-to-cell map; farmland and towns go into its 'civ' attribute.
   */
  build(w: World, h: History, terrain: THREE.Mesh, faces: Int32Array, s: SurfaceQueries) {
    this.dispose();
    const g = w.grid, N = g.count, P = g.centers;
    const spacing = Math.sqrt((4 * Math.PI) / N);
    const geo = terrain.geometry, pos = geo.getAttribute('position'), index = geo.getIndex()!;

    // Triangles per cell (the builders emit each cell's triangles together).
    const triStart = new Int32Array(N).fill(-1), triCount = new Int32Array(N);
    faces.forEach((c, t) => { if (triStart[c] < 0) triStart[c] = t; triCount[c]++; });
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3(), ray = new THREE.Ray();
    const hit = new THREE.Vector3();
    /** Ground radius along a direction, testing only the given cell's triangles (then its neighbours'). */
    const groundAt = (dx: number, dy: number, dz: number, cell: number): number => {
      ray.origin.set(0, 0, 0);
      ray.direction.set(dx, dy, dz).normalize();
      for (const k of [cell, ...g.neighbors[cell]]) {
        for (let t = triStart[k]; t >= 0 && t < triStart[k] + triCount[k]; t++) {
          a.fromBufferAttribute(pos, index.getX(t * 3));
          b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
          c3.fromBufferAttribute(pos, index.getX(t * 3 + 2));
          if (ray.intersectTriangle(a, b, c3, false, hit)) return hit.length();
        }
      }
      return s.centerH(cell);
    };
    const cellOf = (dx: number, dy: number, dz: number, near: number) => {
      let cur = near;
      for (;;) {
        let best = cur, bd = P[cur * 3] * dx + P[cur * 3 + 1] * dy + P[cur * 3 + 2] * dz;
        for (const n of g.neighbors[cur]) {
          const d = P[n * 3] * dx + P[n * 3 + 1] * dy + P[n * 3 + 2] * dz;
          if (d > bd) { bd = d; best = n; }
        }
        if (best === cur) return cur;
        cur = best;
      }
    };

    // --- Farmland and towns, per terrain vertex: the first year each was reached. ---
    const civ = new Float32Array(pos.count * 2).fill(NEVER);
    const vertCells = new Map<number, number[]>();     // cell -> its vertices (built lazily)
    const verticesOf = (cell: number) => {
      let v = vertCells.get(cell);
      if (v) return v;
      const set = new Set<number>();
      for (let t = triStart[cell]; t >= 0 && t < triStart[cell] + triCount[cell]; t++) for (let j = 0; j < 3; j++) set.add(index.getX(t * 3 + j));
      vertCells.set(cell, (v = [...set]));
      return v;
    };
    const ticks = h.years / h.step + 1;
    this.hist = h; this.worldRef = w; this.farmBy = []; this.near.clear();
    for (const st of h.settlements) {
      // Radius (in cells) reached by each year, as a running maximum: famines don't unplough land.
      const farmR = new Float32Array(ticks), urbR = new Float32Array(ticks);
      let fm = 0, um = 0;
      for (let t = 0; t < ticks; t++) {
        fm = Math.max(fm, farmRadius(st.pop[t])); um = Math.max(um, urbanRadius(st.pop[t]));
        farmR[t] = fm; urbR[t] = um;
      }
      this.farmBy.push(farmR);
      // Past the furthest reach, keep counting (as if growth went on) instead of jumping to
      // "never": the value then interpolates smoothly across triangles, so edges come out round
      // and the shader can roughen them, rather than following the mesh.
      const yearFor = (r: Float32Array, d: number) => {
        if (r[ticks - 1] < d) return h.years + (d - r[ticks - 1]) * 900;
        let lo = 0, hi = ticks - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (r[m] >= d) hi = m; else lo = m + 1; }
        return Math.max(st.founded, lo * h.step);
      };
      const reachCells = Math.ceil(fm) + 1;
      // Cells within reach, by rings.
      const seen = new Set([st.cell]);
      let ring = [st.cell];
      const cx = P[st.cell * 3], cy = P[st.cell * 3 + 1], cz = P[st.cell * 3 + 2];
      for (let r = 0; r <= reachCells; r++) {
        for (const cell of ring) {
          const farmable = arable(w, cell);
          let nl = this.near.get(cell);
          if (!nl) this.near.set(cell, (nl = []));
          nl.push(st.id);
          for (const v of verticesOf(cell)) {
            const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v), l = Math.hypot(x, y, z);
            const d = Math.acos(Math.min(1, (x * cx + y * cy + z * cz) / l)) / spacing;
            civ[v * 2] = Math.min(civ[v * 2], farmable ? yearFor(farmR, d) : h.years + 4000);
            civ[v * 2 + 1] = Math.min(civ[v * 2 + 1], yearFor(urbR, d));
          }
        }
        const next: number[] = [];
        for (const cell of ring) for (const n of g.neighbors[cell]) if (!seen.has(n)) { seen.add(n); next.push(n); }
        ring = next;
      }
    }
    geo.setAttribute('civ', new THREE.BufferAttribute(civ, 2));

    // --- Roads: ribbons along their routes, draped on the ground, growing from start to end. ---
    const rp: number[] = [], ry: number[] = [], ri: number[] = [];
    const halfW = spacing * 0.018, LIFT = 0.0004;
    for (const road of h.roads) {
      if (road.cells.length < 2) continue;
      // Corner-cut the cell-centre path (Chaikin), then sample it finely.
      let pts = road.cells.map((cell) => [P[cell * 3], P[cell * 3 + 1], P[cell * 3 + 2]]);
      for (let it = 0; it < 2; it++) {
        const out = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          out.push(p.map((v, k) => v * 0.75 + q[k] * 0.25), p.map((v, k) => v * 0.25 + q[k] * 0.75));
        }
        out.push(pts[pts.length - 1]);
        pts = out;
      }
      const dense: number[][] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / (spacing * 0.08)));
        for (let k = 0; k < steps; k++) dense.push(p.map((v, j) => v + (q[j] - v) * (k / steps)));
      }
      dense.push(pts[pts.length - 1]);
      const base = rp.length / 3;
      let cell = road.cells[0];
      for (let i = 0; i < dense.length; i++) {
        const [x, y, z] = dense[i], l = Math.hypot(x, y, z), ux = x / l, uy = y / l, uz = z / l;
        const p0 = dense[Math.max(0, i - 1)], p1 = dense[Math.min(dense.length - 1, i + 1)];
        let tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
        const tu = tx * ux + ty * uy + tz * uz; tx -= ux * tu; ty -= uy * tu; tz -= uz * tu;
        let sx = ty * uz - tz * uy, sy = tz * ux - tx * uz, sz = tx * uy - ty * ux;
        const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
        const year = road.year + (i / (dense.length - 1)) * road.years;
        for (const side of [1, -1]) {
          const ex = ux + sx * halfW * side, ey = uy + sy * halfW * side, ez = uz + sz * halfW * side;
          cell = cellOf(ex, ey, ez, cell);
          const r = groundAt(ex, ey, ez, cell) + LIFT, el = Math.hypot(ex, ey, ez);
          rp.push((ex / el) * r, (ey / el) * r, (ez / el) * r);
          ry.push(year);
        }
      }
      for (let i = 0; i < dense.length - 1; i++) {
        const k = base + i * 2;
        ri.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    if (ri.length) {
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
      rg.setAttribute('year', new THREE.Float32BufferAttribute(ry, 1));
      rg.setIndex(ri);
      rg.computeVertexNormals();
      this.roads = new THREE.Mesh(rg, this.roadMat);
      this.roads.renderOrder = 2;
      this.group.add(this.roads);
    }

    // --- Houses: scattered within each town's built-up radius, each rising when the town
    // first spread that far. ---
    const rng = makeRng(w.params.seed * 977 + 5);
    const hx: { x: number; y: number; z: number; birth: number; s: number; tone: number }[] = [];
    for (const st of h.settlements) {
      let um = 0;
      const urbR: number[] = [];
      for (let t = 0; t < ticks; t++) { um = Math.max(um, urbanRadius(st.pop[t])); urbR.push(um); }
      const count = Math.min(160, Math.round(14 + popAt(st, h.years) / 25));
      const cx = P[st.cell * 3], cy = P[st.cell * 3 + 1], cz = P[st.cell * 3 + 2];
      const cl = Math.hypot(cx, cy, cz);
      const tx0 = Math.abs(cy / cl) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      // Tangent frame at the town.
      let e1 = [tx0[1] * cz - tx0[2] * cy, tx0[2] * cx - tx0[0] * cz, tx0[0] * cy - tx0[1] * cx];
      const e1l = Math.hypot(e1[0], e1[1], e1[2]); e1 = e1.map((v) => v / e1l);
      const e2 = [cy * e1[2] - cz * e1[1], cz * e1[0] - cx * e1[2], cx * e1[1] - cy * e1[0]].map((v) => v / cl);
      let cell = st.cell;
      for (let i = 0; i < count; i++) {
        // Denser toward the middle; a few always stand at the very centre (the founding houses).
        const d = (i < 4 ? 0.15 : Math.sqrt(rng())) * Math.max(0.25, um) * spacing;
        const ang = rng() * Math.PI * 2;
        const x = cx / cl + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * d;
        const y = cy / cl + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * d;
        const z = cz / cl + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * d;
        const dCells = d / spacing;
        let t = urbR.findIndex((r) => r >= dCells);
        if (t < 0) t = i < 4 ? 0 : -1;
        if (t < 0) continue;
        const birth = Math.max(st.founded, t * h.step) + rng() * 30;
        cell = cellOf(x, y, z, cell);
        if (w.water[cell] !== 0) continue;
        const r = groundAt(x, y, z, cell), l = Math.hypot(x, y, z);
        hx.push({ x: (x / l) * r, y: (y / l) * r, z: (z / l) * r, birth, s: spacing * (0.014 + 0.01 * rng()), tone: rng() });
      }
    }
    if (hx.length) {
      const house = houseGeometry();
      const mesh = new THREE.InstancedMesh(house, this.houseMat, hx.length);
      const birth = new Float32Array(hx.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), spin = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      const n = new THREE.Vector3(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
      hx.forEach((o, i) => {
        n.set(o.x, o.y, o.z).normalize();
        q.setFromUnitVectors(up, n);
        spin.setFromAxisAngle(n, o.tone * 6.28);
        q.premultiply(spin);
        m.compose(p.set(o.x, o.y, o.z), q, sc.set(o.s, o.s * (0.8 + o.tone * 0.6), o.s));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.setHSL(0.08 + o.tone * 0.05, 0.25, 0.75 + o.tone * 0.15));
        birth[i] = o.birth;
      });
      house.setAttribute('birth', new THREE.InstancedBufferAttribute(birth, 1));
      mesh.frustumCulled = false;
      this.houses = mesh;
      this.group.add(mesh);
    }

    // --- Borders: for each century, the cell edges between different realms (or a realm and
    // unclaimed land), in the realm's colour. ---
    const bp: number[] = [], bc: number[] = [], bcol: number[] = [];
    const C = g.cornerPos, colour = new THREE.Color();
    h.territory.forEach((own, century) => {
      for (let cell = 0; cell < N; cell++) {
        const o = own[cell];
        if (o < 0) continue;
        g.neighbors[cell].forEach((nbr, i) => {
          const on = own[nbr];
          if (on === o || w.water[nbr] !== 0) return;     // same realm, or the coast
          if (on >= 0 && nbr < cell) return;               // between two realms: draw once
          const ks = g.corners[cell], k0 = ks[i], k1 = ks[(i + 1) % ks.length];
          const h0 = s.outlineH(cell, i) + 0.0012, h1 = s.outlineH(cell, (i + 1) % ks.length) + 0.0012;
          bp.push(C[k0 * 3] * h0, C[k0 * 3 + 1] * h0, C[k0 * 3 + 2] * h0, C[k1 * 3] * h1, C[k1 * 3 + 1] * h1, C[k1 * 3 + 2] * h1);
          bc.push(century, century);
          colour.setHex(h.realms[o].color);
          bcol.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
        });
      }
    });
    if (bp.length) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
      bg.setAttribute('century', new THREE.Float32BufferAttribute(bc, 1));
      bg.setAttribute('color', new THREE.Float32BufferAttribute(bcol, 3));
      this.borders = new THREE.LineSegments(bg, this.borderMat);
      this.borders.renderOrder = 8;
      this.borders.frustumCulled = false;
      this.group.add(this.borders);
    }
    if (this.roads) this.roads.frustumCulled = false;
  }

  /** Roads and houses read only from fairly close; borders on the map lens or while playing. */
  setVisibility(d: number, borders: boolean) {
    if (this.roads) this.roads.visible = d < 1.45;
    if (this.houses) this.houses.visible = d < 1.3;
    if (this.borders) this.borders.visible = borders;
  }
}

/** A small house: walls and a pitched roof, vertex-coloured (the instance colour tints it). */
function houseGeometry(): THREE.BufferGeometry {
  const walls = new THREE.BoxGeometry(1, 0.8, 0.8).translate(0, 0.4, 0).toNonIndexed();
  const roof = new THREE.ConeGeometry(0.78, 0.55, 4).rotateY(Math.PI / 4).scale(1, 1, 0.8).translate(0, 1.07, 0).toNonIndexed();
  const paint = (gm: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = gm.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    gm.setAttribute('color', new THREE.BufferAttribute(a, 3));
    gm.deleteAttribute('uv');
  };
  paint(walls, 0xffffff);
  paint(roof, 0xa0503a);
  const pos = [...walls.getAttribute('position').array, ...roof.getAttribute('position').array];
  const col = [...walls.getAttribute('color').array, ...roof.getAttribute('color').array];
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}
