/**
 * Exact ground height under any direction, from the terrain mesh itself: a ray from the
 * planet's centre against the triangles of the cell there (and its neighbours). Things drawn
 * on the ground (rivers, grid lines, roads, houses) use it so they sit on the surface as drawn,
 * rather than on the cell-centre heights the mesh was smoothed and roughened away from.
 */
import * as THREE from 'three';
import type { Grid } from './grid.ts';

export class GroundProbe {
  private triStart: Int32Array;
  private triCount: Int32Array;
  private a = new THREE.Vector3(); private b = new THREE.Vector3(); private c = new THREE.Vector3();
  private ray = new THREE.Ray(); private hit = new THREE.Vector3();
  private hint = 0;

  private grid: Grid;
  private pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  private index: THREE.BufferAttribute;

  constructor(grid: Grid, pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: THREE.BufferAttribute, faces: Int32Array) {
    this.grid = grid; this.pos = pos; this.index = index;
    const N = grid.count;
    this.triStart = new Int32Array(N).fill(-1);
    this.triCount = new Int32Array(N);
    faces.forEach((cell, t) => { if (this.triStart[cell] < 0) this.triStart[cell] = t; this.triCount[cell]++; });
  }

  static fromMesh(grid: Grid, mesh: THREE.Mesh, faces: Int32Array) {
    const g = mesh.geometry;
    return new GroundProbe(grid, g.getAttribute('position'), g.getIndex()!, faces);
  }

  /** The cell whose centre is nearest a direction, walking from `near` (or the last answer). */
  cellOf(x: number, y: number, z: number, near = this.hint): number {
    const P = this.grid.centers, nb = this.grid.neighbors;
    let cur = near;
    for (;;) {
      let best = cur, bd = P[cur * 3] * x + P[cur * 3 + 1] * y + P[cur * 3 + 2] * z;
      for (const n of nb[cur]) {
        const d = P[n * 3] * x + P[n * 3 + 1] * y + P[n * 3 + 2] * z;
        if (d > bd) { bd = d; best = n; }
      }
      if (best === cur) return (this.hint = cur);
      cur = best;
    }
  }

  /** Ground radius along a direction (any length), or `fallback` if no triangle is hit. */
  heightAt(x: number, y: number, z: number, fallback = 1, cell = -1): number {
    const c0 = cell >= 0 ? cell : this.cellOf(x, y, z);
    const { a, b, c, ray, hit, pos, index } = this;
    ray.origin.set(0, 0, 0);
    ray.direction.set(x, y, z).normalize();
    for (const k of [c0, ...this.grid.neighbors[c0]]) {
      const s = this.triStart[k];
      if (s < 0) continue;
      for (let t = s; t < s + this.triCount[k]; t++) {
        a.fromBufferAttribute(pos, index.getX(t * 3));
        b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
        c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
        if (ray.intersectTriangle(a, b, c, false, hit)) return hit.length();
      }
    }
    return fallback;
  }
}
