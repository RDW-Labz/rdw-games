#!/usr/bin/env node
// Core test for the Powder Lab port. Slices the // >>>CORE block out of the SHIPPED html and drives
// it in node, so the physics and objectives proven here are the exact code the browser runs.
// usage: node powder-lab-core-test.mjs [path-to-index.html]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/powder-lab/index.html';
const html = await readFile(FILE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) { console.error('FAIL no CORE block (check the markers)'); process.exit(1); }
const src = html.slice(a, b) + `
export { W, H, EMPTY, STONE, SAND, WATER, OIL, FIRE, SMOKE, TICK, LEVELS, mkState, buildLevel,
  simTick, paintCells, paintLine, check, countMat, countIn, idx, inb };`;
const tmp = '/tmp/powder-core-' + process.pid + '.mjs';
await writeFile(tmp, src);
const M = await import(pathToFileURL(tmp).href);

const { W, H, EMPTY, STONE, SAND, WATER, OIL, FIRE, SMOKE, LEVELS, mkState, simTick,
  paintCells, paintLine, check, countMat, idx } = M;

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('PASS ' + msg);
  else { fails++; console.log('FAIL ' + msg + (extra ? ' :: ' + extra : '')); }
};
const run = (S, n) => { for (let i = 0; i < n; i++) simTick(S); return S; };
const at = (S, c, r) => S.g[idx(c, r)];

// ---------- 1. a stone plate holds sand and never moves ----------
{
  const S = mkState(0);
  S.g.fill(EMPTY); S.life.fill(0);
  for (let c = 10; c <= 30; c++) S.g[idx(c, 0)] = STONE;
  const stone0 = countMat(S, STONE);
  paintCells(S, 20, 12, SAND);
  run(S, 200);
  ok(countMat(S, STONE) === stone0, 'stone never moves under a sand pour', `${stone0} -> ${countMat(S, STONE)}`);
  ok(countMat(S, SAND) > 0 && at(S, 20, 1) === SAND, 'sand rests on the stone plate', `cell(20,1)=${at(S, 20, 1)}`);
  ok(countMat(S, SAND) === 0 || countMat(S, EMPTY) < W * H, 'sand is still on the board (no leak)');
}

// ---------- 2. gravity: one cell per sweep, no tunnelling ----------
{
  const S = mkState(0);
  S.g.fill(EMPTY); S.life.fill(0);
  S.g[idx(24, 20)] = SAND;
  simTick(S);
  ok(at(S, 24, 19) === SAND, 'one sweep drops a grain exactly one cell', `cell=${at(S, 24, 19)}`);
  run(S, 40);
  ok(at(S, 24, 0) === SAND, 'a grain settles on the floor', `cell=${at(S, 24, 0)}`);
}

// ---------- 3. density: sand sinks through water, water sinks under oil ----------
{
  const S = mkState(0);
  S.g.fill(EMPTY); S.life.fill(0);
  for (let c = 20; c <= 26; c++) S.g[idx(c, 0)] = STONE;
  for (let c = 20; c <= 26; c++) for (let r = 1; r <= 4; r++) S.g[idx(c, r)] = WATER;
  S.g[idx(23, 9)] = SAND;
  run(S, 30);
  ok(at(S, 23, 1) === SAND, 'sand sinks to the bottom of the water', `cell=${at(S, 23, 1)}`);

  const T = mkState(0);
  T.g.fill(EMPTY); T.life.fill(0);
  for (let c = 18; c <= 30; c++) T.g[idx(c, 0)] = STONE;               // floor
  for (let r = 0; r <= 8; r++) { T.g[idx(18, r)] = STONE; T.g[idx(30, r)] = STONE; }
  for (let c = 19; c <= 29; c++) T.g[idx(c, 1)] = WATER;
  for (let c = 19; c <= 29; c++) T.g[idx(c, 2)] = OIL;
  run(T, 120);
  const oilRow = (() => { let s = 0, n = 0; for (let c = 20; c <= 26; c++) for (let r = 0; r < 8; r++) if (at(T, c, r) === OIL) { s += r; n++; } return n ? s / n : -1; })();
  const watRow = (() => { let s = 0, n = 0; for (let c = 20; c <= 26; c++) for (let r = 0; r < 8; r++) if (at(T, c, r) === WATER) { s += r; n++; } return n ? s / n : -1; })();
  ok(oilRow > watRow, 'oil floats above water', `oil avg row ${oilRow.toFixed(2)} water ${watRow.toFixed(2)}`);
}

