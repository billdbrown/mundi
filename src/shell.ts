/**
 * The planet-first interface: the globe fills the screen and the controls stay out of its way.
 *
 * Name; a New world button whose menu offers kinds of world and a Custom world drawer (four
 * dials, then the old slider panel as "All settings"); share; a lens bar in the bottom-left
 * corner with legends for the data lenses; an almanac card describing the planet; the clock.
 * (A minimal variant without the almanac was tried side by side and dropped, 2026-10-31.)
 */
import type { PlanetView, Quality, ViewOptions } from './render.ts';
import { baseOf } from './ecology.ts';
import type { World, WorldParams } from './world.ts';
import { DEFAULT_PARAMS, WATER_LAKE, WATER_OCEAN } from './world.ts';
import type { GameData } from './gamedata.ts';
import { nameMaker } from './gamedata.ts';
import { B, BIOMES } from './biomes.ts';
import { HISTORY_YEARS, popAt, realmAt, type History } from './civ.ts';

export type Lens = 'earth' | 'map' | 'heat' | 'rain' | 'plates';

export interface App {
  params(): WorldParams;
  setParams(p: Partial<WorldParams>): void;
  /** A new named world (fresh name and seed), optionally with other settings. */
  newWorld(p?: Partial<WorldParams>): void;
  /** The planet's name. */
  name(): string;
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
  /** Centuries: this world's simulated history (computed once, in a worker). */
  history(): Promise<History>;
  /** Identifies the current world, so a history can be matched to it. */
  historyKey(): string;
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

interface Preset { id: string; label: string; blurb: string; p: Partial<WorldParams> }
/** Kinds of world. Earthlike is the defaults; the others also name themselves in the URL (kind=…). */
export const PRESETS: Preset[] = [
  { id: 'earthlike', label: 'Earthlike', blurb: 'A few continents, two-thirds sea', p: { ocean: 0.68, continents: 3, plates: 12, roughness: 0.45, heat: 0, wetness: 0 } },
  { id: 'pangaea', label: 'Pangaea', blurb: 'One supercontinent', p: { ocean: 0.6, continents: 1, plates: 10, roughness: 0.35, heat: 0.05, wetness: -0.05 } },
  { id: 'archipelago', label: 'Archipelago', blurb: 'Scattered islands', p: { ocean: 0.8, continents: 8, plates: 30, roughness: 0.85, heat: 0.05, wetness: 0.1 } },
  { id: 'iceage', label: 'Ice age', blurb: 'Cold, with great ice caps', p: { ocean: 0.64, continents: 3, plates: 12, roughness: 0.45, heat: -0.3, wetness: -0.1 } },
  { id: 'desert', label: 'Desert world', blurb: 'Dry land, little sea', p: { ocean: 0.35, continents: 2, plates: 12, roughness: 0.4, heat: 0.15, wetness: -0.3 } },
  { id: 'water', label: 'Water world', blurb: 'Nine-tenths ocean', p: { ocean: 0.9, continents: 6, plates: 20, roughness: 0.7, heat: 0.05, wetness: 0.1 } },
];

/** The kind of world these settings are, or undefined for a custom one. Every setting must match. */
export function kindOf(p: WorldParams): Preset | undefined {
  const keys = (Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]).filter((k) => k !== 'seed');
  return PRESETS.find((x) => keys.every((k) => Math.abs(p[k] - (x.p[k] ?? DEFAULT_PARAMS[k])) < 1e-6));
}

