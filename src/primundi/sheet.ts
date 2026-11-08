/**
 * The crew's papers and roster (decision 2026-11-08): one sheet per person, a roster for the
 * team. Three layouts to compare live (Bill picks one, the rest go): traveller's papers (a card
 * each), a roster grid with the sheet below, and a ledger page. A small globe of the hexes each
 * person has walked sits behind a toggle, until Bill has seen how it plays.
 *
 * Pure HTML from the caravan; main.ts puts it in the journal and draws the globes.
 */
import { best, crewSheet, SKILLS, SKILL_MAX, SKILL_NAMES, TRAITS, type Caravan, type Member, type Stat } from './caravan.ts';
import { bornStats } from './crew.ts';

export type Layout = 'papers' | 'roster' | 'ledger';
export const LAYOUTS: [Layout, string][] = [['papers', 'Papers'], ['roster', 'Roster'], ['ledger', 'Ledger']];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const chip = (x: Stat) => `<span class="st${x.good === true ? ' up' : x.good === false ? ' dn' : ''}">${esc(x.k)} <b>${esc(x.v)}</b></span>`;
const chips = (xs: Stat[]) => `<span class="chips">${xs.map(chip).join('')}</span>`;
/** ●●●○○ */
export const pips = (n: number, top = false) => `<span class="pips${top ? ' top' : ''}" title="${n} of ${SKILL_MAX}">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(SKILL_MAX - n)}</span>`;

export interface SheetCtx {
  c: Caravan;
  day: number;
  /** A place's name, by id. */
  place(pid: number): string;
  globe: boolean;
}
const from = (m: Member, x: SheetCtx) => m.born ? `${esc(x.place(m.born.pid))}${m.born.trade ? ` · ${esc(m.born.trade)}` : ''} · ${esc(m.born.land)}` : 'met on the road';
const days = (m: Member, x: SheetCtx) => { const d = Math.max(0, Math.floor(x.day - m.joined)); return `${d} day${d === 1 ? '' : 's'} with you`; };
const tags = (m: Member) => `${m.lead ? '<span class="tag lead">Leader</span>' : ''}${m.health !== 'well' ? `<span class="tag hp">${m.health}</span>` : ''}`;
/** Who's the caravan's best at each skill (the one who does the task). */
const tops = (c: Caravan) => Object.fromEntries(SKILLS.map((k) => [k, best(c, k)])) as Record<string, number>;
const traitStats = (m: Member): Stat[] => [
  ...(m.trait === 'cheerful' ? [{ k: 'Spirits', v: '+0.5/day', good: true }] : []),
  ...(m.trait === 'steady' ? [{ k: 'Mends', v: '×1.5', good: true }] : []),
  ...(m.trait === 'frugal' ? [{ k: 'Eats', v: '−30%', good: true }] : []),
];
const traitName = (m: Member) => m.trait ? TRAITS[m.trait].split(':')[0] : '';
const globe = (m: Member, i: number, x: SheetCtx) => x.globe ? `<canvas class="globe" data-m="${i}" width="112" height="112" title="Where ${esc(m.name)} has walked: ${m.walked?.length ?? 0} hexes"></canvas>` : '';

/** One person's full sheet: the papers. */
export function sheet(m: Member, i: number, x: SheetCtx): string {
  const t = tops(x.c);
  return `<div class="pc" data-m="${i}">
    <div class="pc-head"><div><b>${esc(m.name)}</b>${tags(m)}<small>${from(m, x)} · ${days(m, x)}</small></div>${globe(m, i, x)}</div>
    <div class="pc-skills">${SKILLS.map((k) => `<span class="sk${m.skills[k] === t[k] && m.skills[k] > 1 && m.health === 'well' ? ' best' : ''}"><em>${SKILL_NAMES[k]}</em>${pips(m.skills[k])}</span>`).join('')}</div>
    <dl>
      <dt>Born</dt><dd>${m.born ? chips(bornStats(m)) : '<span class="dim">—</span>'}</dd>
      ${m.trait ? `<dt>${esc(traitName(m))}</dt><dd>${chips(traitStats(m))}</dd>` : ''}
      <dt>Marks</dt><dd class="dim">None yet. Deeds on the road earn them.</dd>
      <dt>Bond</dt><dd class="dim">—</dd>
    </dl>
  </div>`;
}

/** The caravan's totals, under every layout. */
const totals = (c: Caravan) => `<div class="sheet"><span class="lab">The caravan</span>${crewSheet(c).map(chip).join('')}</div>`;

/** The crew tab, in a layout. `sel` is the roster's chosen row. */
export function crewHtml(layout: Layout, x: SheetCtx, sel: number): string {
  const c = x.c, people = c.members.map((m, i) => ({ m, i })).filter((p) => p.m.alive);
  const t = tops(c);
  const lay = `<nav class="lay">${LAYOUTS.map(([k, l]) => `<button data-act="layout" data-l="${k}" class="${k === layout ? 'on' : ''}">${l}</button>`).join('')}
    <label class="gl"><input type="checkbox" data-act="globe" ${x.globe ? 'checked' : ''}> Globes</label></nav>`;
  let body = '';
  if (layout === 'papers') {
    body = `<div class="papers">${people.map((p) => sheet(p.m, p.i, x)).join('')}</div>`;
  } else if (layout === 'roster') {
    const s = people.find((p) => p.i === sel) ?? people[0];
    body = `<table class="roster"><thead><tr><th></th>${SKILLS.map((k) => `<th>${SKILL_NAMES[k]}</th>`).join('')}</tr></thead><tbody>
      ${people.map((p) => `<tr data-act="pick" data-i="${p.i}" class="${p === s ? 'on' : ''}"><td><b>${esc(p.m.name)}</b>${tags(p.m)}</td>
        ${SKILLS.map((k) => `<td class="${p.m.skills[k] === t[k] && p.m.skills[k] > 1 && p.m.health === 'well' ? 'best' : ''}">${pips(p.m.skills[k])}</td>`).join('')}</tr>`).join('')}
      </tbody></table>${s ? sheet(s.m, s.i, x) : ''}`;
  } else {
    body = `<ol class="ledger">${people.map((p) => {
      const sk = SKILLS.map((k) => `${SKILL_NAMES[k]} <b class="${p.m.skills[k] === t[k] && p.m.skills[k] > 1 ? 'best' : ''}">${p.m.skills[k]}</b>`).join(' · ');
      const born = bornStats(p.m).map((b) => `${b.k} ${b.v}`).join(', ');
      return `<li data-m="${p.i}"><div class="lg-head"><b>${esc(p.m.name)}</b>${tags(p.m)}<small>${from(p.m, x)} · ${days(p.m, x)}</small></div>
        <div class="lg-sk">${sk}</div>
        <div class="lg-more">${born ? `Born: ${esc(born)}.` : ''}${p.m.trait ? ` ${esc(TRAITS[p.m.trait])}.` : ''} Marks: none yet.</div>${globe(p.m, p.i, x)}</li>`;
    }).join('')}</ol>`;
  }
  return `${lay}${totals(c)}${body}`;
}