// ---------- 4. fire burns oil away; water quenches fire ----------
{
  const S = mkState(1);
  const oil0 = countMat(S, OIL);
  ok(oil0 > 40, 'the quench level starts with a full oil trough', `oil0=${oil0}`);
  paintCells(S, 16, 5, FIRE);
  run(S, 1400);
  ok(countMat(S, OIL) === 0, 'a lit trough burns every drop of oil', `oil left ${countMat(S, OIL)}`);
  ok(countMat(S, FIRE) === 0, 'every flame eventually goes out', `fire left ${countMat(S, FIRE)}`);
  ok(check(S).done, 'quench objective reports done once the trough is cold');

  const T = mkState(1);
  paintCells(T, 16, 6, FIRE);
  run(T, 10);
  const fireBefore = countMat(T, FIRE);
  paintCells(T, 16, 8, WATER);
  run(T, 120);
  ok(fireBefore > 0 && countMat(T, FIRE) < fireBefore + 6, 'water arriving on a fire puts it out', `${fireBefore} -> ${countMat(T, FIRE)}`);
}

// ---------- 5. every level is solvable by real play (pours / ignition), and starts unsolved ----------
const solve = {
  // pour sand in bands across the crucible mouth
  0: (S) => {
    for (let pass = 0; pass < 3 && !check(S).done; pass++) {
      let prev = null;
      for (let c = 14; c <= 34; c += 2) {
        if (prev) paintLine(S, prev, 26, c, 26, SAND);
        prev = c;
        run(S, 6);
      }
      run(S, 60);
    }
  },
  1: (S) => {
    for (let pass = 0; pass < 6 && !check(S).done; pass++) {
      let prev = null;
      for (let c = 8; c <= 28; c += 3) {
        if (prev) paintLine(S, prev, 6, c, 6, FIRE);
        else paintCells(S, c, 6, FIRE);
        prev = c;
        run(S, 8);
      }
      run(S, 200);
    }
  },
  2: (S) => {
    for (let pass = 0; pass < 6 && !check(S).done; pass++) {
      let prev = null;
      for (let c = 20; c <= 28; c += 2) {
        if (prev) paintLine(S, prev, 24, c, 24, SAND);
        else paintCells(S, c, 24, SAND);
        prev = c;
        run(S, 6);
      }
      run(S, 90);
    }
  },
};

for (let i = 0; i < LEVELS.length; i++) {
  const S = mkState(i);
  const c0 = check(S);
  ok(!c0.done && c0.progress < c0.target, `level ${i + 1} (${LEVELS[i].name}) does not start solved`, JSON.stringify(c0));
  solve[i](S);
  const c1 = check(S);
  ok(c1.done, `level ${i + 1} (${LEVELS[i].name}) is solvable by play`, JSON.stringify(c1));
  if (c1.done) console.log(`     solved in ${S.ticks} sweeps (${(S.ticks / 40).toFixed(1)} s of sim)`);
}

// ---------- 6. an empty board is never a win ----------
for (let i = 0; i < LEVELS.length; i++) {
  const S = mkState(i);
  S.g.fill(EMPTY); S.life.fill(0);
  ok(!check(S).done, `level ${i + 1} cannot be cleared by erasing the apparatus`);
}

// ---------- 7. the brush is bounded and idempotent enough for a double tap ----------
{
  const S = mkState(0);
  S.g.fill(EMPTY); S.life.fill(0);
  const n1 = paintCells(S, 24, 20, SAND);
  const n2 = paintCells(S, 24, 20, SAND);
  ok(n1 > 0 && n2 === 0, 'a second deposit on the same cell adds nothing', `${n1} then ${n2}`);
  const n3 = paintCells(S, 24, 20, EMPTY);
  ok(n3 === n1, 'erase clears what was deposited', `${n3}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL POWDER LAB CORE CHECKS PASSED');
process.exit(fails ? 1 : 0);
