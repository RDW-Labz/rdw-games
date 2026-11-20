#!/usr/bin/env node
// Core test for the NPC Forge port (RPG NPC Generator card).
// Slices the // >>>CORE block out of the shipped HTML, runs it as a module, and asserts the
// generator's invariants — then finds a seed that rolls a legendary sheet for the gate to load.
// usage: node npc-forge-core-test.mjs [port-html]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/rpg-npc-generator/index.html';
const html = await readFile(SRC, 'utf8');
const start = html.indexOf('// >>>CORE');
const end = html.indexOf('// <<<CORE');
if (start < 0 || end < 0 || end <= start) { console.error('no CORE block'); process.exit(1); }
const core = html.slice(start, end);
const extra = `
export { FIELDS, FIELD_LABEL, STAT_KEYS, RARITY_RANK, rollField, rollStats, buildNpc, modOf, rarityOf, mulberry32, hashMix, PROFS, RACES };
`;
const tmp = join(tmpdir(), `npc-core-${process.pid}.mjs`);
await writeFile(tmp, core + extra);
const M = await import(pathToFileURL(tmp).href);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL', msg); } };
const T = (m) => console.error('  ' + m);

// 1. every field is populated and comes from its own table for a spread of seeds
const seen = {};
for (let i = 0; i < M.FIELDS.length; i++) seen[i] = new Set();
for (let s = 1; s <= 400; s++) {
  const npc = M.buildNpc(s);
  for (let i = 0; i < M.FIELDS.length; i++) {
    const v = npc.fields[i];
    ok(typeof v === 'string' && v.trim().length > 0, `seed ${s} field ${M.FIELDS[i]} empty`);
    ok(!/undefined|NaN/.test(v), `seed ${s} field ${M.FIELDS[i]} junk: ${v}`);
    seen[i].add(v);
  }
  // stats in range, modifiers consistent
  for (const k of M.STAT_KEYS) {
    ok(npc.stats[k] >= 3 && npc.stats[k] <= 20, `seed ${s} stat ${k}=${npc.stats[k]} out of range`);
    ok(M.modOf(npc.stats[k]) === Math.floor((npc.stats[k] - 10) / 2), `mod mismatch ${k}`);
  }
  ok(npc.ac >= 6 && npc.ac <= 24, `seed ${s} ac ${npc.ac}`);
  ok(npc.hp >= 3 && npc.hp <= 80, `seed ${s} hp ${npc.hp}`);
  ok(M.RARITY_RANK[npc.rarity] !== undefined, `seed ${s} unknown rarity ${npc.rarity}`);
}
for (let i = 0; i < M.FIELDS.length; i++) ok(seen[i].size >= (M.FIELDS[i] === 'gender' ? 3 : 4), `field ${M.FIELDS[i]} has only ${seen[i].size} distinct values`);
T(`400 seeds · distinct values per plate: ${M.FIELDS.map((f, i) => f + '=' + seen[i].size).join(' ')}`);

// 2. determinism: same seed rebuilds the identical sheet
const a = M.buildNpc(123456), b = M.buildNpc(123456);
ok(JSON.stringify(a) === JSON.stringify(b), 'buildNpc not deterministic for one seed');

// 3. a plate re-roll moves only that plate
const base = M.buildNpc(4242);
const moved = M.buildNpc(4242, [0, 0, 1, 0, 0, 0, 0, 0]);
ok(moved.fields[2] !== base.fields[2], 'profession re-roll did not change the profession');
let otherSame = true;
for (let i = 0; i < M.FIELDS.length; i++) if (i !== 2 && moved.fields[i] !== base.fields[i]) otherSame = false;
ok(otherSame, 'a profession re-roll moved other plates');
// and the profession's ability boost is really applied
const profName = base.fields[2];
const prof = M.PROFS.find((p) => p[0] === profName);
ok(!!prof, 'rolled profession not in the table');
T(`plate re-roll is isolated · profession "${profName}" boosts ${JSON.stringify(prof[2])}`);

// 4. rerolling the same plate repeatedly keeps producing valid sheets
for (let n = 0; n < 30; n++) {
  const r = M.buildNpc(999, [n, 0, 0, n, 0, 0, n, 0]);
  ok(r.fields[0].length > 2 && r.fields[3].includes('·'), `reroll ${n} produced junk`);
}

// 5. rarity tracks the stat total
for (let s = 1; s <= 200; s++) {
  const npc = M.buildNpc(s);
  const total = M.STAT_KEYS.reduce((x, k) => x + npc.stats[k], 0);
  ok(total === npc.total, `total mismatch seed ${s}`);
  ok(M.rarityOf(npc.total, npc.cr) === npc.rarity, `rarity mismatch seed ${s}`);
}
// monotone: a higher total can never read rarer
let sorted = true;
for (let t = 18; t <= 120; t++) {
  const r0 = M.RARITY_RANK[M.rarityOf(t, Math.max(0, Math.round((t - 58) / 7)))];
  const r1 = M.RARITY_RANK[M.rarityOf(t + 1, Math.max(0, Math.round((t + 1 - 58) / 7)))];
  if (r1 < r0) { sorted = false; break; }
}
ok(sorted, 'rarity is not monotone in the stat total');

// 6. there is a legendary seed, and it is rare-but-reachable
let legendary = null, count = 0;
const N = 20000;
for (let s = 1; s <= N; s++) {
  const npc = M.buildNpc(s);
  if (npc.rarity === 'legendary') { count++; if (legendary == null) legendary = s; }
}
ok(count > 0, `no legendary sheet in ${N} seeds`);
const rate = count / N;
ok(rate > 0.0005 && rate < 0.05, `legendary rate ${(rate * 100).toFixed(3)}% is outside 0.05%..5%`);
T(`legendary: ${count}/${N} seeds (${(rate * 100).toFixed(2)}%), first at seed ${legendary}`);

// 7. and a common one for the rarity spread check
let commons = 0;
for (let s = 1; s <= 2000; s++) if (M.buildNpc(s).rarity === 'common') commons++;
ok(commons > 20, `only ${commons} common sheets in 2000: the rarity ladder is skewed`);

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log(`OK · legendary seed ${legendary} · ${M.FIELDS.length} plates · rarity spread ok`);
