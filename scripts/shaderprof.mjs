/**
 * Where the terrain shader's compile time goes. Takes the biggest programs the page built, then
 * times compiling each again (a fresh comment defeats the program cache), and again with one
 * function at a time stubbed out (its body replaced by a return of zero), to rank what costs most.
 *
 *   node scripts/shaderprof.mjs [top=3] [fn1,fn2,...]
 */
import { chromium } from 'playwright-core';
const top = Number(process.argv[2] ?? 3);
const fns = (process.argv[3] ?? '').split(',').filter(Boolean);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/#seed=77', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.view, null, { timeout: 240000, polling: 50 });
// No background compiles (they would compete with the timings).
await page.evaluate(() => { const v = window.mundi.view; v.compileOtherLook = async () => {}; v.compileMap = async () => {}; });
await page.waitForFunction(() => window.mundi?.view?.lowReady, null, { timeout: 400000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(async ({ top }) => {
  const r = window.mundi.view.renderer, gl = r.getContext();
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const progs = r.info.programs.map((p) => {
    const sh = gl.getAttachedShaders(p.program);
    const src = sh.map((s) => gl.getShaderSource(s));
    const ty = sh.map((s) => gl.getShaderParameter(s, gl.SHADER_TYPE));
    const vs = src[ty.indexOf(gl.VERTEX_SHADER)], fs = src[ty.indexOf(gl.FRAGMENT_SHADER)];
    return { name: p.name, key: p.cacheKey.slice(0, 40), vs, fs, len: fs.length };
  }).sort((a, b) => b.len - a.len).slice(0, top);
  const time = async (vs, fs) => {
    const tag = `\n// ${Math.random()}\n`;
    const t = performance.now();
    const v = gl.createShader(gl.VERTEX_SHADER), f = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(v, vs.replace('\n', tag)); gl.shaderSource(f, fs.replace('\n', tag));
    gl.compileShader(v); gl.compileShader(f);
    const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    while (ext && !gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) await new Promise((res) => setTimeout(res, 20));
    const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
    const ms = performance.now() - t;
    if (!ok) console.warn(gl.getShaderInfoLog(f)?.slice(0, 400), gl.getProgramInfoLog(p)?.slice(0, 400));
    gl.deleteProgram(p); gl.deleteShader(v); gl.deleteShader(f);
    return ok ? ms : -1;
  };
  // Replace the body of `<type> name(...) { ... }` with a return of zero of its type.
  const stub = (src, name) => {
    const re = new RegExp(`\\n\\s*(float|vec2|vec3|vec4|void)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    let m, s = src, n = 0;
    while ((m = re.exec(s))) {
      let i = m.index + m[0].length, d = 1;
      while (d && i < s.length) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
      const ty = m[1], ret = ty === 'void' ? '' : ty === 'float' ? 'return 0.0;' : `return ${ty}(0.0);`;
      s = s.slice(0, m.index + m[0].length) + ret + '}' + s.slice(i);
      re.lastIndex = m.index + m[0].length;
      n++;
    }
    return n ? s : null;
  };
  window.__prof = { progs, time, stub };
}, { top });
const n = await page.evaluate(() => window.__prof.progs.length);
for (let i = 0; i < n; i++) {
  const head = await page.evaluate(async (i) => { const { progs, time } = window.__prof, p = progs[i]; const b = Math.min(await time(p.vs, p.fs), await time(p.vs, p.fs)); return `${p.name} [${p.key}] fs ${(p.len / 1024).toFixed(0)} KB: ${b.toFixed(0)} ms`; }, i);
  console.log(head);
  for (const fn of fns) {
    const ms = await page.evaluate(async ([i, fn]) => {
      const { progs, time, stub } = window.__prof, p = progs[i];
      // Special cases: TRIVIAL_FS / TRIVIAL_VS replace one stage with a minimal one (same
      // interface: the main() body is emptied but the declarations stay).
      const empty = (src) => src.replace(/void\s+main\s*\(\s*\)\s*\{[\s\S]*\}\s*$/, 'void main() { gl_Position = vec4(0.0); }');
      if (fn === 'TRIVIAL_FS') return (await time(p.vs, p.fs.replace(/void\s+main\s*\(\s*\)\s*\{[\s\S]*\}\s*$/, 'void main() { pc_fragColor = vec4(1.0); }'))).toFixed(0);
      if (fn === 'TRIVIAL_VS') return (await time(empty(p.vs), p.fs)).toFixed(0);
      // DEFINE:NAME compiles the program with #define NAME (e.g. DEFINE:ORBIT, sky.ts).
      if (fn.startsWith('DEFINE:')) return (await time(p.vs, p.fs.replace(/\n/, `\n#define ${fn.slice(7)}\n`))).toFixed(0);
      // DYNLOOPS: every constant-bound loop's bound plus a uniform zero, so the compiler can't
      // unroll it. DYNLOOPS:24|27 only the loops with those bounds.
      if (fn.startsWith('DYNLOOPS')) {
        const only = fn.includes(':') ? fn.split(':')[1].split('|') : null;
        const fs = p.fs.replace(/for\s*\(\s*int\s+(\w+)\s*=\s*(-?\d+)\s*;\s*\1\s*(<=?)\s*([\w.]+)\s*;/g, (m, v, a, op, b) => {
          if (only && !only.includes(b)) return m;
          return `for (int ${v} = ${a}; ${v} ${op} (${b} + uDynZero);`;
        }).replace(/\n/, '\nuniform highp int uDynZero;\n');
        return (await time(p.vs, fs)).toFixed(0);
      }
      let fs = p.fs;
      for (const f of fn.split('+')) { fs = stub(fs, f); if (!fs) return null; }
      return (await time(p.vs, fs)).toFixed(0);
    }, [i, fn]);
    if (ms !== null) console.log(`    -${fn}: ${ms} ms`);
  }
}
await browser.close();
