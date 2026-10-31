import { PlanetView, DEFAULT_VIEW, REBUILD_KEYS, type ViewMode, type TerrainStyle, type ViewOptions } from './render.ts';
import { DEFAULT_PARAMS, WATER_OCEAN, WATER_LAKE, type World, type WorldParams } from './world.ts';
import { BIOMES } from './biomes.ts';
import { flyTo, orbit, type Spot } from './debug.ts';
import type { BuildRequest, BuildResult } from './worker.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = new PlanetView($('view'));
let params: WorldParams = { ...DEFAULT_PARAMS, seed: Math.floor(Math.random() * 1e6) };
let viewOpts: ViewOptions = { ...DEFAULT_VIEW };
let world: World;
let timings = { gen: 0, mesh: 0, clouds: 0 };

// --- Worker: generation and meshing happen off the main thread. At most one request is in
// flight; changes made meanwhile collapse into a single follow-up, and only the latest result
// is drawn. So dragging a slider never queues up a backlog of stale worlds. ---
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 0, inFlight = false, queued = false, cloudSeed = -1;
let waiters: (() => void)[] = [];

function request(): Promise<void> {
  queued = true;
  pump();
  return new Promise((resolve) => waiters.push(resolve));
}

function pump() {
  if (inFlight || !queued) return;
  queued = false;
  inFlight = true;
  const clouds = params.seed !== cloudSeed;
  cloudSeed = params.seed;
  const { mode, style, relief, blend, trees } = viewOpts;
  const msg: BuildRequest = { id: ++nextId, params: { ...params }, opts: { mode, style, relief, blend, trees }, clouds };
  worker.postMessage(msg);
  $('panel').classList.add('busy');
}

worker.onmessage = (e: MessageEvent<BuildResult>) => {
  const r = e.data;
  inFlight = false;
  if (r.world) world = r.world;
  if (r.clouds) view.setClouds(r.clouds);
  if (!queued) {
    view.setData(world, r.surface);
    timings = r.timings;
    showStats();
    writeHash();
    $('panel').classList.remove('busy');
    const done = waiters;
    waiters = [];
    for (const f of done) f();
  }
  pump();
};
worker.onerror = (e) => {
  console.error('worker failed:', e.message);
  inFlight = false;
  $('panel').classList.remove('busy');
};

function showStats() {
  let ocean = 0, lakes = 0, rivers = 0;
  for (let c = 0; c < world.grid.count; c++) {
    if (world.water[c] === WATER_OCEAN) ocean++;
    else if (world.water[c] === WATER_LAKE) lakes++;
    if (world.river[c]) rivers++;
  }
  $('stats').textContent =
    `${world.grid.count.toLocaleString()} cells · ${Math.round((1 - ocean / world.grid.count) * 100)}% land · ` +
    `${lakes} lake · ${rivers} river cells · gen ${timings.gen} ms, mesh ${timings.mesh} ms`;
}

/** View options: visibility toggles apply at once; mesh options go through the worker. */
function setView(o: Partial<ViewOptions>): Promise<void> | void {
  const rebuild = REBUILD_KEYS.some((k) => o[k] !== undefined && o[k] !== viewOpts[k]);
  viewOpts = { ...viewOpts, ...o };
  view.setOptions(viewOpts);
  if (rebuild) return request();
}

// --- Parameters live in the URL hash, so a world can be shared as a link. ---
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = h.get(k);
    if (v !== null && v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  const r = h.get('relief');
  if (r) viewOpts.relief = Number(r);
}
function writeHash() {
  const h = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) h.set(k, String(v));
  h.set('relief', String(viewOpts.relief));
  history.replaceState(null, '', '#' + h.toString());
}

const sliders: [keyof WorldParams | 'relief', (v: number) => string][] = [
  ['detail', (v) => (10 * v * v + 2).toLocaleString()],
  ['ocean', (v) => `${Math.round(v * 100)}%`],
  ['plates', (v) => String(v)],
  ['continents', (v) => String(v)],
  ['roughness', (v) => v.toFixed(2)],
  ['heat', (v) => (v > 0 ? '+' : '') + v.toFixed(2)],
  ['wetness', (v) => (v > 0 ? '+' : '') + v.toFixed(2)],
  ['rivers', (v) => `×${v.toFixed(2)}`],
  ['relief', (v) => `×${v.toFixed(2)}`],
];

