/**
 * The planet-first interface: the globe fills the screen and the controls stay out of its way.
 *
 * Name, new world, share, a lens bar, a "Shape this world" drawer, an almanac card describing
 * the planet, legends for the data lenses, preset chips, and the clock. (A minimal variant
 * without the almanac was tried side by side and dropped, 2026-10-31.) The old slider panel
 * survives as "Advanced".
 */
import type { PlanetView, ViewOptions } from './render.ts';
import type { World, WorldParams } from './world.ts';
import { WATER_LAKE, WATER_OCEAN } from './world.ts';
import type { GameData } from './gamedata.ts';
import { nameMaker } from './gamedata.ts';
import { B, BIOMES } from './biomes.ts';

export type Lens = 'earth' | 'map' | 'heat' | 'rain' | 'plates';

export interface App {
  params(): WorldParams;
  setParams(p: Partial<WorldParams>): void;
  view(): ViewOptions;
  setView(o: Partial<ViewOptions>): Promise<void> | void;
  lens(): Lens;
  setLens(l: Lens): void;
  world(): World | undefined;
  game(): GameData | null;
  radiusKm(): number;
  onDrawn(f: () => void): void;
  busy(): boolean;
  renderer: PlanetView;
}

const LENSES: { id: Lens; label: string; icon: string; view: Partial<ViewOptions> }[] = [
  { id: 'earth', label: 'Earth', icon: '◐', view: { look: 'photo', mode: 'biome', clouds: true } },
  { id: 'map', label: 'Map', icon: '⬡', view: { look: 'map', mode: 'biome', grid: true, clouds: false } },
  { id: 'heat', label: 'Heat', icon: '☀', view: { look: 'map', mode: 'temperature', grid: false, clouds: false } },
  { id: 'rain', label: 'Rain', icon: '☂', view: { look: 'map', mode: 'moisture', grid: false, clouds: false } },
  { id: 'plates', label: 'Plates', icon: '⛰', view: { look: 'map', mode: 'plates', grid: true, clouds: false } },
];

const LEGENDS: Partial<Record<Lens, [string, string, string]>> = {
  heat: ['Frozen', 'Hot', 'linear-gradient(90deg, hsl(238 75% 50%), hsl(120 75% 50%), hsl(0 75% 50%))'],
  rain: ['Arid', 'Wet', 'linear-gradient(90deg, hsl(36 60% 60%), hsl(126 60% 47%), hsl(216 60% 35%))'],
};

interface Preset { id: string; label: string; p: Partial<WorldParams> }
const PRESETS: Preset[] = [
  { id: 'earthlike', label: 'Earthlike', p: { ocean: 0.68, continents: 3, plates: 12, roughness: 0.45, heat: 0, wetness: 0 } },
  { id: 'pangaea', label: 'Pangaea', p: { ocean: 0.6, continents: 1, plates: 10, roughness: 0.35, heat: 0.05, wetness: -0.05 } },
  { id: 'archipelago', label: 'Archipelago', p: { ocean: 0.8, continents: 8, plates: 30, roughness: 0.85, heat: 0.05, wetness: 0.1 } },
  { id: 'iceage', label: 'Ice age', p: { ocean: 0.64, continents: 3, plates: 12, roughness: 0.45, heat: -0.3, wetness: -0.1 } },
  { id: 'desert', label: 'Desert world', p: { ocean: 0.35, continents: 2, plates: 12, roughness: 0.4, heat: 0.15, wetness: -0.3 } },
  { id: 'water', label: 'Water world', p: { ocean: 0.9, continents: 6, plates: 20, roughness: 0.7, heat: 0.05, wetness: 0.1 } },
];

/** Four plain-language dials, each 0..1, mapped onto the raw parameters. */
const DIALS = [
  {
    id: 'oceans', label: 'Oceans', lo: 'Dry', hi: 'Water world',
    get: (p: WorldParams) => (p.ocean - 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ ocean: 0.3 + 0.6 * v }),
  },
  {
    id: 'land', label: 'Land', lo: 'One continent', hi: 'Islands',
    get: (p: WorldParams) => (p.continents - 1) / 7,
    set: (v: number): Partial<WorldParams> => ({ continents: Math.round(1 + 7 * v), plates: Math.round(8 + 22 * v), roughness: 0.3 + 0.55 * v }),
  },
  {
    id: 'climate', label: 'Climate', lo: 'Ice age', hi: 'Hothouse',
    get: (p: WorldParams) => (p.heat + 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ heat: -0.3 + 0.6 * v }),
  },
  {
    id: 'rain', label: 'Rain', lo: 'Arid', hi: 'Lush',
    get: (p: WorldParams) => (p.wetness + 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ wetness: -0.3 + 0.6 * v }),
  },
];

