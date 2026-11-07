/**
 * Primundi's playtest: bots play the game headless (scripts/playtest/run.ts) across worlds,
 * origins, home difficulties and styles, and the results go to test/playtest/ (gitignored):
 * results.json, and report.html (scripts/playtest/report.ts).
 *
 *   npm run playtest                       the full batch
 *   node scripts/playtest.ts --quick       one world, one run each, a year
 *   options: --worlds a,b,c  --runs N  --years N  --bots trader,idle
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { playRun, worldFor, BOT_NAMES, type BotName, type RunResult } from './playtest/run.ts';
import { report } from './playtest/report.ts';
import type { Origin } from '../src/primundi/caravan.ts';
import type { StartBias } from '../src/primundi/start.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const quick = process.argv.includes('--quick');
const worldNames = arg('worlds', quick ? 'zalund' : 'zalund,orvesk,tamberlyn').split(',');
const runs = Number(arg('runs', quick ? '1' : '3'));
const years = Number(arg('years', quick ? '1' : '3'));
const bots = arg('bots', BOT_NAMES.join(',')).split(',') as BotName[];
const origins: Origin[] = ['traders', 'cartographers'];
const biases: StartBias[] = ['gentle', 'harsh', 'inhospitable'];

const out = 'test/playtest';
mkdirSync(out, { recursive: true });
const results: RunResult[] = [];
const t0 = performance.now();
for (const name of worldNames) {
  const t = performance.now();
  worldFor(name);
  console.log(`world ${name}: ${Math.round(performance.now() - t)} ms`);
  for (const origin of origins) for (const bias of biases) for (const bot of bots) for (let run = 0; run < runs; run++) {
    results.push(playRun({ world: name, origin, bias, bot, run, years }));
  }
}
console.log(`${results.length} runs in ${Math.round((performance.now() - t0) / 1000)} s`);
writeFileSync(`${out}/results.json`, JSON.stringify(results));
writeFileSync(`${out}/report.html`, report(results, { worlds: worldNames, runs, years, when: new Date().toISOString().slice(0, 16).replace('T', ' '), note: arg('note', '') }));
console.log(`report: ${out}/report.html`);

// A summary to read in the terminal.
const med = (xs: number[]) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '-');
for (const origin of origins) {
  console.log(`\n${origin}`);
  console.log('bot        bias          earned@1y  ambition(d)  reached  deaths/y  wiped  trips/y  stuck');
  for (const bot of bots) for (const bias of biases) {
    const rs = results.filter((r) => r.opts.origin === origin && r.opts.bot === bot && r.opts.bias === bias);
    if (!rs.length) continue;
    const at1 = rs.map((r) => (r.days.find((d) => d.day >= 365) ?? r.days[r.days.length - 1]).earned);
    const amb = rs.map((r) => r.ambitionDay).filter((x): x is number => x != null);
    const yrs = rs.map((r) => Math.max(1, r.days[r.days.length - 1].day) / 365);
    console.log(`${bot.padEnd(10)} ${bias.padEnd(13)} ${String(r1(med(at1))).padStart(9)}  ${String(r1(med(amb))).padStart(11)}  ${String(amb.length).padStart(3)}/${rs.length}  ${String(r1(med(rs.map((r, i) => r.deaths.length / yrs[i])))).padStart(8)}  ${String(rs.filter((r) => r.wiped != null).length).padStart(5)}  ${String(r1(med(rs.map((r, i) => r.trips / yrs[i])))).padStart(7)}  ${r1(med(rs.map((r) => r.stuck)))}`);
  }
}
const supply = results.flatMap((r) => r.deaths.filter((d) => d.cause === 'supplies'));
console.log(`\ndeaths from supplies (must be 0): ${supply.length}`);