function syncInputs() {
  $<HTMLInputElement>('seed').value = String(params.seed);
  for (const [k, fmt] of sliders) {
    const v = k === 'relief' ? viewOpts.relief : params[k];
    $<HTMLInputElement>(k).value = String(v);
    $<HTMLOutputElement>(`${k}-out`).textContent = fmt(v);
  }
  $<HTMLSelectElement>('mode').value = viewOpts.mode;
  $<HTMLSelectElement>('style').value = viewOpts.style;
  for (const [id, key] of [['grid', 'grid'], ['show-rivers', 'rivers'], ['trees', 'trees'], ['clouds', 'clouds'], ['blend', 'blend']] as const) {
    $<HTMLInputElement>(id).checked = viewOpts[key];
  }
}

for (const [k, fmt] of sliders) {
  const input = $<HTMLInputElement>(k);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    $<HTMLOutputElement>(`${k}-out`).textContent = fmt(v);
    if (k === 'relief') { setView({ relief: v }); return; }
    params[k] = v;
    request();
  });
}
$<HTMLInputElement>('seed').addEventListener('change', (e) => {
  params.seed = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
  request();
});
$('dice').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 1e6);
  syncInputs();
  request();
});
const onSelect = (id: string, f: (v: string) => Partial<ViewOptions>) =>
  $<HTMLSelectElement>(id).addEventListener('change', (e) => setView(f((e.target as HTMLSelectElement).value)));
const onCheck = (id: string, f: (v: boolean) => Partial<ViewOptions>) =>
  $<HTMLInputElement>(id).addEventListener('change', (e) => setView(f((e.target as HTMLInputElement).checked)));
onSelect('mode', (v) => ({ mode: v as ViewMode }));
onSelect('style', (v) => ({ style: v as TerrainStyle }));
onCheck('trees', (v) => ({ trees: v }));
onCheck('clouds', (v) => ({ clouds: v }));
onCheck('grid', (v) => ({ grid: v }));
onCheck('show-rivers', (v) => ({ rivers: v }));
onCheck('blend', (v) => ({ blend: v }));
$('collapse').addEventListener('click', () => {
  const p = $('panel');
  p.classList.toggle('collapsed');
  $('collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
});

// --- Hover readout ---
const info = $('info');
let lastCell = -1;
view.renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || !world) { info.hidden = true; return; }
  const c = view.pick(e.clientX, e.clientY);
  if (c !== lastCell) { view.highlight(c); lastCell = c; }
  if (c < 0) { info.hidden = true; return; }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const y = world.grid.centers[c * 3 + 1];
  const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
  info.innerHTML =
    `<b>${BIOMES[world.biome[c]].name}</b>${world.river[c] ? ' · river' : ''}<br>` +
    `<span>elev</span> ${world.elevation[c].toFixed(2)} <span>temp</span> ${pct(world.temperature[c])} ` +
    `<span>wet</span> ${pct(world.moisture[c])}<br><span>lat</span> ${lat.toFixed(0)}° <span>cell</span> ${c} ` +
    `<span>plate</span> ${world.plate[c]}`;
  info.style.left = `${e.clientX}px`;
  info.style.top = `${e.clientY}px`;
  info.hidden = false;
});
view.renderer.domElement.addEventListener('pointerleave', () => { info.hidden = true; view.highlight(-1); lastCell = -1; });

// --- Debug handle for the console, scripts/shot.mjs and scripts/visual.mjs ---
(window as unknown as Record<string, unknown>).worldgen = {
  view,
  get world() { return world; },
  get timings() { return timings; },
  /** Hide the UI for clean screenshots. */
  capture: (on: boolean) => document.body.classList.toggle('capture', on),
  /** Stop animation at time t (null resumes), so renders repeat exactly. */
  freeze: (t: number | null) => view.freeze(t),
  orbit: (lon: number, lat: number, dist: number) => orbit(view, lon, lat, dist),
  flyTo: (spot: Spot, alt: number) => flyTo(view, world, spot, alt),
  /** Swap in a world from a hash string ("seed=7&ocean=0.5") with view options reset; resolves once drawn. */
  load: (hash: string, opts: Partial<ViewOptions> = {}): Promise<void> => {
    history.replaceState(null, '', '#' + hash);
    params = { ...DEFAULT_PARAMS };
    viewOpts = { ...DEFAULT_VIEW };
    readHash();
    viewOpts = { ...viewOpts, ...opts };
    syncInputs();
    view.setOptions(viewOpts);
    return request();
  },
  /** Resolves once the current request (if any) has been drawn. */
  ready: (): Promise<void> => (inFlight || queued ? new Promise((r) => waiters.push(r)) : Promise.resolve()),
};

readHash();
syncInputs();
view.setOptions(viewOpts);
request();