export function planetName(seed: number): string {
  return nameMaker(seed * 7 + 0x5151)();
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function mountShell(app: App) {
  const r = app.renderer;
  document.body.classList.add('shell', 'ui-b');
  document.getElementById('panel')!.classList.add('advanced');

  const root = document.createElement('div');
  root.className = 'ui';
  root.innerHTML = `
    <header class="brand">
      <div class="wordmark">MUNDI</div>
      <div class="pname" id="pname">…</div>
      <div class="pseed" id="pseed"></div>
    </header>
    <div class="actions">
      <button class="pill primary" id="new-world" title="Generate a new planet">⟳ New world</button>
      <button class="pill" id="share" title="Copy a link to this exact planet">⤴ Share</button>
    </div>
    <nav class="lenses" id="lenses">
      ${LENSES.map((l) => `<button data-lens="${l.id}" title="${l.label}"><span class="ico">${l.icon}</span><span class="lbl">${l.label}</span></button>`).join('')}
    </nav>
    <div class="legend" id="legend" hidden><span id="legend-lo"></span><i id="legend-bar"></i><span id="legend-hi"></span></div>
    <button class="pill shape-toggle" id="shape-toggle">✦ Shape this world</button>
    <aside class="drawer" id="drawer" hidden>
      <div class="drawer-head"><h2>Shape this world</h2><button class="x" id="drawer-close" title="Close">×</button></div>
      <div class="presets" id="presets">${PRESETS.map((p) => `<button data-preset="${p.id}">${p.label}</button>`).join('')}</div>
      <div class="dials">
        ${DIALS.map((d) => `
          <label class="dial"><span class="dial-name">${d.label}</span>
            <input type="range" min="0" max="1" step="0.01" data-dial="${d.id}" />
            <span class="dial-ends"><em>${d.lo}</em><em>${d.hi}</em></span>
          </label>`).join('')}
      </div>
      <button class="link" id="advanced-toggle">Advanced settings</button>
    </aside>
    <section class="almanac" id="almanac"></section>
    <div class="chips" id="chips">${PRESETS.map((p) => `<button data-preset="${p.id}">${p.label}</button>`).join('')}</div>
    <div class="clock" id="clock">
      <button data-scale="day" title="Speed time up: a day passes in 24 seconds"><span class="ico">☀</span> Watch a day</button>
      <button data-scale="year" title="Speed time up: a year passes in 30 seconds"><span class="ico">❄</span> Watch a year</button>
      <i class="yearbar" id="yearbar" hidden><b id="yearmark"></b></i>
      <span class="date" id="date"></span>
    </div>
    <div class="proj" id="proj">
      <button data-proj="globe" class="on" title="The planet as a globe"><span class="ico">◯</span> Globe</button>
      <button data-proj="flat" title="The whole planet laid flat (Mercator projection)"><span class="ico">▭</span> Flat map</button>
    </div>
    <div class="hint" id="hint">Drag to spin · scroll to dive · hover a place</div>
    <div class="toast" id="toast" hidden></div>
  `;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;

  // --- Name ---
  const showName = () => {
    const p = app.params();
    $('pname').textContent = planetName(p.seed);
    $('pseed').textContent = `world #${p.seed}`;
    document.title = `${planetName(p.seed)} · Mundi`;
  };

  // --- Actions ---
  $('new-world').onclick = () => app.setParams({ seed: Math.floor(Math.random() * 1e6) });
  $('share').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied: anyone with it sees this planet'); }
    catch { toast('Copy the address bar to share this planet'); }
  };
  let toastTimer = 0;
  const toast = (msg: string) => {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.hidden = true; }, 2400);
  };

  // --- Lenses ---
  const applyLens = (l: Lens, user = true) => {
    const def = LENSES.find((x) => x.id === l) ?? LENSES[0];
    root.querySelectorAll<HTMLButtonElement>('#lenses button').forEach((b) => b.classList.toggle('on', b.dataset.lens === def.id));
    app.setLens(def.id);
    if (user || true) app.setView({ ...def.view, sites: def.id === 'map' });
    const lg = LEGENDS[def.id];
    $('legend').hidden = !lg;
    if (lg) { $('legend-lo').textContent = lg[0]; $('legend-hi').textContent = lg[1]; $('legend-bar').style.background = lg[2]; }
  };
  root.querySelectorAll<HTMLButtonElement>('#lenses button').forEach((b) => { b.onclick = () => applyLens(b.dataset.lens as Lens); });

  // --- Drawer: presets, dials, advanced ---
  const openDrawer = (on: boolean) => { $('drawer').hidden = !on; $('shape-toggle').classList.toggle('on', on); };
  $('shape-toggle').onclick = () => openDrawer($('drawer').hidden === true);
  $('drawer-close').onclick = () => openDrawer(false);
  root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const pre = PRESETS.find((x) => x.id === b.dataset.preset)!;
      app.setParams(pre.p);
      syncDials();
    };
  });
  const syncDials = () => {
    const p = app.params();
    for (const d of DIALS) root.querySelector<HTMLInputElement>(`[data-dial="${d.id}"]`)!.value = String(clamp01(d.get(p)));
    const match = PRESETS.find((x) => Object.entries(x.p).every(([k, v]) => Math.abs((p[k as keyof WorldParams] as number) - (v as number)) < 1e-6));
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === match?.id));
  };
  for (const d of DIALS) {
    const input = root.querySelector<HTMLInputElement>(`[data-dial="${d.id}"]`)!;
    input.oninput = () => app.setParams(d.set(Number(input.value)));
  }
  // --- Clock: speed time up. A day runs the sun round (day and night); a year sweeps the
  // seasons (snow, sea ice, autumn colour). Clicking the running one pauses it. ---
  const RATES = { day: 1 / 24, year: 365 / 30 };   // days per second: a day in 24 s, a year in 30 s
  let scale: 'day' | 'year' | null = null, everPlayed = false;
  const applyClock = () => {
    r.setClock(scale ? RATES[scale] : 0);
    // Day/night only makes sense at day speed; at year speed it would strobe.
    app.setView({ light: scale === 'day' ? 'cycle' : 'follow' });
    root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
      const on = b.dataset.scale === scale;
      b.classList.toggle('on', on);
      b.querySelector('.ico')!.textContent = on ? '❚❚' : b.dataset.scale === 'day' ? '☀' : '❄';
    });
    $('clock').classList.toggle('running', scale !== null);
    $('yearbar').hidden = scale !== 'year';
  };
  root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
    b.onclick = () => {
      const s = b.dataset.scale as 'day' | 'year';
      scale = scale === s ? null : s;
      everPlayed ||= scale !== null;
      // Seasons and nightfall only show on the Earth view, not on the data maps.
      if (scale && app.lens() !== 'earth') applyLens('earth');
      // Day and night need the globe: the flat map has no night side.
      if (scale === 'day' && r.isMap()) setProj(false);
      // Start the day at mid-morning where you are looking, so dusk arrives within seconds.
      if (scale === 'day') r.setLocalHour(9);
      applyClock();
    };
  });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // What to look for in each northern season (the south has the opposite one).
  const SEASONS = [
    'Northern winter: snow and sea ice push south',
    'Northern spring: the snow retreats',
    'Northern summer: the north is at its greenest',
    'Northern autumn: forests turn, the ice returns',
  ];
  const tickDate = () => {
    const d = r.getDay(), doy = ((d % 365) + 365) % 365;
    const month = MONTHS[Math.min(11, Math.floor(doy / 30.42))];
    // Northern season: winter from ~Dec 21 (day 355), spring from ~Mar 21 (day 80)...
    const sIdx = Math.floor((((doy - 355 + 365) % 365)) / 91.25) % 4;
    const date = `${month} ${Math.floor(doy % 30.42) + 1}`;
    let text: string;
    if (scale === 'day') {
      // Local time at the middle of the view, so the label agrees with what you see.
      const lh = r.localHour(), hh = Math.floor(lh);
      const part = lh < 5 || lh >= 21 ? 'night' : lh < 7.5 ? 'dawn' : lh < 17 ? 'day' : 'dusk';
      text = `${date}, ${String(hh).padStart(2, '0')}:00 here · ${part}`;
    }
    else if (scale === 'year') text = `${month} · ${SEASONS[sIdx]}`;
    else if (!everPlayed) text = 'Speed up time';
    else text = `Paused · ${date}`;
    $('date').textContent = text;
    $('yearmark').style.left = `${(doy / 365) * 100}%`;
    requestAnimationFrame(tickDate);
  };
  // --- Globe or flat map. A quick fade covers the swap. ---
  const setProj = (flat: boolean) => {
    if (flat === r.isMap()) return;
    if (flat && scale === 'day') { scale = null; applyClock(); }
    const c = r.renderer.domElement;
    c.style.transition = 'opacity .14s';
    c.style.opacity = '0';
    setTimeout(() => {
      r.setMap(flat);
      root.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach((b) => b.classList.toggle('on', (b.dataset.proj === 'flat') === flat));
      $('hint').textContent = flat ? 'Drag to pan · scroll to zoom · hover a place' : 'Drag to spin · scroll to dive · hover a place';
      requestAnimationFrame(() => { c.style.opacity = '1'; });
    }, 140);
  };
  root.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach((b) => { b.onclick = () => setProj(b.dataset.proj === 'flat'); });

  $('advanced-toggle').onclick = () => {
    const panel = document.getElementById('panel')!;
    panel.classList.toggle('advanced');
    $('advanced-toggle').textContent = panel.classList.contains('advanced') ? 'Advanced settings' : 'Hide advanced settings';
  };

  // --- Almanac ---
  const almanac = () => {
    const w = app.world(), g = app.game();
    if (!w || !g) return;
    const N = w.grid.count;
    let land = 0, ice = 0, desert = 0, forest = 0, lakes = 0;
    const FOREST = new Set<number>([B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.TAIGA, B.DRY_FOREST]);
    for (let c = 0; c < N; c++) {
      if (w.water[c] === WATER_OCEAN) continue;
      if (w.water[c] === WATER_LAKE) { lakes++; continue; }
      land++;
      const b = w.biome[c];
      if (b === B.ICE || b === B.PEAK) ice++;
      else if (b === B.DESERT) desert++;
      else if (FOREST.has(b)) forest++;
    }
    let mouths = 0;
    for (let c = 0; c < N; c++) if (w.river[c] && w.water[w.downstream[c]] === WATER_OCEAN) mouths++;
    const pct = (n: number) => `${Math.round((n / Math.max(1, land)) * 100)}%`;
    const named = g.continents.filter((k) => !k.name.startsWith('Isle'));
    const cellKm = Math.round(Math.sqrt((4 * Math.PI) / N) * app.radiusKm());
    $('almanac').innerHTML = `
      <h3>Almanac</h3>
      <dl>
        <dt>Land</dt><dd>${Math.round((land / N) * 100)}% of the surface</dd>
        <dt>Continents</dt><dd>${named.length ? named.slice(0, 3).map((k) => k.name).join(', ') + (named.length > 3 ? ` +${named.length - 3}` : '') : 'none, only islands'}</dd>
        <dt>Forest</dt><dd>${pct(forest)} of land</dd>
        <dt>Desert</dt><dd>${pct(desert)} of land</dd>
        <dt>Ice</dt><dd>${pct(ice)} of land</dd>
        <dt>Rivers</dt><dd>${mouths} reach the sea</dd>
        <dt>Settlements</dt><dd>${g.sites.length} good sites${g.sites[0] ? `, best: ${g.sites[0].name}` : ''}</dd>
        <dt>One hex</dt><dd>≈ ${cellKm.toLocaleString()} km across</dd>
      </dl>`;
  };

  app.onDrawn(() => { showName(); syncDials(); almanac(); });
  showName();
  syncDials();
  applyClock();
  requestAnimationFrame(tickDate);

  // --- Hint fades after the first interaction; idle auto-rotate when viewed from orbit ---
  let lastInput = performance.now();
  const touched = () => {
    lastInput = performance.now();
    $('hint').classList.add('gone');
    r.controls.autoRotate = false;
  };
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) window.addEventListener(ev, touched, { passive: true });
  r.controls.autoRotateSpeed = 0.35;
  setInterval(() => {
    const far = r.camera.position.length() > 2.2 && !r.isMap();
    r.controls.autoRotate = far && performance.now() - lastInput > 8000 && !document.body.classList.contains('capture');
  }, 1000);

  return { applyLens, setProj };
}
