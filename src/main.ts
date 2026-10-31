import { PlanetView, type ViewMode, type TerrainStyle } from './render.ts';
import { generateWorld, DEFAULT_PARAMS, WATER_OCEAN, WATER_LAKE, type World, type WorldParams } from './world.ts';
import { BIOMES } from './biomes.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = new PlanetView($('view'));
let params: WorldParams = { ...DEFAULT_PARAMS, seed: Math.floor(Math.random() * 1e6) };
let relief = 1;
let world: World;

// Parameters live in the URL hash, so a world can be shared as a link.
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = h.get(k);
    if (v !== null && v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  if (h.get('relief')) relief = Number(h.get('relief'));
}
function writeHash() {
  const h = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) h.set(k, String(v));
  h.set('relief', String(relief));
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
    const v = k === 'relief' ? relief : params[k];
    $<HTMLInputElement>(k).value = String(v);
    $<HTMLOutputElement>(`${k}-out`).textContent = fmt(v);
  }
}

function regenerate() {
  const t0 = performance.now();
  world = generateWorld({ ...params });
  const t1 = performance.now();
  view.setWorld(world);
  const t2 = performance.now();
  let ocean = 0, lakes = 0, rivers = 0;
  for (let c = 0; c < world.grid.count; c++) {
    if (world.water[c] === WATER_OCEAN) ocean++;
    else if (world.water[c] === WATER_LAKE) lakes++;
    if (world.river[c]) rivers++;
  }
  $('stats').textContent =
    `${world.grid.count.toLocaleString()} cells · ${Math.round((1 - ocean / world.grid.count) * 100)}% land · ` +
    `${lakes} lake · ${rivers} river cells · gen ${Math.round(t1 - t0)} ms, mesh ${Math.round(t2 - t1)} ms`;
  writeHash();
}

let pending = 0;
function regenerateSoon() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(regenerate);
}

for (const [k, fmt] of sliders) {
  const input = $<HTMLInputElement>(k);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    $<HTMLOutputElement>(`${k}-out`).textContent = fmt(v);
    if (k === 'relief') { relief = v; view.setOptions({ relief: v }); writeHash(); return; }
    params[k] = v;
    regenerateSoon();
  });
}
$<HTMLInputElement>('seed').addEventListener('change', (e) => {
  params.seed = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
  regenerate();
});
$('dice').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 1e6);
  syncInputs();
  regenerate();
});
$<HTMLSelectElement>('mode').addEventListener('change', (e) => view.setOptions({ mode: (e.target as HTMLSelectElement).value as ViewMode }));
$<HTMLSelectElement>('style').addEventListener('change', (e) => view.setOptions({ style: (e.target as HTMLSelectElement).value as TerrainStyle }));
$<HTMLInputElement>('trees').addEventListener('change', (e) => view.setOptions({ trees: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('clouds').addEventListener('change', (e) => view.setOptions({ clouds: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('grid').addEventListener('change', (e) => view.setOptions({ grid: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('show-rivers').addEventListener('change', (e) => view.setOptions({ rivers: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('blend').addEventListener('change', (e) => view.setOptions({ blend: (e.target as HTMLInputElement).checked }));
$('collapse').addEventListener('click', () => {
  const p = $('panel');
  p.classList.toggle('collapsed');
  $('collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
});

// Hover readout.
const info = $('info');
let lastCell = -1;
view.renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) { info.hidden = true; return; }
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

readHash();
syncInputs();
view.setOptions({ relief });
regenerate();
