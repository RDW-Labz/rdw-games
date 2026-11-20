// Slices the CORE block out of the shipped tri-peaks port and proves the layout, the rank
// rule and the solver against the exact code the browser runs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = process.argv[2] || (process.env.HOME + '/kaos/work/site/games/arcade/tri-peaks/index.html');
const html = readFileSync(PAGE, 'utf8');

const start = html.indexOf('// >>>CORE');
const end = html.indexOf('// <<<CORE');
if (start < 0 || end < 0) throw new Error('CORE markers not found');

let src = html.slice(start, end);
src += `\nexport { ROWS, PEAKS, NP, STOCK_N, PASSES, PEAK_X, SLOTS, PARENT, APEX, adjacent, opensWell, playableList, solveDeal, dealFor, shuffleDeck, mulberry32, SLOTS_RANK };\n`;

const dir = join(tmpdir(), 'tp-core-' + process.pid);
mkdirSync(dir, { recursive: true });
const file = join(dir, 'core.mjs');
writeFileSync(file, src);
const M = await import(pathToFileURL(file).href);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL ' + msg); } };

// ---- geometry ----
ok(M.NP === 30, 'pyramid must hold 30 cards, got ' + M.NP);
ok(M.NP + M.STOCK_N === 52, 'pyramid + stock must be one deck');
ok(M.SLOTS.length === M.NP, 'slot table wrong length');
ok(new Set(M.SLOTS.map((s) => s.idx)).size === M.NP, 'slot idx must be unique');
for (let p = 0; p < M.PEAKS; p++) {
  const mine = M.SLOTS.filter((s) => s.peak === p);
  ok(mine.length === 10, `peak ${p} needs 10 cards, got ${mine.length}`);
  for (let r = 0; r < M.ROWS; r++) {
    ok(mine.filter((s) => s.row === r).length === r + 1, `peak ${p} row ${r} needs ${r + 1} cards`);
  }
}
// apex cards are free, base cards are covered
for (let i = 0; i < M.NP; i++) {
  const s = M.SLOTS[i];
  if (s.row === 0) ok(M.PARENT[i] === 0, `apex ${i} must have no parent`);
  if (s.row === M.ROWS - 1) ok(M.PARENT[i] !== 0, `base card ${i} must sit under something`);
}
// a card in row r is covered only by cards of row r-1 in the same peak, pos p-1 and p
for (let i = 0; i < M.NP; i++) {
  const s = M.SLOTS[i];
  for (let j = 0; j < M.NP; j++) {
    const t = M.SLOTS[j];
    const should = t.peak === s.peak && t.row === s.row - 1 && (t.pos === s.pos || t.pos === s.pos - 1);
    const is = !!(M.PARENT[i] & (1 << j));
    ok(should === is, `parent mismatch ${j} -> ${i}`);
  }
}

// ---- rank adjacency with the ace wrap ----
ok(M.adjacent(0, 1) && M.adjacent(1, 0), 'A-2 must match');
ok(M.adjacent(0, 12) && M.adjacent(12, 0), 'A-K must wrap');
ok(!M.adjacent(0, 2), 'A-3 must not match');
ok(!M.adjacent(5, 7), '6-8 must not match');
ok(M.adjacent(5, 6) && M.adjacent(5, 4), '6 matches 5 and 7');
ok(!M.adjacent(3, 3), 'a rank does not match itself');

// ---- playable set respects the cover rule ----
const allLive = (1 << M.NP) - 1;
const apexes = M.SLOTS.filter((s) => s.row === 0).map((s) => s.idx);
for (let r = 0; r < 13; r++) {
  // give every apex a rank one above the waste: exactly the three apexes must be playable
  const ranks = M.SLOTS.map((s) => (s.row === 0 ? (r + 1) % 13 : 0));
  const p = M.playableList(allLive, r, ranks);
  ok(p.length === 3, `with a full board only the three apexes are open (rank ${r} gave ${p.length})`);
  ok(p.every((i) => apexes.includes(i)), 'only apexes may be playable on a full board');
}
// a covered card is never playable even when its rank matches
{
  const ranks = M.SLOTS.map(() => 5);
  const p = M.playableList(allLive, 6, ranks);
  ok(p.length === 3, 'a full board offers three cards even when every rank matches');
}
// clearing an apex frees the two cards under it
let mask = allLive & ~(1 << apexes[0]);
const openAfter = M.SLOTS.filter((s) => s.row === 1 && s.peak === 0).map((s) => s.idx);
for (const i of openAfter) ok(!(M.PARENT[i] & mask), 'card under a cleared apex must be open');

// ---- deals ----
const seen = new Set();
for (const seed of [774301, 1, 2, 3, 4, 5, 42, 999, 20261119, 7]) {
  const d = M.dealFor(seed);
  ok(!!d, `dealFor(${seed}) found no solvable deal`);
  if (!d) continue;
  ok(d.pyr.length === 30 && d.stock.length === 22, `deal ${seed} size wrong`);
  const keys = new Set([...d.pyr, ...d.stock].map((c) => c.r + ':' + c.s));
  ok(keys.size === 52, `deal ${seed} is not a full 52-card deck (${keys.size} unique)`);
  const res = M.solveDeal(d.pyr.map((c) => c.r), d.stock.map((c) => c.r), M.PASSES, 200000);
  ok(res.ok, `deal ${seed} must be solvable, solver said no after ${res.nodes} nodes`);
  const sig = d.pyr.map((c) => c.r).join(',');
  ok(!seen.has(sig), `deal ${seed} repeats an earlier board`);
  seen.add(sig);
}

// ---- the boot seed the page ships ----
const boot = M.dealFor(774301);
ok(!!boot, 'the shipped boot seed must produce a solvable deal');
if (boot) {
  const res = M.solveDeal(boot.pyr.map((c) => c.r), boot.stock.map((c) => c.r), M.PASSES);
  ok(res.ok, 'boot deal must solve within the default node cap (' + res.nodes + ' nodes)');
  // the opening waste card must be one the apexes can chase, or the board opens dead
  const apexRanks = [0, 1, 2].map((p) => boot.pyr.find((c, i) => M.SLOTS[i].peak === p && M.SLOTS[i].row === 0).r);
  const opening = boot.stock[0].r;
  ok(apexRanks.some((r) => M.adjacent(r, opening)), 'boot deal must open with at least one legal apex move');
}

// ---- unsolvable boards are reported, not hidden ----
{
  // single live card at rank 4 with waste 9 and no stock: no move, so not solvable
  const pyr = new Array(30).fill(-1);
  pyr[0] = 4;
  const one = 1;
  const res = M.solveDeal(pyr, [9], 0, 120000, one);
  ok(!res.ok, 'a lone card two ranks from the waste must not solve');
  const res2 = M.solveDeal(pyr, [5], 0, 120000, one);
  ok(res2.ok, 'a lone card one rank from the waste must solve');
  const res3 = M.solveDeal(pyr, [0], 0, 120000, one);
  ok(!res3.ok, 'a lone ace does not match a two');
}

console.log(fails ? `${fails} failure(s)` : 'tri-peaks core: all checks pass');
process.exit(fails ? 1 : 0);