/** "Earthlike world", "Desert world", "Custom world"... */
export function kindLabel(p: WorldParams): string {
  const k = kindOf(p);
  return !k ? 'Custom world' : /world$/i.test(k.label) ? k.label : `${k.label} world`;
}

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
  document.body.classList.add('shell');
  document.getElementById('panel')!.classList.add('advanced');
  // Layer buttons in the bottom-left corner: a row or a column, chosen live (?lenses=row|column).
  // Temporary: once Bill picks one, the other goes.
  const lensLayout = new URLSearchParams(location.search).get('lenses') === 'row' ? 'row' : 'column';
  document.body.classList.add(`lenses-${lensLayout}`);

  const root = document.createElement('div');
  root.className = 'ui';
  root.innerHTML = `
    <header class="brand">
      <div class="wordmark">MUNDI</div>
      <div class="pname" id="pname">…</div>
      <div class="pseed" id="pseed"></div>
    </header>
    <div class="actions">
      <div class="newworld">
        <button class="pill primary nw-main" id="new-world" title="Another planet of the same kind">⟳ New world</button>
        <button class="pill primary nw-more" id="nw-more" title="Choose a kind of world" aria-haspopup="menu" aria-expanded="false">▾</button>
        <div class="menu" id="nw-menu" role="menu" hidden>
          ${PRESETS.map((p) => `<button role="menuitem" data-preset="${p.id}"><b>${p.label}</b><span>${p.blurb}</span></button>`).join('')}
          <hr />
          <button role="menuitem" id="nw-custom"><b>✦ Custom world…</b><span>Set every dial yourself</span></button>
        </div>
      </div>
      <button class="pill" id="share" title="Copy a link to this exact planet">⤴ Share</button>
    </div>
    <nav class="lenses collapsed" id="lenses">
      <button class="lens-toggle" id="lens-toggle" aria-expanded="false"><span class="ico" id="lens-cur-ico"></span><span class="lbl" id="lens-cur"></span><span class="chev"></span></button>
      <div class="lens-opts">
        ${LENSES.map((l) => `<button data-lens="${l.id}" title="${l.label}"><span class="ico">${l.icon}</span><span class="lbl">${l.label}</span></button>`).join('')}
      </div>
    </nav>
    <div class="legend" id="legend" hidden><span id="legend-lo"></span><i id="legend-bar"></i><span id="legend-hi"></span></div>
    <aside class="drawer" id="drawer" hidden>
      <div class="drawer-head"><h2>Custom world</h2><button class="x" id="drawer-close" title="Close">×</button></div>
      <p class="drawer-note">Changes reshape this planet as you drag. ⟳ New world keeps these settings.</p>
      <div class="dials">
        ${DIALS.map((d) => `
          <label class="dial"><span class="dial-name">${d.label}</span>
            <input type="range" min="0" max="1" step="0.01" data-dial="${d.id}" />
            <span class="dial-ends"><em>${d.lo}</em><em>${d.hi}</em></span>
          </label>`).join('')}
      </div>
      <button class="link" id="advanced-toggle">All settings</button>
      <div id="advanced-slot"></div>
    </aside>
    <section class="almanac" id="almanac"></section>
    <section class="chronicle" id="chronicle" hidden><h3>Chronicle</h3><div id="chronicle-list"></div></section>
    <div class="clock" id="clock">
      <button data-scale="day" title="Speed time up: a day passes in 24 seconds"><span class="ico">☀</span> Watch a day</button>
      <button data-scale="year" title="Speed time up: a year passes in 30 seconds"><span class="ico">❄</span> Watch a year</button>
      <button data-scale="centuries" title="Watch 2,000 years of history: settlements, farms, roads and realms"><span class="ico">⌂</span> Watch centuries</button>
      <i class="yearbar" id="yearbar" hidden><b id="yearmark"></b></i>
      <input type="range" class="timeline" id="timeline" min="0" max="${HISTORY_YEARS}" step="1" value="0" hidden title="Drag through history" />
      <span class="date" id="date"></span>
    </div>
    <div class="proj" id="proj">
      <button data-proj="globe" class="on" title="The planet as a globe"><span class="ico">◯</span> Globe</button>
      <button data-proj="flat" title="The whole planet laid flat (Mercator projection)"><span class="ico">▭</span> Flat map</button>
      <i class="sep"></i>
      <button id="clouds-toggle" class="on" title="Show or hide the clouds"><span class="ico">☁</span> Clouds</button>
      <button id="quality" title=""><span class="ico">◈</span> <span id="quality-lbl"></span></button>
    </div>
    <div class="hint" id="hint">Drag to spin · scroll to dive · hover a place</div>
    <div class="toast" id="toast" hidden></div>
  `;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  // Per-browser conveniences (open panels); storage can be missing in private windows.
  const pref = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
  const setPref = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private window */ } };

  // --- Name ---
  const showName = () => {
    const name = app.name();
    $('pname').textContent = name;
    $('pseed').textContent = kindLabel(app.params());
    document.title = `${name} · Mundi`;
  };

  // --- Actions ---
  $('new-world').onclick = () => app.newWorld();
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
  // The clouds button is a standing preference: lenses that show clouds respect it.
  let cloudsOn = (() => { try { return localStorage.getItem('mundi-clouds') !== 'off'; } catch { return true; } })();
  // The layers start collapsed to one button showing the current layer; open or closed is
  // remembered per browser.
  let layersOpen = pref('mundi-layers') === 'open';
  const syncLensToggle = () => {
    $('lenses').classList.toggle('collapsed', !layersOpen);
    const t = $('lens-toggle'), cur = LENSES.find((x) => x.id === app.lens()) ?? LENSES[0];
    t.setAttribute('aria-expanded', String(layersOpen));
    t.title = layersOpen ? 'Hide the layers' : 'Show the layers';
    $('lens-cur-ico').textContent = cur.icon;
    $('lens-cur').textContent = layersOpen ? 'Layers' : cur.label;
  };
  $('lens-toggle').onclick = () => { layersOpen = !layersOpen; setPref('mundi-layers', layersOpen ? 'open' : 'closed'); syncLensToggle(); };
  const applyLens = (l: Lens, user = true) => {
    const def = LENSES.find((x) => x.id === l) ?? LENSES[0];
    root.querySelectorAll<HTMLButtonElement>('#lenses [data-lens]').forEach((b) => b.classList.toggle('on', b.dataset.lens === def.id));
    app.setLens(def.id);
    syncLensToggle();
    if (user || true) app.setView({ ...def.view, sites: def.id === 'map', clouds: !!def.view.clouds && cloudsOn });
    const lg = LEGENDS[def.id];
    $('legend').hidden = !lg;
    if (lg) { $('legend-lo').textContent = lg[0]; $('legend-hi').textContent = lg[1]; $('legend-bar').style.background = lg[2]; }
  };
  root.querySelectorAll<HTMLButtonElement>('#lenses [data-lens]').forEach((b) => { b.onclick = () => applyLens(b.dataset.lens as Lens); });
  // A hand on the layers or the globe/flat switch: a switch looks likely, so the background
  // shader compiles stop waiting for the view to rest (PlanetView.hurryCompiles).
  for (const id of ['lenses', 'proj']) $(id).addEventListener('pointerenter', () => r.hurryCompiles());
  syncLensToggle();
  const syncCloudButton = () => $('clouds-toggle').classList.toggle('on', cloudsOn);
  $('clouds-toggle').onclick = () => {
    cloudsOn = !cloudsOn;
    try { localStorage.setItem('mundi-clouds', cloudsOn ? 'on' : 'off'); } catch { /* private window */ }
    syncCloudButton();
    applyLens(app.lens());
  };
  syncCloudButton();
  // Quality: a standing preference for this device. Auto lowers the resolution when frames run
  // slow; Fast keeps it low; Sharp never lowers it.
  const QUALITY: { id: Quality; label: string; title: string }[] = [
    { id: 'auto', label: 'Auto', title: 'Quality: automatic. Lowers the resolution when frames run slow. Click for Fast' },
    { id: 'fast', label: 'Fast', title: 'Quality: fast. Low resolution, for slower computers. Click for Sharp' },
    { id: 'sharp', label: 'Sharp', title: 'Quality: sharp. Full resolution always, however slow. Click for Auto' },
  ];
  let quality = (QUALITY.find((q) => q.id === pref('mundi-quality')) ?? QUALITY[0]).id;
  const syncQuality = () => {
    const q = QUALITY.find((x) => x.id === quality)!;
    $('quality-lbl').textContent = q.label;
    $('quality').title = q.title;
    $('quality').classList.toggle('on', quality !== 'auto');
    r.setQuality(quality);
  };
  $('quality').onclick = () => {
    quality = QUALITY[(QUALITY.findIndex((q) => q.id === quality) + 1) % QUALITY.length].id;
    setPref('mundi-quality', quality);
    syncQuality();
  };
  syncQuality();

  // --- New world menu: a kind of world (fresh seed), or a custom one ---
  const openMenu = (on: boolean) => {
    $('nw-menu').hidden = !on;
    $('nw-more').setAttribute('aria-expanded', String(on));
    $('nw-more').classList.toggle('on', on);
  };
  $('nw-more').onclick = (e) => { e.stopPropagation(); openMenu($('nw-menu').hidden === true); };
  document.addEventListener('pointerdown', (e) => {
    if (!$('nw-menu').hidden && !(e.target as Element).closest('.newworld')) openMenu(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openMenu(false); openDrawer(false); } });
  root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const pre = PRESETS.find((x) => x.id === b.dataset.preset)!;
      openMenu(false);
      openDrawer(false);
      app.newWorld(pre.p);
      syncDials();
    };
  });

  // --- Custom world drawer: the four dials, then every raw setting under "All settings" ---
  const openDrawer = (on: boolean) => { $('drawer').hidden = !on; };
  $('nw-custom').onclick = () => { openMenu(false); openDrawer(true); };
  $('drawer-close').onclick = () => openDrawer(false);
  // The old slider panel lives inside the drawer now, rather than floating on its own.
  $('advanced-slot').appendChild(document.getElementById('panel')!);
  const syncDials = () => {
    const p = app.params();
    for (const d of DIALS) root.querySelector<HTMLInputElement>(`[data-dial="${d.id}"]`)!.value = String(clamp01(d.get(p)));
    const match = kindOf(p);
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === match?.id));
    $('nw-custom').classList.toggle('on', !match);
  };
  for (const d of DIALS) {
    const input = root.querySelector<HTMLInputElement>(`[data-dial="${d.id}"]`)!;
    input.oninput = () => app.setParams(d.set(Number(input.value)));
  }
  // --- Clock: speed time up. A day runs the sun round (day and night); a year sweeps the
  // seasons (snow, sea ice, autumn colour). Clicking the running one pauses it. ---
  const RATES = { day: 1 / 24, year: 365 / 30 };   // days per second: a day in 24 s, a year in 30 s
  let scale: 'day' | 'year' | 'centuries' | null = null, everPlayed = false;
  // Centuries: 2,000 years in about 70 seconds. The history arrives from a worker.
  const CENTURY_RATE = HISTORY_YEARS / 70;
  let history: History | null = null, historyFor = '', civYear = -1, loadingHistory = false;
  const applyClock = () => {
    r.setClock(scale === 'day' || scale === 'year' ? RATES[scale] : 0);
    // Day/night only makes sense at day speed; at year speed it would strobe.
    app.setView({ light: scale === 'day' ? 'cycle' : 'follow' });
    root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
      const on = b.dataset.scale === scale;
      b.classList.toggle('on', on);
      b.querySelector('.ico')!.textContent = on ? '❚❚' : ({ day: '☀', year: '❄', centuries: '⌂' } as Record<string, string>)[b.dataset.scale!];
    });
    $('clock').classList.toggle('running', scale !== null);
    $('yearbar').hidden = scale !== 'year';
    $('timeline').hidden = civYear < 0;
    showCiv();
  };
  /** Push the current year to the view, and the chronicle and almanac to the page. */
  const showCiv = () => {
    const on = civYear >= 0 && !!history;
    r.setCiv(on ? civYear : -1, on);
    $('chronicle').hidden = !on;
    $('almanac').style.display = on ? 'none' : '';
    if (on) ($('timeline') as HTMLInputElement).value = String(Math.round(civYear));
    renderChronicle();
  };
  let shownEvents = -1;
  const renderChronicle = () => {
    if (!history || civYear < 0) return;
    const n = history.events.findIndex((e) => e.year > civYear);
    const upto = n < 0 ? history.events.length : n;
    if (upto === shownEvents) return;
    shownEvents = upto;
    const recent = history.events.slice(Math.max(0, upto - 7), upto);
    $('chronicle-list').innerHTML = recent.length
      ? recent.map((e) => `<p><b>${e.year}</b> ${e.text}</p>`).join('')
      : '<p class="quiet">An empty world, waiting.</p>';
  };
  const startCenturies = async () => {
    const key = app.historyKey();
    if (!history || historyFor !== key) {
      loadingHistory = true;
      $('date').textContent = 'Writing 2,000 years of history…';
      const h = await app.history();
      loadingHistory = false;
      if (app.historyKey() !== key || scale !== 'centuries') return;   // the world changed meanwhile
      history = h; historyFor = key;
      r.setHistory(h);
      civYear = 0; shownEvents = -1;
    } else if (civYear < 0 || civYear >= HISTORY_YEARS) {
      civYear = 0; shownEvents = -1;
    }
    applyClock();
  };
  // A new world drops the old history.
  const dropHistoryIfStale = () => {
    if (history && historyFor !== app.historyKey()) {
      history = null; historyFor = ''; civYear = -1;
      r.setHistory(null);
      if (scale === 'centuries') scale = null;
      applyClock();
    }
  };
  let lastT = performance.now();
  const tickCiv = (now: number) => {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (scale === 'centuries' && history && civYear >= 0) {
      civYear = Math.min(HISTORY_YEARS, civYear + dt * CENTURY_RATE);
      if (civYear >= HISTORY_YEARS) { scale = null; applyClock(); }
      else showCiv();
    }
    requestAnimationFrame(tickCiv);
  };
  requestAnimationFrame(tickCiv);
  $('timeline').addEventListener('input', () => {
    civYear = Number(($('timeline') as HTMLInputElement).value);
    showCiv();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
    b.onclick = () => {
      const s = b.dataset.scale as 'day' | 'year' | 'centuries';
      scale = scale === s ? null : s;
      everPlayed ||= scale !== null;
      if (scale === 'centuries') {
        if (r.isMap() === false && app.lens() !== 'earth' && app.lens() !== 'map') applyLens('earth');
        void startCenturies();
        return;
      }
      // Seasons and nightfall only show on the Earth view, not on the data maps.
      if (scale && app.lens() !== 'earth') applyLens('earth');
      void loadingHistory;
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
    if (civYear >= 0 && history && (scale === 'centuries' || scale === null)) {
      const y = Math.round(civYear);
      const live = history.settlements.filter((s) => s.founded <= y);
      const realms = new Set(live.map((s) => realmAt(s, y)));
      const people = live.reduce((sum, s) => sum + popAt(s, y), 0) * 10;
      const ppl = people >= 1e6 ? `${(people / 1e6).toFixed(1)}M` : `${Math.round(people / 1000)}k`;
      text = `Year ${y} · ${live.length} towns · ${realms.size} realm${realms.size === 1 ? '' : 's'} · ${ppl} people`;
      if (scale === null) text = `Paused · ${text}`;
      $('date').textContent = text;
      $('yearmark').style.left = `${(doy / 365) * 100}%`;
      requestAnimationFrame(tickDate);
      return;
    }
    if (loadingHistory) { requestAnimationFrame(tickDate); return; }
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
    $('advanced-toggle').textContent = panel.classList.contains('advanced') ? 'All settings' : 'Hide all settings';
  };

  // --- Almanac: collapsed to its heading by default, remembered per browser ---
  let almanacOpen = pref('mundi-almanac') === 'open';
  const syncAlmanac = () => {
    $('almanac').classList.toggle('collapsed', !almanacOpen);
    $('almanac').querySelector('.card-head')?.setAttribute('aria-expanded', String(almanacOpen));
  };
  $('almanac').addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.card-head')) return;
    almanacOpen = !almanacOpen;
    setPref('mundi-almanac', almanacOpen ? 'open' : 'closed');
    syncAlmanac();
  });
  syncAlmanac();
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
      const b = baseOf(w.biome[c]);
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
      <button class="card-head" aria-expanded="${almanacOpen}" title="Show or hide the almanac">Almanac <span class="chev"></span></button>
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

  app.onDrawn(() => { showName(); syncDials(); almanac(); dropHistoryIfStale(); });
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
