/**
 * The hex view's screen furniture, as a game's HUD rather than a panel of settings: the place's
 * name top left (with an About card), a compass top right, the time of day along the bottom,
 * tools down the right (walk, reset, layers, settings, help), the planet's map of the spot bottom
 * left. A first-visit card says how to move.
 *
 * It rearranges the elements hex.html already has (same ids, so hex.ts drives them as before);
 * #ui=classic keeps the old panel, for comparison.
 */

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const el = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5" /></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 4l9 5-9 5-9-5 9-5z" /><path d="M3 14l9 5 9-5" /></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17v.5" /></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 4l-6 2.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4zM9 4v13.5M15 6.5V20" /></svg>',
};

export interface HudHooks {
  /** A game's own words for how to move (Primundi: tap to walk), and the key it remembers being shown under. */
  help?: { touch: string; mouse: string; key: string };
  /** The camera's heading, radians (0: north), for the compass. */
  heading: () => number;
  /** Turn to face north. */
  faceNorth: () => void;
}

export function mountHud(hooks: HudHooks) {
  const b = document.body;
  b.classList.add('hud');
  const panel = $('panel');

  // --- Top left: back, the name, About.
  const top = el('div', 'hud-top');
  const back = $('back') as HTMLAnchorElement;
  back.className = 'hud-back'; back.innerHTML = ICON.back + '<span>Planet</span>'; back.title = 'Back to the planet (Esc)';
  // The place's kind as the name; the hex's number, warmth and size under it.
  const name = el('div', 'hud-name');
  const nameH = el('h1');
  const sub = el('div', 'hud-sub');
  name.append(nameH, sub);
  $('title').hidden = true;
  const infoBtn = el('button', 'hud-icon', ICON.info); infoBtn.title = 'About this hex';
  top.append(back, name, infoBtn);
  b.appendChild(top);
  const about = el('div', 'hud-pop hud-about');
  about.appendChild($('facts'));
  const gallery = panel.querySelector('a[href="/hexes.html"]');
  if (gallery) { gallery.textContent = 'Gallery of hexes ›'; about.appendChild(gallery); }
  b.appendChild(about);
  // The subtitle: the first line of the facts (hex.ts writes them), the place's kind and size.
  const syncSub = () => {
    const f = $('facts').innerHTML;
    nameH.textContent = /^<b>([^<]+)<\/b>/.exec(f)?.[1] ?? $('title').textContent ?? '';
    const temp = /([-\d]+ °C) mean/.exec(f)?.[1], across = /Really <b>([\d.]+ km)<\/b>/.exec(f)?.[1];
    sub.textContent = [$('title').textContent, temp, across && `${across} across`].filter(Boolean).join(' · ');
  };
  new MutationObserver(syncSub).observe($('facts'), { childList: true, subtree: true, characterData: true });
  syncSub();

  // --- Top right: compass. North up when clicked.
  const compass = el('button', 'hud-compass', '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" /><path class="n" d="M20 6l4 14h-8z" /><path class="s" d="M20 34l-4-14h8z" /><text x="20" y="5.4">N</text></svg>');
  compass.title = 'Face north';
  compass.onclick = hooks.faceNorth;
  b.appendChild(compass);
  const needle = compass.querySelector('svg') as SVGElement;
  const spin = () => { needle.style.transform = `rotate(${(hooks.heading() * 180) / Math.PI}deg)`; requestAnimationFrame(spin); };
  requestAnimationFrame(spin);

  // --- Bottom: the time of day.
  const time = el('div', 'hud-time');
  time.append($('timerow'), $('timeinfo'));
  b.appendChild(time);

  // --- Right: tools.
  const rail = el('div', 'hud-rail');
  const tool = (icon: string, title: string, onclick: () => void) => {
    const t = el('button', 'hud-icon', icon); t.title = title; t.onclick = onclick; rail.appendChild(t); return t;
  };
  rail.appendChild($('pegman'));
  const resetBtn = $('reset');
  tool(ICON.reset, 'Reset the view', () => resetBtn.click());
  const layersBtn = tool(ICON.layers, 'Layers', () => toggle(layers, layersBtn));
  const gearBtn = tool(ICON.gear, 'Settings', () => toggle(settings, gearBtn));
  const helpBtn = tool(ICON.help, 'How to move', () => showHelp(!help.classList.contains('show')));
  b.appendChild(rail);

  // Layers: neighbours, tilt-shift, the map inset. (The outline is H: on a cut tile its edge is the outline already.)
  const layers = el('div', 'hud-pop hud-layers');
  const rows = [...panel.querySelectorAll('label.row')] as HTMLElement[];
  const rowOf = (id: string) => rows.find((r) => r.querySelector('#' + id));
  for (const id of ['around', 'tilt']) { const r = rowOf(id); if (r) layers.appendChild(r); }
  const insetRow = el('label', 'row', 'Planet map <input type="checkbox" checked style="justify-self:start" /><span></span>');
  const insetBox = insetRow.querySelector('input') as HTMLInputElement;
  insetBox.onchange = () => b.classList.toggle('no-inset', !insetBox.checked);
  layers.appendChild(insetRow);
  b.appendChild(layers);

  // Settings: detail, camera feel, head bob, the tuning, and the timings.
  const settings = el('div', 'hud-pop hud-settings');
  for (const id of ['res', 'feel', 'bob']) { const r = rowOf(id); if (r) settings.appendChild(r); }
  settings.appendChild($('tuning'));
  const dbg = el('div', 'hud-debug');
  dbg.append($('timing'), $('fps'));
  settings.appendChild(dbg);
  b.appendChild(settings);

  const pops: [HTMLElement, HTMLElement][] = [[layers, layersBtn], [settings, gearBtn], [about, infoBtn]];
  function toggle(p: HTMLElement, btn: HTMLElement, on = !p.classList.contains('show')) {
    for (const [q, qb] of pops) { q.classList.toggle('show', q === p && on); qb.classList.toggle('on', q === p && on); }
  }
  infoBtn.onclick = () => toggle(about, infoBtn);
  // A click on the map closes them.
  $('view').addEventListener('pointerdown', () => { for (const [q] of pops) if (q.classList.contains('show')) toggle(q, infoBtn, false); });

  // --- Bottom left: the planet's map of the spot (the inset), smaller.
  $('inset').classList.add('hud-inset');

  // --- How to move: shown on a first visit, then from the ? button.
  // Touch screens get their own words (and no walking yet: it wants a keyboard).
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  if (touchOnly) $('pegman').hidden = true;
  const help = el('div', 'hud-help', hooks.help ? (touchOnly ? hooks.help.touch : hooks.help.mouse) : touchOnly ? `
    <div><b>Drag</b> move</div><div><b>Pinch</b> zoom</div><div><b>Twist</b> turn</div><div><b>Two fingers up or down</b> tilt</div>` : `
    <div><b>Right-drag</b> move</div><div><b>Middle-drag</b> turn</div><div><b>Scroll</b> zoom</div>
    <div><b>W A S D</b> move · <b>Q E</b> turn</div><div><b>Drag the figure</b> onto the map to walk</div>
    <div class="dim">[ ] hour · P play the day · N neighbours · T tilt-shift · H outline</div>`);
  b.appendChild(help);
  let helpTimer = 0;
  function showHelp(on: boolean) {
    help.classList.toggle('show', on); helpBtn.classList.toggle('on', on);
    clearTimeout(helpTimer);
    if (on) helpTimer = window.setTimeout(() => showHelp(false), 12000);
    try { localStorage.setItem(hooks.help?.key ?? 'mundi-hex-help', '1'); } catch { /* private window */ }
  }
  let seen = false;
  try { seen = localStorage.getItem(hooks.help?.key ?? 'mundi-hex-help') === '1'; } catch { /* private window */ }
  if (!seen) setTimeout(() => showHelp(true), 800);

  panel.hidden = true;
  $('hint').hidden = true;
}
