#!/usr/bin/env node
// Core test for the Mahjong Solitaire port. Slices the `// >>>CORE` block out of the shipped
// HTML and exercises it exactly as the browser does: the layout, the free-tile rule, and the
// by-construction deal. Refuses a layout or a deal that cannot be cleared.
// usage: node scripts/mahjong-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = resolve(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/mahjong-solitaire/index.html');
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL: no >>>CORE block in ' + FILE); process.exit(1); }

const src = m[1] + '\nexport { KINDS, buildSlots, freeAt, freeList, findPair, deal };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { KINDS, buildSlots, freeAt, freeList, findPair, deal } = mod;

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const slots = buildSlots();
ok(slots.length === 136, `layout has ${slots.length} slots, expected 136`);

// layer census, so a layout edit that silently drops a tier is caught
const layers = {};
for (const s of slots) layers[s.z] = (layers[s.z] || 0) + 1;
ok(JSON.stringify(layers) === JSON.stringify({ 0: 72, 1: 40, 2: 16, 3: 6, 4: 2 }),
  'layer census mismatch: ' + JSON.stringify(layers));

// no duplicate slot positions
const seen = new Set();
for (const s of slots) { const k = `${s.x}/${s.y}/${s.z}`; ok(!seen.has(k), 'duplicate slot ' + k); seen.add(k); }

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let deals = 0;
for (const seed of [1, 7, 42, 99, 1234, 2026]) {
  const d = deal(slots, mulberry32(seed));
  if (!d) { fails.push(`deal(seed ${seed}) returned null`); continue; }
  deals++;

  // 34 kinds, four tiles each, and every pair shares a kind
  const count = {};
  for (const k of d.kind) count[k] = (count[k] || 0) + 1;
  ok(Object.keys(count).length === KINDS, `seed ${seed}: ${Object.keys(count).length} kinds, expected ${KINDS}`);
  ok(Object.values(count).every((c) => c === 4), `seed ${seed}: not every kind appears four times`);
  ok(d.order.length === 68, `seed ${seed}: ${d.order.length} pairs, expected 68`);

  // replay the recorded order against the same free-tile rule the browser uses
  const live = new Uint8Array(slots.length).fill(1);
  let step = 0;
  for (const [a, b] of d.order) {
    if (!live[a] || !live[b]) { fails.push(`seed ${seed}: pair ${step} reuses a removed tile`); break; }
    if (!freeAt(live, slots, a)) { fails.push(`seed ${seed}: pair ${step} tile ${a} not free`); break; }
    if (!freeAt(live, slots, b)) { fails.push(`seed ${seed}: pair ${step} tile ${b} not free`); break; }
    if (d.kind[a] !== d.kind[b]) { fails.push(`seed ${seed}: pair ${step} kinds differ`); break; }
    live[a] = 0; live[b] = 0;
    step++;
  }
  ok(step === 68, `seed ${seed}: replayed ${step} of 68 pairs`);
  ok(live.every((v) => v === 0), `seed ${seed}: tiles left after replay`);

  // a fresh deal must offer a real opening choice, not a forced single move
  const fresh = new Uint8Array(slots.length).fill(1);
  const opening = freeList(fresh, slots).length;
  ok(opening >= 8, `seed ${seed}: only ${opening} free tiles at the start`);

  // a pair must exist on the fresh board
  ok(!!findPair(fresh, d.kind, slots), `seed ${seed}: no free matching pair at the start`);
}
ok(deals === 6, 'not every seed dealt');

// stuck detection: two free tiles of different kinds have no pair left
const stuckLive = new Uint8Array(slots.length).fill(0);
const stuckKind = new Int8Array(slots.length).fill(-1);
const freeTop = slots.map((s, i) => i).filter((i) => i > 130);
stuckLive[freeTop[0]] = 1; stuckKind[freeTop[0]] = 0;
stuckLive[freeTop[1]] = 1; stuckKind[freeTop[1]] = 1;
ok(freeAt(stuckLive, slots, freeTop[0]) && freeAt(stuckLive, slots, freeTop[1]), 'stuck probe tiles are not free');
ok(findPair(stuckLive, stuckKind, slots) === null, 'stuck probe wrongly reports a pair');

// a matched pair on an otherwise empty board must read as cleared
stuckKind[freeTop[1]] = 0;
ok(!!findPair(stuckLive, stuckKind, slots), 'single free pair not detected');

if (fails.length) {
  console.log('CORE FAIL\n - ' + fails.slice(0, 10).join('\n - '));
  process.exit(1);
}
console.log(`CORE PASS — 136 slots (5 layers), ${deals} deals replayed to an empty pile, stuck/pair detection OK`);
