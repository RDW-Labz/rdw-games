#!/usr/bin/env node
// Core test for the Six Shooter port. Slices the // >>>CORE block out of the SHIPPED html and
// proves the draw machine with the exact code the browser runs: the deal, the landing, the
// resolve, and the elimination step that ends the game on the last cartridge.
//
// usage: node six-shooter-core-test.mjs [path to index.html]
import { readFile } from 'node:fs/promises';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/six-shooter/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + FILE); process.exit(1); }
const dir = mkdtempSync('/tmp/six-core-');
const mod = join(dir, 'core.mjs');
writeFileSync(mod, m[1] + '\nexport { CHAMBERS, mulberry32, landing, ownerOf, resolve, deal, defaultSlots, elimStep, countLeft };\n');
const C = await import(mod);

let fails = 0;
const ok = (c, msg, extra) => {
  if (c) { console.log('  ok   ' + msg); return true; }
  fails++; console.log('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

console.log('core: ' + FILE);

// 1) the deal
const rng = C.mulberry32(11);
const slots = C.deal([0, 1, 2], rng);
ok(slots.length === 6, 'a deal always has six chambers', slots.length);
ok(C.countLeft(slots) === 3, 'three players get exactly three cartridges', slots);
ok(new Set(slots.filter((s) => s != null)).size === 3, 'every player owns exactly one cartridge', slots);
ok(slots.every((s) => s === null || (s >= 0 && s <= 2)), 'chambers hold a player index or nothing', slots);
for (let seed = 1; seed <= 200; seed++) {
  const s = C.deal([0, 1, 2, 3, 4, 5], C.mulberry32(seed));
  if (C.countLeft(s) !== 6 || new Set(s).size !== 6) { ok(false, 'six players fill six distinct chambers (seed ' + seed + ')', s); break; }
}

// 2) default (unshuffled) placement is chamber i for player i — the gate's QA boards rely on it
const dflt = C.defaultSlots([0, 1, 2]);
ok(dflt[0] === 0 && dflt[1] === 1 && dflt[2] === 2 && dflt[3] === null, 'defaultSlots is index-aligned', dflt);

// 3) resolve
ok(C.resolve(dflt, 1).hit === true && C.resolve(dflt, 1).player === 1, 'a loaded chamber hits its owner');
ok(C.resolve(dflt, 4).hit === false && C.resolve(dflt, 4).player === null, 'an empty chamber is a click');
ok(C.resolve(new Array(6).fill(null), 3).hit === false, 'an empty cylinder can never hit');

// 4) landing covers every chamber and stays in range
const seen = new Set();
const lr = C.mulberry32(99);
for (let i = 0; i < 4000; i++) { const k = C.landing(lr); if (k < 0 || k > 5 || !Number.isInteger(k)) { ok(false, 'landing stays a chamber index', k); break; } seen.add(k); }
ok(seen.size === 6, 'the landing reaches all six chambers', [...seen]);

// 5) determinism: the same seed replays the same spin sequence
const seq = (seed) => { const r = C.mulberry32(seed); return [C.landing(r), C.landing(r), C.landing(r), C.landing(r)]; };
ok(JSON.stringify(seq(21)) === JSON.stringify(seq(21)), 'a seed replays the same spins');
ok(JSON.stringify(seq(21)) !== JSON.stringify(seq(22)), 'a different seed deals a different run');

// 6) elimination: three players, spin the columns that are loaded, until one cartridge is left
let st = C.defaultSlots([0, 1, 2]);
let guard = 0;
let lastSeen = null;
while (C.countLeft(st) > 1 && guard++ < 10) {
  const k = st.findIndex((s) => s != null);           // aim at a real cartridge every time
  const step = C.elimStep(st, k);
  ok(step.hit === true, 'an aimed spin always hits a cartridge');
  ok(step.slots[k] === null, 'the hit cartridge leaves the drum', step.slots);
  ok(step.remaining === C.countLeft(step.slots), 'the remaining count tracks the drum', step.remaining);
  st = step.slots;
  lastSeen = step;
}
ok(C.countLeft(st) === 1, 'three players end with exactly one cartridge', st);
ok(lastSeen && lastSeen.survivor != null, 'the survivor is named on the final elimination', lastSeen);
ok(st.includes(lastSeen.survivor) && C.countLeft(st) === 1, 'the survivor is the player who still holds the last cartridge', { st, survivor: lastSeen.survivor });

// 7) an empty spin in elimination changes nothing
const before = [0, 1, null, null, null, null];
const blank = C.elimStep(before, 4);
ok(blank.hit === false && JSON.stringify(blank.slots) === JSON.stringify(before), 'an empty landing leaves the drum untouched', blank);
ok(blank.remaining === 2 && blank.survivor === null, 'and the game goes on', blank);

// 8) two players end after a single bang
const two = C.elimStep(C.defaultSlots([0, 1]), 0);
ok(two.remaining === 1 && two.survivor === 1, 'with two players the first bang hands the survivor the draw', two);

console.log(fails ? `FAILED (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
