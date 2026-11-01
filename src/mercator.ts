/**
 * The flat map: the same meshes and shaders as the globe, with each vertex placed by the
 * Mercator projection instead of in 3D. Everything the globe draws (terrain detail, snow,
 * water, rivers, clouds, seasons) comes along for free.
 *
 * A material opts in with the MERCATOR define. Built-in three.js materials are handled by
 * patching three's shader chunks once (below); the hand-written shaders include MERC_GLSL and
 * call mercVertex() themselves.
 *
 * Map space: x = longitude (radians), y = Mercator y, z = height above the sea (so higher
 * things are nearer the camera, which looks straight down from +z). The orthographic map
 * camera's x position is the longitude at the middle of the view; every vertex is placed
 * within ±π of it, so the map wraps round forever. The one seam is the meridian opposite the
 * middle of the view, at the left and right edges: triangles that straddle it would stretch
 * across the whole map, and fragments that know they are on one are thrown away.
 */
import * as THREE from 'three';

/** Mercator's usual cut-off, ±85.05°, where the map becomes square. */
export const MERC_MAX_LAT = 1.4844222;
export const MERC_MAX_Y = Math.PI;

export const MERC_GLSL = /* glsl */`
#ifdef MERCATOR
  varying float vMercRel;
  varying vec2 vMercDir;
  vec3 mercPos(vec3 p) {
    float r = length(p);
    float rel = mod(atan(p.x, p.z) - cameraPosition.x + 3.14159265, 6.2831853) - 3.14159265;
    float lat = clamp(asin(clamp(p.y / r, -1.0, 1.0)), -${MERC_MAX_LAT}, ${MERC_MAX_LAT});
    return vec3(cameraPosition.x + rel, log(tan(0.78539816 + lat * 0.5)), r - 1.0);
  }
  /** World vector -> map space (east, north, up) at world point p. */
  mat3 mercFrame(vec3 p) {
    vec3 up = normalize(p);
    vec3 e = vec3(p.z, 0.0, -p.x);
    vec3 east = length(e) > 1e-6 ? normalize(e) : vec3(1.0, 0.0, 0.0);
    vec3 north = cross(up, east);
    return transpose(mat3(east, north, up));
  }
#endif
`;

/** Vertex: place world point `w` (a vec3 expression) on the map, writing gl_Position. */
export const mercVertex = (w: string) => /* glsl */`
  {
    vec3 mp = mercPos(${w});
    vMercRel = mp.x - cameraPosition.x;
    vMercDir = vec2(sin(vMercRel), cos(vMercRel));
    gl_Position = projectionMatrix * viewMatrix * vec4(mp, 1.0);
  }`;

/** Fragment: drop fragments of triangles stretched across the seam. Interpolated longitude
 * and interpolated direction agree everywhere except on those. */
export const MERC_DISCARD = /* glsl */`
#ifdef MERCATOR
  if (abs(atan(vMercDir.x, vMercDir.y) - vMercRel) > 0.5) discard;
#endif
`;

let patched = false;
/** Teach three's built-in materials the MERCATOR define. Idempotent. */
export function patchShaderChunks() {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.common += MERC_GLSL;
  C.project_vertex += /* glsl */`
#ifdef MERCATOR
  {
    vec4 mwp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      mwp = instanceMatrix * mwp;
    #endif
    mwp = modelMatrix * mwp;
    vec3 mp = mercPos(mwp.xyz);
    vMercRel = mp.x - cameraPosition.x;
    vMercDir = vec2(sin(vMercRel), cos(vMercRel));
    mvPosition = viewMatrix * vec4(mp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
#endif
`;
  // The map camera looks straight down with no rotation, so view space is map space: a normal
  // becomes (east, north, up) components at its point.
  C.defaultnormal_vertex += /* glsl */`
#ifdef MERCATOR
  transformedNormal = mercFrame((modelMatrix * vec4(position, 1.0)).xyz) * normalize(mat3(modelMatrix) * objectNormal);
#endif
`;
  C.clipping_planes_fragment = MERC_DISCARD + C.clipping_planes_fragment;
}

/** Turn the MERCATOR define on or off for every material under `root`. */
export function setMercator(root: THREE.Object3D, on: boolean) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      const d = ((mat as THREE.ShaderMaterial).defines ??= {});
      if (on === ('MERCATOR' in d)) continue;
      if (on) d.MERCATOR = ''; else delete d.MERCATOR;
      mat.needsUpdate = true;
    }
    if (on) o.frustumCulled = false;
  });
}

/** Map y for a latitude in radians, and back. */
export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) / 2));
export const mercLat = (y: number) => 2 * Math.atan(Math.exp(y)) - Math.PI / 2;
