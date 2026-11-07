/**
 * The playtest's report: one self-contained HTML page of small charts (inline SVG, a little script
 * for the hover readouts) and a table view of every number in them. Colours are the dataviz
 * reference palette, validated for these five slots in light and dark.
 */
import { AMBITION_GOAL } from '../../src/primundi/caravan.ts';
import { realSeconds, BOT_NAMES, type RunResult, type BotName } from './run.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const med = (xs: number[]) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };
const fmt = (x: number, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const BOT_LABEL: Record<BotName, string> = { trader: 'Trader', explorer: 'Explorer', jobber: 'Jobber', reckless: 'Reckless', idle: 'Idle' };
const slot = (b: BotName) => `var(--series-${BOT_NAMES.indexOf(b) + 1})`;
/** Hover text, carried on the mark. */
const tip = (lines: string[]) => `data-tip="${esc(lines.join('\n'))}" tabindex="0"`;

// --- Small pieces -----------------------------------------------------------------------------
function legend(items: [string, string][], kind: 'line' | 'rect') {
  return `<div class="legend">${items.map(([label, color]) => `<span><i class="${kind}" style="--c:${color}"></i>${esc(label)}</span>`).join('')}</div>`;
}
function panel(title: string, sub: string, body: string) {
  return `<section class="panel"><h3>${esc(title)}</h3><p class="sub">${sub}</p>${body}</section>`;
}

/** Median earned over time per bot: one line each, a crosshair readout. */
function earnedChart(rs: RunResult[], origin: string, years: number) {
  const W = 460, H = 220, L = 46, R = 70, T = 10, B = 26;
  const days = Math.round(years * 365), step = 7;
  const xs: number[] = [];
  for (let d = 0; d <= days; d += step) xs.push(d);
  const series = BOT_NAMES.map((b) => {
    const runs = rs.filter((r) => r.opts.origin === origin && r.opts.bot === b);
    return { b, ys: xs.map((d) => med(runs.map((r) => (r.days.find((x) => x.day >= d) ?? r.days[r.days.length - 1]).earned))) };
  });
  const ymax = Math.max(AMBITION_GOAL[origin as 'traders'], ...series.flatMap((s) => s.ys.filter(Number.isFinite))) * 1.05;
  const X = (d: number) => L + (d / days) * (W - L - R), Y = (v: number) => T + (1 - v / ymax) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => Math.round((ymax * k) / 100) * 100);
  const goal = origin === 'traders' ? `<line class="goal" x1="${L}" x2="${W - R}" y1="${Y(AMBITION_GOAL.traders)}" y2="${Y(AMBITION_GOAL.traders)}"/><text class="ax" x="${W - R + 4}" y="${Y(AMBITION_GOAL.traders) + 4}">ambition</text>` : '';
  const lines = series.map((s) => `<path class="ln" style="stroke:${slot(s.b)}" d="${s.ys.map((y, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(Number.isFinite(y) ? y : 0).toFixed(1)}`).join('')}"/>`).join('');
  // Direct labels at the right end, nudged apart.
  const ends = series.map((s) => ({ b: s.b, y: Y(s.ys[s.ys.length - 1] || 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  const labels = ends.map((e) => `<text class="dl" x="${W - R + 6}" y="${e.y + 4}">${BOT_LABEL[e.b]}</text>`).join('');
  const data = JSON.stringify({ xs, series: series.map((s) => ({ name: BOT_LABEL[s.b], color: slot(s.b), ys: s.ys.map((y) => Math.round(y)) })), L, R, W, days });
  return `<svg class="chart xh" viewBox="0 0 ${W} ${H}" data-xh='${esc(data)}' role="img" aria-label="Median orrels earned over time, ${origin}">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text class="ax" x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
    ${Array.from({ length: Math.floor(years) + 1 }, (_, k) => `<text class="ax" x="${X(k * 365)}" y="${H - 8}" text-anchor="middle">${k ? `year ${k}` : 'start'}</text>`).join('')}
    ${goal}${lines}${labels}<line class="hair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg>`;
}

/** Days to the ambition, every run a dot, a row per bot; runs that never got there counted. */
function ambitionChart(rs: RunResult[], origin: string, years: number) {
  const W = 460, rowH = 30, L = 80, R = 70, T = 8, B = 24;
  const bots = BOT_NAMES.filter((b) => b !== 'idle');
  const H = T + B + rowH * bots.length, max = years * 365;
  const X = (d: number) => L + (d / max) * (W - L - R);
  let body = '';
  bots.forEach((b, i) => {
    const runs = rs.filter((r) => r.opts.origin === origin && r.opts.bot === b);
    const y = T + rowH * i + rowH / 2;
    body += `<text class="ax" x="${L - 8}" y="${y + 4}" text-anchor="end">${BOT_LABEL[b]}</text><line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
    const got = runs.filter((r) => r.ambitionDay != null);
    got.forEach((r, k) => {
      const jitter = ((k * 7) % 5 - 2) * 2.5;
      body += `<g ${tip([`${fmt(r.ambitionDay!)} days (${fmt(realSeconds(r.ambitionDay!) / 60, 1)} min at speed 2)`, `${BOT_LABEL[b]} · ${r.opts.bias} · ${r.opts.world}`])}><circle class="hitdot" cx="${X(r.ambitionDay!)}" cy="${y + jitter}" r="12"/><circle class="dot" style="fill:${slot(b)}" cx="${X(r.ambitionDay!)}" cy="${y + jitter}" r="4"/></g>`;
    });
    if (got.length) body += `<line class="medtick" x1="${X(med(got.map((r) => r.ambitionDay!)))}" x2="${X(med(got.map((r) => r.ambitionDay!)))}" y1="${y - 10}" y2="${y + 10}"/>`;
    body += `<text class="dl" x="${W - R + 6}" y="${y + 4}">${got.length}/${runs.length} got there</text>`;
  });
  for (let k = 0; k <= years; k++) body += `<text class="ax" x="${X(k * 365)}" y="${H - 6}" text-anchor="middle">${k ? `year ${k}` : 'start'}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Days to the ambition, ${origin}">${body}</svg>`;
}

/** Where the money came from, per bot: one stacked bar each (mean over runs, both origins). */
const SOURCES: [string, (k: string) => boolean][] = [
  ['Trade', (k) => k === 'trade'],
  ['Jobs', (k) => k.startsWith('job:') && k !== 'job:procure-on-the-spot' || k === 'job-site'],
  ['Supply jobs bought on the spot', (k) => k === 'job:procure-on-the-spot'],
  ['Charts', (k) => k === 'charts'],
  ['Encounters', (k) => k === 'encounters'],
];
function incomeChart(rs: RunResult[]) {
  const W = 460, rowH = 28, L = 80, R = 60, T = 6, B = 6;
  const bots = BOT_NAMES.filter((b) => b !== 'idle');
  const rows = bots.map((b) => {
    const runs = rs.filter((r) => r.opts.bot === b);
    const yrs = (r: RunResult) => Math.max(1, r.days[r.days.length - 1].day) / 365;
    return { b, parts: SOURCES.map(([, f]) => runs.reduce((a, r) => a + Object.entries(r.ledger).filter(([k]) => f(k)).reduce((x, [, v]) => x + v, 0) / yrs(r), 0) / runs.length) };
  });
  const max = Math.max(...rows.map((r) => r.parts.reduce((a, v) => a + Math.max(0, v), 0))) * 1.02;
  const H = T + B + rowH * rows.length;
  const X = (v: number) => (v / max) * (W - L - R);
  let body = '';
  rows.forEach((row, i) => {
    const y = T + rowH * i + 5;
    body += `<text class="ax" x="${L - 8}" y="${y + 13}" text-anchor="end">${BOT_LABEL[row.b]}</text>`;
    let x = L;
    row.parts.forEach((v, k) => {
      if (v <= 0) return;
      const w = Math.max(0, X(v) - 2);
      body += `<rect class="bar" ${tip([`${fmt(v)} orrels a year`, `${SOURCES[k][0]} · ${BOT_LABEL[row.b]}`])} x="${x}" y="${y}" width="${w}" height="18" rx="2" style="fill:var(--series-${k + 1})"/>`;
      x += X(v);
    });
    body += `<text class="dl" x="${x + 6}" y="${y + 13}">${fmt(row.parts.reduce((a, v) => a + v, 0))}</text>`;
  });
  return legend(SOURCES.map(([n], k) => [n, `var(--series-${k + 1})`]), 'rect') + `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Orrels a year by source">${body}</svg>`;
}

/** People lost a year: bots × home difficulty, a cell each. */
function deathsGrid(rs: RunResult[]) {
  const biases = ['gentle', 'harsh', 'inhospitable'];
  const bots = BOT_NAMES;
  const cell = (b: BotName, bias: string) => {
    const runs = rs.filter((r) => r.opts.bot === b && r.opts.bias === bias);
    const per = runs.map((r) => r.deaths.length / (Math.max(1, r.days[r.days.length - 1].day) / 365));
    return { v: per.reduce((a, x) => a + x, 0) / Math.max(1, per.length), wiped: runs.filter((r) => r.wiped != null).length, n: runs.length };
  };
  const all = bots.flatMap((b) => biases.map((x) => cell(b, x).v));
  const max = Math.max(0.5, ...all);
  const ramp = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const col = (v: number) => ramp[Math.min(ramp.length - 1, Math.floor((v / max) * (ramp.length - 1) + 1e-9))];
  return `<table class="grid-cells"><thead><tr><th></th>${biases.map((b) => `<th>${b}</th>`).join('')}</tr></thead><tbody>${bots.map((b) => `<tr><th>${BOT_LABEL[b]}</th>${biases.map((x) => {
    const c = cell(b, x), bg = col(c.v), dark = ramp.indexOf(bg) >= 3;
    return `<td ${tip([`${fmt(c.v, 2)} people lost a year`, `${c.wiped} of ${c.n} caravans wiped out`, `${BOT_LABEL[b]} · ${x}`])} style="background:${bg};color:${dark ? '#fff' : '#0b0b0b'}">${fmt(c.v, 2)}${c.wiped ? `<small>${c.wiped} wiped</small>` : ''}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

/** How often each encounter comes up, of all the road's draws. */
function encounterChart(rs: RunResult[]) {
  const count = new Map<string, number>();
  let total = 0;
  for (const r of rs) for (const e of r.encounters) { if (e.id.startsWith('find-') || e.id.startsWith('q-')) continue; count.set(e.id, (count.get(e.id) ?? 0) + 1); total++; }
  const rows = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const W = 460, rowH = 18, L = 80, R = 50, H = rows.length * rowH + 8;
  const max = Math.max(...rows.map(([, n]) => n / total));
  const X = (v: number) => (v / max) * (W - L - R);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of encounters">${rows.map(([id, n], i) => {
    const y = 4 + i * rowH, share = n / total;
    return `<text class="ax" x="${L - 8}" y="${y + 11}" text-anchor="end">${esc(id)}</text><rect class="bar" ${tip([`${fmt(share * 100, 1)}% of encounters`, `${n} drawn · ${esc(id)}`])} x="${L}" y="${y + 2}" width="${Math.max(2, X(share))}" height="12" rx="2" style="fill:var(--series-1)"/><text class="dl" x="${L + X(share) + 6}" y="${y + 12}">${fmt(share * 100, 1)}%</text>`;
  }).join('')}</svg>`;
}

/** The longest stretch with nothing to do (no arrival, card or trade), in real time at speed 2. */
function quietChart(rs: RunResult[]) {
  const bots = BOT_NAMES.filter((b) => b !== 'idle');
  const W = 460, rowH = 30, L = 80, R = 60, T = 6, H = T + rowH * bots.length + 6;
  const gaps = bots.map((b) => rs.filter((r) => r.opts.bot === b).map((r) => {
    const ev = [...r.events].sort((a, c) => a - c);
    let g = 0;
    for (let i = 1; i < ev.length; i++) g = Math.max(g, ev[i] - ev[i - 1]);
    return realSeconds(g);
  }));
  const max = Math.max(...gaps.flat()) * 1.05;
  const X = (v: number) => L + (v / max) * (W - L - R);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Longest quiet stretch">${bots.map((b, i) => {
    const y = T + i * rowH + rowH / 2, gs = gaps[i];
    return `<text class="ax" x="${L - 8}" y="${y + 4}" text-anchor="end">${BOT_LABEL[b]}</text><line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>
      <line class="range" x1="${X(q(gs, 0.1))}" x2="${X(q(gs, 0.9))}" y1="${y}" y2="${y}"/>
      <g ${tip([`${fmt(med(gs))} s median (10%–90%: ${fmt(q(gs, 0.1))}–${fmt(q(gs, 0.9))} s)`, `${BOT_LABEL[b]}, at speed 2`])}><circle class="hitdot" cx="${X(med(gs))}" cy="${y}" r="12"/><circle class="dot" style="fill:${slot(b)}" cx="${X(med(gs))}" cy="${y}" r="5"/></g>
      <text class="dl" x="${W - R + 6}" y="${y + 4}">${fmt(med(gs))} s</text>`;
  }).join('')}</svg>`;
}

function table(rs: RunResult[]) {
  const keys = [...new Set(rs.map((r) => `${r.opts.origin}|${r.opts.bot}|${r.opts.bias}`))];
  return `<table class="data"><thead><tr><th>Origin</th><th>Bot</th><th>Home</th><th>Runs</th><th>Earned, year 1 (median)</th><th>Days to ambition (median)</th><th>Got there</th><th>Lost a year</th><th>Wiped</th><th>Trips a year</th></tr></thead><tbody>${keys.map((k) => {
    const [o, b, x] = k.split('|');
    const runs = rs.filter((r) => r.opts.origin === o && r.opts.bot === b && r.opts.bias === x);
    const amb = runs.map((r) => r.ambitionDay).filter((v): v is number => v != null);
    const yrs = (r: RunResult) => Math.max(1, r.days[r.days.length - 1].day) / 365;
    return `<tr><td>${o}</td><td>${BOT_LABEL[b as BotName]}</td><td>${x}</td><td>${runs.length}</td><td>${fmt(med(runs.map((r) => (r.days.find((d) => d.day >= 365) ?? r.days[r.days.length - 1]).earned)))}</td><td>${fmt(med(amb))}</td><td>${amb.length}/${runs.length}</td><td>${fmt(med(runs.map((r) => r.deaths.length / yrs(r))), 2)}</td><td>${runs.filter((r) => r.wiped != null).length}</td><td>${fmt(med(runs.map((r) => r.trips / yrs(r))), 1)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

export function report(rs: RunResult[], meta: { worlds: string[]; runs: number; years: number; when: string; note?: string }): string {
  const traders = rs.filter((r) => r.opts.origin === 'traders' && r.opts.bot === 'trader' && r.ambitionDay != null).map((r) => r.ambitionDay!);
  const careful = rs.filter((r) => ['trader', 'explorer', 'jobber'].includes(r.opts.bot));
  const lost = careful.reduce((a, r) => a + r.deaths.length, 0) / careful.reduce((a, r) => a + Math.max(1, r.days[r.days.length - 1].day) / 365, 0);
  const reckless = rs.filter((r) => r.opts.bot === 'reckless');
  const supply = rs.reduce((a, r) => a + r.deaths.filter((d) => d.cause === 'supplies').length, 0);
  const tiles = [
    [`${fmt(med(traders))} days`, `a careful trader's median to the ${fmt(AMBITION_GOAL.traders)}-orrel ambition: ${fmt(realSeconds(med(traders)) / 60, 1)} minutes of clock at speed 2`],
    [`${fmt(lost, 2)}`, 'people lost a year by the careful bots (trader, explorer, jobber)'],
    [`${reckless.filter((r) => r.wiped != null).length} of ${reckless.length}`, 'reckless caravans wiped out'],
    [`${supply}`, 'deaths from hunger or thirst (the rules say none)'],
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Primundi playtest</title><style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f4f3f0;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#77766f;--rule:#e4e2dc;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#9a998f;--rule:#383835;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181}}
body{margin:0;font:14px/1.45 system-ui,sans-serif}
.viz-root{background:var(--surface-1);color:var(--text-primary);padding:24px;min-height:100vh;box-sizing:border-box}
h1{font-size:22px;margin:0 0 4px}h3{font-size:15px;margin:0 0 2px}.sub,.meta{color:var(--text-secondary);margin:0 0 10px;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0 20px}
.tile{background:var(--surface-2);border-radius:8px;padding:12px 14px}.tile b{display:block;font-size:26px;font-weight:600}.tile span{color:var(--text-secondary);font-size:13px}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px}
.panel{background:var(--surface-2);border-radius:8px;padding:14px}
.chart{width:100%;height:auto;display:block;overflow:visible}
.grid{stroke:var(--rule);stroke-width:1}.ax{fill:var(--text-muted);font-size:11px}.dl{fill:var(--text-secondary);font-size:11px}
.ln{fill:none;stroke-width:2;stroke-linejoin:round}.goal{stroke:var(--text-muted);stroke-dasharray:4 4}
.hair{stroke:var(--text-muted);stroke-width:1}.hit,.hitdot{fill:transparent}.dot{stroke:var(--surface-2);stroke-width:2}
.medtick{stroke:var(--text-primary);stroke-width:2}.range{stroke:var(--text-muted);stroke-width:2}
.bar:hover,.bar:focus,g:hover>.dot,g:focus>.dot{opacity:.8;outline:none}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 8px;font-size:12px;color:var(--text-secondary)}
.legend i{display:inline-block;margin-right:6px;vertical-align:middle;background:var(--c)}.legend i.rect{width:10px;height:10px;border-radius:2px}.legend i.line{width:14px;height:2px}
table{border-collapse:collapse;font-size:12px}.grid-cells td{width:110px;height:38px;text-align:center;border:2px solid var(--surface-2);border-radius:4px;font-variant-numeric:tabular-nums}
.grid-cells td small{display:block;font-size:10px;opacity:.85}.grid-cells th{font-weight:500;color:var(--text-secondary);padding:4px 8px;text-align:right}
.data th,.data td{padding:4px 8px;border-bottom:1px solid var(--rule);text-align:right}.data th:nth-child(-n+3),.data td:nth-child(-n+3){text-align:left}
details{margin-top:20px}summary{cursor:pointer;color:var(--text-secondary)}
#tip{position:fixed;pointer-events:none;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--rule);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px #0003;white-space:pre;display:none;z-index:9}
#tip b{font-size:13px}#tip .row{display:flex;gap:6px;align-items:center}#tip .row i{width:12px;height:2px;display:inline-block}
</style></head><body><div class="viz-root">
<h1>Primundi playtest</h1>
<p class="meta">${rs.length} games: ${meta.worlds.map(esc).join(', ')} · both origins · three home difficulties · five bots · ${meta.runs} runs each · ${meta.years} game-years · ${esc(meta.when)}. A game-year is ${fmt(realSeconds(365) / 60, 1)} minutes of clock at speed 2 (town time not counted: the clock stops in a town).${meta.note ? ` ${esc(meta.note)}` : ''}</p>
<div class="tiles">${tiles.map(([v, t]) => `<div class="tile"><b>${v}</b><span>${t}</span></div>`).join('')}</div>
<div class="panels">
${panel('Orrels earned, Traders', 'Median over runs. The dashed line is the Traders\' ambition.', legend(BOT_NAMES.map((b) => [BOT_LABEL[b], slot(b)]), 'line') + earnedChart(rs, 'traders', meta.years))}
${panel('Orrels earned, Cartographers', 'Median over runs. Their ambition is hexes charted, not orrels.', legend(BOT_NAMES.map((b) => [BOT_LABEL[b], slot(b)]), 'line') + earnedChart(rs, 'cartographers', meta.years))}
${panel('Days to the Traders\' ambition', `${fmt(AMBITION_GOAL.traders)} orrels earned. Each dot a game; the bar is the median.`, ambitionChart(rs, 'traders', meta.years))}
${panel('Days to the Cartographers\' ambition', `${fmt(AMBITION_GOAL.cartographers)} hexes charted.`, ambitionChart(rs, 'cartographers', meta.years))}
${panel('Where the money comes from', 'Orrels a year by source, mean over every game of each bot.', incomeChart(rs))}
${panel('People lost a year', 'Mean per game, by bot and home. Deeper blue, more lost.', deathsGrid(rs))}
${panel('What the road brings', 'Share of road encounters drawn, all games (finds and job sites left out).', encounterChart(rs))}
${panel('The longest wait', 'Each game\'s longest stretch with nothing to do (no arrival, card or trade), in seconds of clock at speed 2. Dot the median, line 10% to 90%.', quietChart(rs))}
</div>
<details><summary>Table view: every number</summary>${table(rs)}</details>
<div id="tip" role="status"></div>
</div><script>
const tipEl = document.getElementById('tip');
const show = (html, x, y) => { tipEl.innerHTML = html; tipEl.style.display = 'block'; const r = tipEl.getBoundingClientRect(); tipEl.style.left = Math.min(innerWidth - r.width - 8, x + 14) + 'px'; tipEl.style.top = Math.max(8, y - r.height - 10) + 'px'; };
const hide = () => { tipEl.style.display = 'none'; };
const text = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
for (const el of document.querySelectorAll('[data-tip]')) {
  const html = () => { const [v, ...rest] = el.dataset.tip.split('\\n'); return '<b>' + text(v) + '</b>' + rest.map((l) => '<div>' + text(l) + '</div>').join(''); };
  el.addEventListener('pointermove', (e) => show(html(), e.clientX, e.clientY));
  el.addEventListener('pointerleave', hide);
  el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(html(), r.right, r.top); });
  el.addEventListener('blur', hide);
}
for (const svg of document.querySelectorAll('svg.xh')) {
  const d = JSON.parse(svg.dataset.xh), hair = svg.querySelector('.hair'), hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const day = Math.max(0, Math.min(d.days, (p.x - d.L) / (d.W - d.L - d.R) * d.days));
    let i = 0; for (let k = 0; k < d.xs.length; k++) if (Math.abs(d.xs[k] - day) < Math.abs(d.xs[i] - day)) i = k;
    const x = d.L + d.xs[i] / d.days * (d.W - d.L - d.R);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('visibility', 'visible');
    const rows = d.series.map((s) => ({ s, v: s.ys[i] })).sort((a, b) => b.v - a.v);
    show('<div>Day ' + d.xs[i] + '</div>' + rows.map(({ s, v }) => '<div class="row"><i style="background:' + s.color + '"></i><b>' + v.toLocaleString() + '</b> ' + text(s.name) + '</div>').join(''), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => { hide(); hair.setAttribute('visibility', 'hidden'); });
}
</script></body></html>`;
}
