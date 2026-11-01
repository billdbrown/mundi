import { PlanetView, DEFAULT_VIEW, REBUILD_KEYS, type ViewMode, type TerrainStyle, type ViewOptions } from './render.ts';
import { DEFAULT_PARAMS, WATER_OCEAN, WATER_LAKE, type World, type WorldParams } from './world.ts';
import { BIOMES } from './biomes.ts';
import { flyTo, orbit, type Spot } from './debug.ts';
import type { BuildRequest, BuildResult, BuildStage } from './worker.ts';
import { mountLoader, type Loader } from './loader.ts';
import type { HistoryRequest, HistoryResult } from './historyWorker.ts';
import type { History } from './civ.ts';
import { gameData, exportJSON, RESOURCE_NAMES, type GameData } from './gamedata.ts';
import { kindLabel, kindOf, mountShell, planetName, PRESETS, type Lens } from './shell.ts';
import { nameSeed, parseSeed, randomName } from './seedname.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = new PlanetView($('view'));
/** The planet's name, which is also its seed in the URL. Null for a world given by number. */
let worldName: string | null = randomName();
let params: WorldParams = { ...DEFAULT_PARAMS, seed: nameSeed(worldName) };
/** A new named world, optionally with other settings. */
function newWorld(p: Partial<WorldParams> = {}) {
  worldName = randomName();
  params = { ...params, ...p, seed: nameSeed(worldName) };
}
const displayName = () => worldName ?? planetName(params.seed);
let viewOpts: ViewOptions = { ...DEFAULT_VIEW };
let world: World;
let timings = { gen: 0, mesh: 0, clouds: 0 };
/** Display only: what the planet's radius means in km, for the scale bar and readouts. */
let radiusKm = 6371;
let game: GameData | null = null;
/** Site name per cell, for the hover readout. */
let siteAt = new Map<number, string>();
let lens: Lens = 'earth';
const drawnListeners: (() => void)[] = [];

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

/** The loading screen, until the first world is on screen. */
let loader: Loader | null = null;
/** Resolves once the loading screen has gone (at once if there never was one). */
let loaderGone: Promise<void> = Promise.resolve();

