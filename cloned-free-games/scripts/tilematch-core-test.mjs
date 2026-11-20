#!/usr/bin/env node
// Core test for the Tile Match port. Slices the `// >>>CORE` block out of the shipped HTML and
// exercises it exactly as the browser does: the three-layer layout, the "nothing on top" free
// rule, the by-construction deal, and the bar rules. Refuses a layout that covers itself in the
// wrong places or a deal that cannot be won without filling the bar.
// usage: node scripts/tilematch-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = resolve(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/tile-match/index.html');
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL: no >>>CORE block in ' + FILE); process.exit(1); }

const src = m[1] + '\nexport { KINDS, CAP, buildSlots, coveredAt, freeAt, freeList, deal, trayInsert, replay };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { KINDS, CAP, buildSlots, coveredAt, freeAt, freeList, deal, trayInsert, replay } = mod;

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const slots = buildSlots();
const N = slots.length;
ok(N === 78, `layout has ${N} slots, expected 78`);
ok(N % 3 === 0, `layout size ${N} is not a whole number of triples`);

// layer census, so a layout edit that silently drops a tier is caught
const layers = {};
for (const s of slots) layers[s.z] = (layers[s.z] || 0) + 1;
ok(JSON.stringify(layers) === JSON.stringify({ 0: 40, 1: 28, 2: 10 }),
  'layer census mismatch: ' + JSON.stringify(layers));

// no duplicate slot positions
const seen = new Set();
for (const s of slots) {
  const k = `${s.x}/${s.y}/${s.z}`;
  ok(!seen.has(k), 'duplicate slot ' + k);
  seen.add(k);
}

// every slot must be reachable: from a full pile the top layer is free and the bottom is covered
const full = new Uint8Array(N).fill(1);
const top = [], bottom = [];
for (let i = 0; i < N; i++) (slots[i].z === 2 ? top : slots[i].z === 0 ? bottom : []).push(i);
ok(top.length === 10 && bottom.length === 40, 'layer slices are wrong');
ok(top.every((i) => freeAt(full, slots, i)), 'a top-layer tile reads as covered on a full pile');
ok(bottom.every((i) => !freeAt(full, slots, i)), 'a bottom-layer tile reads as free under a full pile');
const opening = freeList(full, slots);
ok(opening.length >= 10, `opening offers only ${opening.length} free tiles`);
ok(top.every((i) => opening.includes(i)), 'a top-layer tile is missing from the opening list');

// lifting the cover must free the tile underneath: clear every higher tile above one bottom slot
const probe = bottom.find((i) => coveredAt(full, slots, i));
const covered = slots.map((s, j) => j).filter((j) => slots[j].z > slots[probe].z &&
  Math.abs(slots[j].x - slots[probe].x) < 2 && Math.abs(slots[j].y - slots[probe].y) < 2);
ok(covered.length >= 1, 'probe bottom tile has no cover, so the cover rule proves nothing');
const lifted = full.slice();
for (const j of covered) lifted[j] = 0;
ok(freeAt(lifted, slots, probe), 'bottom tile stays covered after its cover is removed');

// bar rules: same kinds group, three clear, a seventh of a different kind fills the bar
{
  const t = [];
  ok(trayInsert(t, 3) === false && t.length === 1, 'first tile did not land in an empty bar');
  ok(trayInsert(t, 5) === false && t[1] === 5, 'second kind did not append');
  ok(trayInsert(t, 3) === false && JSON.stringify(t) === JSON.stringify([3, 3, 5]), 'same kind did not group: ' + JSON.stringify(t));
  ok(trayInsert(t, 3) === true && JSON.stringify(t) === JSON.stringify([5]), 'three of a kind did not clear: ' + JSON.stringify(t));
  const full7 = [0, 1, 2, 3, 4, 5, 6];
  ok(full7.length === CAP, 'test bar is not CAP long');
  ok(new Set(full7).size === CAP, 'test bar repeats a kind, so it would clear');
}

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let deals = 0;
for (const seed of [1, 7, 42, 99, 1234, 2026, 777777]) {
  const d = deal(slots, mulberry32(seed));
  if (!d) { fails.push(`deal(seed ${seed}) returned null`); continue; }
  deals++;

  // every kind is dealt in whole triples
  const count = {};
  for (const k of d.kind) count[k] = (count[k] || 0) + 1;
  ok(Object.values(count).every((c) => c % 3 === 0), `seed ${seed}: a kind is not a whole number of triples`);
  ok(Object.keys(count).length === KINDS, `seed ${seed}: ${Object.keys(count).length} kinds used, expected ${KINDS}`);
  ok(d.order.length === N, `seed ${seed}: peel order has ${d.order.length} of ${N} tiles`);

  // the order must be a legal play order: each tile free at the moment it is taken
  const live = new Uint8Array(N).fill(1);
  let step = 0;
  for (const i of d.order) {
    if (!live[i]) { fails.push(`seed ${seed}: step ${step} retakes a removed tile`); break; }
    if (!freeAt(live, slots, i)) { fails.push(`seed ${seed}: step ${step} tile ${i} is not free`); break; }
    live[i] = 0;
    step++;
  }
  ok(step === N, `seed ${seed}: replayed ${step} of ${N} tiles`);
  ok(live.every((v) => v === 0), `seed ${seed}: tiles left after replay`);

  // and playing it must win without ever filling the bar
  const r = replay(d.order, d.kind, CAP);
  ok(r.cleared === N / 3, `seed ${seed}: ${r.cleared} triples cleared, expected ${N / 3}`);
  ok(r.lost === false, `seed ${seed}: the peel order fills the bar`);
  ok(r.left === 0, `seed ${seed}: bar not empty at the end`);
  ok(r.peak <= 3, `seed ${seed}: bar peaked at ${r.peak}`);
}
ok(deals === 7, 'not every seed dealt');

// the bar can genuinely be filled: seven different kinds is a loss
{
  const r = replay([0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], CAP);
  ok(r.lost === true && r.left === CAP, 'seven different kinds did not fill the bar');
  const t = [];
  for (const k of [0, 1, 2, 3, 4, 5, 6]) trayInsert(t, k);
  ok(t.length === CAP, 'bar did not reach CAP');
}

if (fails.length) {
  console.log('CORE FAIL\n - ' + fails.slice(0, 10).join('\n - '));
  process.exit(1);
}
console.log(`CORE PASS — ${N} slots (3 layers), ${deals} deals replayed to an empty board, bar rules and cover rule OK`);
