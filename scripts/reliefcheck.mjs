// Checks relief.ts (the CPU port) against the planet's own EROSION_GLSL on the GPU at the same points.
// Usage (dev server running): node scripts/reliefcheck.mjs [base url]. Errors should be ~1e-7 or less.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const p = await browser.newPage();
await p.goto((process.argv[2] ?? 'http://localhost:5181/') + 'hex.html#seed=1&cell=5602');
await p.waitForTimeout(3000);
const r = await p.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { EROSION_GLSL } = await import('/src/erosion.ts');
  const { PATCH_BAKE_GLSL } = await import('/src/dunes.ts');
  // The crag functions, cut from the patch's bake shader as they stand.
  const grab = (sig) => { const a = PATCH_BAKE_GLSL.indexOf(sig); let d = 0, i = PATCH_BAKE_GLSL.indexOf('{', a); for (; i < PATCH_BAKE_GLSL.length; i++) { if (PATCH_BAKE_GLSL[i] === '{') d++; if (PATCH_BAKE_GLSL[i] === '}' && --d === 0) break; } return PATCH_BAKE_GLSL.slice(a, i + 1); };
  const CRAG = PATCH_BAKE_GLSL.match(/const float CRAG_INV[^;]*;/)[0] + grab('vec2 cragCells') + grab('float cragBlocks');
  const { NOISE_GLSL } = await import('/src/sky.ts');
  const R = await import('/src/relief.ts');
  const n = 32, pts = [];
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n * n; i++) {
    let x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1; const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    const h = rnd() * 0.01, mx = (rnd() - 0.5) * 0.4, my = (rnd() - 0.5) * 0.4, mz = (rnd() - 0.5) * 0.4;
    // macro tangent
    const d = mx * x + my * y + mz * z;
    pts.push([x, y, z, h, mx - d * x, my - d * y, mz - d * z]);
  }
  const A = new Float32Array(n * n * 4), B = new Float32Array(n * n * 4);
  pts.forEach((q, i) => { A.set([q[0], q[1], q[2], q[3]], i * 4); B.set([q[4], q[5], q[6], 0], i * 4); });
  const ta = new THREE.DataTexture(A, n, n, THREE.RGBAFormat, THREE.FloatType); ta.needsUpdate = true;
  const tb = new THREE.DataTexture(B, n, n, THREE.RGBAFormat, THREE.FloatType); tb.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    uniforms: { tA: { value: ta }, tB: { value: tb }, uErosion: { value: 1 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
    fragmentShader: NOISE_GLSL + EROSION_GLSL + CRAG + `
      uniform sampler2D tA, tB;
      void main() {
        ivec2 ij = ivec2(gl_FragCoord.xy);
        vec4 a = texelFetch(tA, ij, 0), b = texelFetch(tB, ij, 0);
        vec3 up = a.xyz, base = up * (1.0 + a.w);
        vec4 hl = hills(base, up, 0.6);
        Ero e = erosionSplit(base, up, b.xyz, 0.0, 1e-6);
        gl_FragColor = vec4(hl.x, hl.y, e.geoH, cragBlocks(base * 3.0));
      }`,
  });
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
  const renderer = new THREE.WebGLRenderer();
  const rt = new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType });
  renderer.setRenderTarget(rt); renderer.render(scene, new THREE.Camera());
  const out = new Float32Array(n * n * 4); renderer.readRenderTargetPixels(rt, 0, 0, n, n, out);
  const tmp = [0, 0, 0, 0];
  let eh = 0, eg = 0, ee = 0, mh = 0, me = 0, cb = 0, cbBad = 0;
  pts.forEach((q, i) => {
    const bx = q[0] * (1 + q[3]), by = q[1] * (1 + q[3]), bz = q[2] * (1 + q[3]);
    R.hills(bx, by, bz, q[0], q[1], q[2], 0.6, tmp);
    const geo = R.erosionGeoH(bx, by, bz, q[0], q[1], q[2], q[4], q[5], q[6], 1e-6);
    eh = Math.max(eh, Math.abs(tmp[0] - out[i * 4])); eg = Math.max(eg, Math.abs(tmp[1] - out[i * 4 + 1]));
    ee = Math.max(ee, Math.abs(geo - out[i * 4 + 2]));
    mh = Math.max(mh, Math.abs(out[i * 4])); me = Math.max(me, Math.abs(out[i * 4 + 2]));
    const c = R.cragBlocks(bx * 3, by * 3, bz * 3), dc = Math.abs(c - out[i * 4 + 3]);
    cb = Math.max(cb, dc); if (dc > 0.01) cbBad++;
  });
  // (Rock blocks are a cell pattern: a point on a cell wall can pick either side in float32, so
  // count how many differ rather than the worst.)
  return { hillsMaxErr: eh, hillsMax: mh, gradErr: eg, gullyMaxErr: ee, gullyMax: me, blocksOff: cbBad, blocksN: pts.length };
});
console.log(JSON.stringify(r));
await browser.close();