worker.onmessage = (e: MessageEvent<BuildResult | BuildStage>) => {
  if ('stage' in e.data) { loader?.step(e.data.stage); return; }
  const r = e.data;
  inFlight = false;
  if (r.world) {
    world = r.world;
    game = gameData(world);
    siteAt = new Map(game.sites.map((s) => [s.cell, s.name]));
  }
  if (r.clouds) view.setClouds(r.clouds);
  if (!queued) {
    view.setData(world, r.surface);
    if (r.world && game) view.setSites(game.sites.map((s) => s.cell));
    timings = r.timings;
    showStats();
    writeHash();
    $('panel').classList.remove('busy');
    for (const f of drawnListeners) f();
    if (loader) {
      // Hold the screen through the first frame, which is when the shaders compile.
      const l = loader;
      loader = null;
      l.step('light');
      requestAnimationFrame(() => requestAnimationFrame(() => { void l.finish(); }));
    }
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

// --- Centuries: histories are simulated in their own worker (about a second), once per world. ---
let historyWorker: Worker | null = null;
let historyKey = '', historyPromise: Promise<History> | null = null, historyId = 0;
function loadHistory(): Promise<History> {
  const key = JSON.stringify(params);
  if (historyPromise && key === historyKey) return historyPromise;
  historyKey = key;
  historyWorker ??= new Worker(new URL('./historyWorker.ts', import.meta.url), { type: 'module' });
  const id = ++historyId, w = historyWorker;
  historyPromise = new Promise((resolve) => {
    const on = (e: MessageEvent<HistoryResult>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', on);
      resolve(e.data.history);
    };
    w.addEventListener('message', on);
    w.postMessage({ id, params: { ...params } } satisfies HistoryRequest);
  });
  return historyPromise;
}

function showStats() {
  let ocean = 0, lakes = 0, rivers = 0;
  for (let c = 0; c < world.grid.count; c++) {
    if (world.water[c] === WATER_OCEAN) ocean++;
    else if (world.water[c] === WATER_LAKE) lakes++;
    if (world.river[c]) rivers++;
  }
  $('stats').textContent =
    `${world.grid.count.toLocaleString()} cells · ${Math.round((1 - ocean / world.grid.count) * 100)}% land · ` +
    `${lakes} lake · ${rivers} river cells · a cell ≈ ${Math.round(Math.sqrt((4 * Math.PI) / world.grid.count) * radiusKm)} km · ` +
    `gen ${timings.gen} ms, mesh ${timings.mesh} ms`;
}

/** View options: visibility toggles apply at once; mesh options go through the worker. */
function setView(o: Partial<ViewOptions>): Promise<void> | void {
  const rebuild = REBUILD_KEYS.some((k) => o[k] !== undefined && o[k] !== viewOpts[k]);
  viewOpts = { ...viewOpts, ...o };
  view.setOptions(viewOpts);
  if (rebuild) return request();
}

// --- The world lives in the URL hash, so it can be shared as a link. Kept short: an ordinary
// world is just #seed=zalund; a kind from the New world menu adds &kind=archipelago; a custom
// world lists only the settings that differ from the defaults. ---
const SETTINGS = (Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]).filter((k) => k !== 'seed');
const DEFAULT_LENS: Lens = 'earth', DEFAULT_RADIUS = 6371;
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const s = parseSeed(h.get('seed') ?? '');
  if (s) { worldName = s.name; params.seed = s.seed; }
  const kind = PRESETS.find((p) => p.id === h.get('kind'));
  if (kind) params = { ...params, ...kind.p };
  for (const k of SETTINGS) {
    const v = h.get(k);
    if (v !== null && v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  const r = h.get('relief');
  if (r) viewOpts.relief = Number(r);
  const km = Number(h.get('radius'));
  if (km > 0) radiusKm = km;
  const l = h.get('lens');
  if (l) lens = l as Lens;
}
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
function writeHash() {
  const h = new URLSearchParams();
  h.set('seed', worldName ? worldName.toLowerCase() : String(params.seed));
  if (SETTINGS.some((k) => !same(params[k], DEFAULT_PARAMS[k]))) {
    // Earthlike is the defaults; any other kind is named rather than spelled out.
    const kind = kindOf(params);
    if (kind) h.set('kind', kind.id);
    else for (const k of SETTINGS) if (!same(params[k], DEFAULT_PARAMS[k])) h.set(k, String(+params[k].toFixed(4)));
  }
  if (!same(viewOpts.relief, DEFAULT_VIEW.relief)) h.set('relief', String(viewOpts.relief));
  if (radiusKm !== DEFAULT_RADIUS) h.set('radius', String(radiusKm));
  if (lens !== DEFAULT_LENS) h.set('lens', lens);
  history.replaceState(null, '', location.search + '#' + h.toString());
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
  $<HTMLInputElement>('seed').value = worldName ?? String(params.seed);
  $<HTMLInputElement>('radius').value = String(radiusKm);
  $<HTMLOutputElement>('radius-out').textContent = `${radiusKm.toLocaleString()} km`;
  for (const [k, fmt] of sliders) {
    const v = k === 'relief' ? viewOpts.relief : params[k];
    $<HTMLInputElement>(k).value = String(v);
    $<HTMLOutputElement>(`${k}-out`).textContent = fmt(v);
  }
  $<HTMLSelectElement>('mode').value = viewOpts.mode;
  $<HTMLSelectElement>('style').value = viewOpts.style;
  $<HTMLSelectElement>('light').value = viewOpts.light;
  $<HTMLSelectElement>('look').value = viewOpts.look;
  for (const [id, key] of [['grid', 'grid'], ['show-rivers', 'rivers'], ['trees', 'trees'], ['clouds', 'clouds'], ['blend', 'blend'], ['sites', 'sites']] as const) {
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
  const s = parseSeed((e.target as HTMLInputElement).value);
  if (s) { worldName = s.name; params.seed = s.seed; }
  syncInputs();
  if (s) request();
});
$('dice').addEventListener('click', () => {
  newWorld();
  syncInputs();
  request();
});
const onSelect = (id: string, f: (v: string) => Partial<ViewOptions>) =>
  $<HTMLSelectElement>(id).addEventListener('change', (e) => setView(f((e.target as HTMLSelectElement).value)));
const onCheck = (id: string, f: (v: boolean) => Partial<ViewOptions>) =>
  $<HTMLInputElement>(id).addEventListener('change', (e) => setView(f((e.target as HTMLInputElement).checked)));
onSelect('mode', (v) => ({ mode: v as ViewMode }));
onSelect('style', (v) => ({ style: v as TerrainStyle }));
onSelect('light', (v) => ({ light: v as ViewOptions['light'] }));
onSelect('look', (v) => ({ look: v as ViewOptions['look'] }));
onCheck('trees', (v) => ({ trees: v }));
onCheck('clouds', (v) => ({ clouds: v }));
onCheck('grid', (v) => ({ grid: v }));
onCheck('show-rivers', (v) => ({ rivers: v }));
onCheck('blend', (v) => ({ blend: v }));
onCheck('sites', (v) => ({ sites: v }));
$('export').addEventListener('click', () => {
  if (!world || !game) return;
  const blob = new Blob([exportJSON(world, game)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mundi-${(worldName ?? String(params.seed)).toLowerCase()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$<HTMLInputElement>('radius').addEventListener('input', (e) => {
  radiusKm = Number((e.target as HTMLInputElement).value);
  $<HTMLOutputElement>('radius-out').textContent = `${radiusKm.toLocaleString()} km`;
  if (world) showStats();
  writeHash();
});

// --- Scale bar: a round distance about 120 px long, measured at the centre of the view. ---
const scaleBar = $('scale-bar'), scaleLabel = $('scale-label');
let lastScale = '';
function updateScale() {
  const kmPerPx = radiusKm * view.groundPerPx();       // globe or flat map
  const raw = kmPerPx * 120, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [5, 2, 1].map((m) => m * mag).find((v) => v <= raw) ?? mag;
  const label = nice >= 1 ? `${nice.toLocaleString()} km` : `${Math.round(nice * 1000)} m`;
  const key = `${label}:${Math.round(nice / kmPerPx)}`;
  if (key !== lastScale) {
    scaleBar.style.width = `${Math.round(nice / kmPerPx)}px`;
    scaleLabel.textContent = label;
    lastScale = key;
  }
  requestAnimationFrame(updateScale);
}
requestAnimationFrame(updateScale);

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
    (siteAt.has(c) ? `<b>⌂ ${siteAt.get(c)}</b><br>` : '') +
    `<b>${BIOMES[world.biome[c]].name}</b>${world.river[c] ? ' · river' : ''}` +
    (game && game.continent[c] >= 0 ? ` <span>on</span> ${game.continents[game.continent[c]].name}` : '') + '<br>' +
    (game && game.resources[c] ? `<span>resources</span> ${RESOURCE_NAMES.filter(([b]) => game!.resources[c] & b).map(([, n]) => n).join(', ')}<br>` : '') +
    `<span>elev</span> ${world.elevation[c].toFixed(2)} <span>temp</span> ${pct(world.temperature[c])} ` +
    `<span>wet</span> ${pct(world.moisture[c])}<br><span>lat</span> ${lat.toFixed(0)}° <span>cell</span> ${c} ` +
    `<span>plate</span> ${world.plate[c]}`;
  info.style.left = `${e.clientX}px`;
  info.style.top = `${e.clientY}px`;
  info.hidden = false;
});
view.renderer.domElement.addEventListener('pointerleave', () => { info.hidden = true; view.highlight(-1); lastCell = -1; });

// --- Debug handle for the console, scripts/shot.mjs and scripts/visual.mjs ---
(window as unknown as Record<string, unknown>).mundi = {
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
    worldName = null;
    viewOpts = { ...DEFAULT_VIEW };
    readHash();
    viewOpts = { ...viewOpts, ...opts };
    syncInputs();
    view.setOptions(viewOpts);
    return request();
  },
  /** Resolves once the current request (if any) has been drawn. */
  ready: (): Promise<void> => (inFlight || queued ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve())
    .then(() => loaderGone),
};

readHash();
syncInputs();
const shell = mountShell({
  params: () => params,
  setParams: (p) => { params = { ...params, ...p }; syncInputs(); request(); },
  newWorld: (p) => { newWorld(p); syncInputs(); request(); },
  name: displayName,
  view: () => viewOpts,
  setView: (o) => { const r = setView(o); syncInputs(); return r; },
  lens: () => lens,
  setLens: (l) => { lens = l; writeHash(); },
  world: () => world,
  game: () => game,
  radiusKm: () => radiusKm,
  onDrawn: (f) => drawnListeners.push(f),
  busy: () => inFlight || queued,
  renderer: view,
  history: loadHistory,
  historyKey: () => JSON.stringify(params),
});
shell.applyLens(lens, false);
view.setOptions(viewOpts);
loader = mountLoader(displayName(), kindLabel(params));
loaderGone = loader.gone;
request();

// A link pasted into an open tab only changes the hash, which doesn't reload the page. (Our own
// writes use replaceState, which doesn't fire this.)
window.addEventListener('hashchange', () => {
  worldName = randomName();
  params = { ...DEFAULT_PARAMS, seed: nameSeed(worldName) };
  readHash();
  syncInputs();
  shell.applyLens(lens, false);
  request();
});
