/**
 * Hex grid on a sphere: a subdivided icosahedron, then its dual (a Goldberg polyhedron).
 *
 * Every icosphere vertex becomes a cell; every icosphere triangle becomes a corner shared by
 * three cells. The 12 original icosahedron vertices have five neighbours, so the grid always
 * has exactly 12 pentagons and 10n² − 10 hexagons. There is no way to tile a sphere with
 * hexagons alone.
 */
export interface Grid {
  count: number;
  /** xyz per cell, unit length. */
  centers: Float32Array;
  /** xyz per corner, unit length. */
  cornerPos: Float32Array;
  /** Per cell: corner ids, counter-clockwise seen from outside. */
  corners: Int32Array[];
  /** Per cell: neighbors[c][k] lies across the edge corners[c][k] → corners[c][k+1]. */
  neighbors: Int32Array[];
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/** n = subdivision frequency. Cells = 10n² + 2. */
export function buildGrid(n: number): Grid {
  const verts: number[] = [];
  const lookup = new Map<string, number>();
  const vertexId = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      lookup.set(key, id);
    }
    return id;
  };

  const tris: number[] = [];
  const addTri = (a: number, b: number, c: number) => {
    // Keep every triangle wound counter-clockwise from outside.
    const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
    const ux = verts[b * 3] - ax, uy = verts[b * 3 + 1] - ay, uz = verts[b * 3 + 2] - az;
    const vx = verts[c * 3] - ax, vy = verts[c * 3 + 1] - ay, vz = verts[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * ax + ny * ay + nz * az < 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  };

  for (const [ia, ib, ic] of ICO_F) {
    const A = ICO_V[ia], B = ICO_V[ib], C = ICO_V[ic];
    const row: number[][] = [];
    for (let i = 0; i <= n; i++) {
      row[i] = [];
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        row[i][j] = vertexId(
          A[0] + (B[0] - A[0]) * u + (C[0] - A[0]) * v,
          A[1] + (B[1] - A[1]) * u + (C[1] - A[1]) * v,
          A[2] + (B[2] - A[2]) * u + (C[2] - A[2]) * v,
        );
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        addTri(row[i][j], row[i + 1][j], row[i][j + 1]);
        if (i + j < n - 1) addTri(row[i + 1][j], row[i + 1][j + 1], row[i][j + 1]);
      }
    }
  }

  const count = verts.length / 3;
  const triCount = tris.length / 3;
  const centers = new Float32Array(verts);

  const cornerPos = new Float32Array(triCount * 3);
  const incident: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < triCount; t++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      x += verts[v * 3]; y += verts[v * 3 + 1]; z += verts[v * 3 + 2];
      incident[v].push(t);
    }
    const l = Math.hypot(x, y, z);
    cornerPos[t * 3] = x / l; cornerPos[t * 3 + 1] = y / l; cornerPos[t * 3 + 2] = z / l;
  }

  const corners: Int32Array[] = [];
  const neighbors: Int32Array[] = [];
  for (let c = 0; c < count; c++) {
    const px = verts[c * 3], py = verts[c * 3 + 1], pz = verts[c * 3 + 2];
    // Tangent basis (u, w) at the cell centre; increasing angle is counter-clockwise from outside.
    let ux: number, uy: number, uz: number;
    if (Math.abs(px) < 0.9) { ux = 0; uy = -pz; uz = py; } else { ux = pz; uy = 0; uz = -px; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = py * uz - pz * uy, wy = pz * ux - px * uz, wz = px * uy - py * ux;

    const ts = incident[c];
    const angle = new Map<number, number>();
    for (const t of ts) {
      const dx = cornerPos[t * 3] - px, dy = cornerPos[t * 3 + 1] - py, dz = cornerPos[t * 3 + 2] - pz;
      angle.set(t, Math.atan2(dx * wx + dy * wy + dz * wz, dx * ux + dy * uy + dz * uz));
    }
    ts.sort((a, b) => angle.get(a)! - angle.get(b)!);

    const m = ts.length;
    const nb = new Int32Array(m);
    for (let k = 0; k < m; k++) {
      const ta = ts[k], tb = ts[(k + 1) % m];
      let shared = -1;
      for (let i = 0; i < 3; i++) {
        const v = tris[ta * 3 + i];
        if (v === c) continue;
        if (tris[tb * 3] === v || tris[tb * 3 + 1] === v || tris[tb * 3 + 2] === v) shared = v;
      }
      nb[k] = shared;
    }
    corners.push(Int32Array.from(ts));
    neighbors.push(nb);
  }

  return { count, centers, cornerPos, corners, neighbors };
}
