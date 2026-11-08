/**
 * The depth layer on the planet (Bill, 2026-11-08: "Let's have depths be visible"): revealed land
 * tinted by band, Settled faint green to Deep red, a translucent shell over the ground. Fogged
 * hexes stay untinted (the storm hides them anyway). Toggled from the bar. A tint at sea level
 * drawn over the ground, so on high mountains it sits a little off its hex, seen from the side.
 */
import * as THREE from 'three';
import type { World } from '../world.ts';
import type { Atlas } from './atlas.ts';
import { bandOfHexes, BANDS, depthMap } from './depth.ts';
import { FOG_H, FOG_W, type PlanetFog } from './fog.ts';
import { SEA } from '../surface.ts';

export class DepthLayer {
  readonly mesh: THREE.Mesh;
  private data = new Uint8Array(FOG_W * FOG_H * 4);
  private tex: THREE.DataTexture;
  private band: Uint8Array;
  private seen: Uint8Array;

  private fog: PlanetFog;

  constructor(world: World, atlas: Atlas, fog: PlanetFog) {
    this.fog = fog;
    const d = depthMap(world, atlas), N = world.grid.count;
    this.band = new Uint8Array(N);
    for (let c = 0; c < N; c++) this.band[c] = world.water[c] !== 0 ? 255 : bandOfHexes(d[c]);
    this.seen = new Uint8Array(N);
    this.tex = new THREE.DataTexture(this.data, FOG_W, FOG_H, THREE.RGBAFormat);
    this.tex.wrapS = THREE.RepeatWrapping;
    // The fog's texels run from longitude −π at x = sin(lon), z = cos(lon); a sphere's u starts a
    // quarter turn round from that.
    this.tex.offset.set(0.25, 0);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
    // Just over the sea, drawn over the ground (no depth test), under the fog: the camera flies
    // low over the land, so a shell up at the fog's top would be behind it.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SEA + 0.0008, 192, 96), mat);
    this.mesh.renderOrder = 19;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'primundi-depth';
  }

  /** These hexes are seen now: tint them. */
  reveal(cells: Iterable<number>) {
    let any = false;
    for (const c of cells) if (!this.seen[c]) { this.seen[c] = 1; any = true; }
    if (any) this.fill();
  }

  private fill() {
    const pc = this.fog.texelCells, d = this.data, b = this.band, seen = this.seen;
    for (let p = 0; p < pc.length; p++) {
      const c = pc[p], k = b[c];
      if (!seen[c] || k === 255) { d[p * 4 + 3] = 0; continue; }
      const t = BANDS[k].tint;
      d[p * 4] = t[0]; d[p * 4 + 1] = t[1]; d[p * 4 + 2] = t[2]; d[p * 4 + 3] = k === 0 ? 45 : 110;
    }
    this.tex.needsUpdate = true;
  }

  set visible(v: boolean) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
}
