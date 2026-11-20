#!/usr/bin/env node
// Core test for the Bubble Shooter port. Slices the // >>>CORE block out of the SHIPPED html and
// exercises the exact grid/trace/pop code the browser runs: deals, aim/snap, wall bounces, pops,
// kicked-off drops, the danger line, and a 400-shot random playthrough that must never leave a
// floating bubble or throw.
// usage: node bubbleshooter-core-test.mjs [path-to-index.html]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/bubble-shooter/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + FILE); process.exit(1); }
const core = m[1];
const tmp = join(mkdtempSync('/tmp/bs-core-'), 'core.mjs');
await writeFile(tmp, core + `
export { COLS, ROWS, ROWH, RAD, COLORS, DANGER_ROW, idx, rowOf, colOf, rowLen, valid, cellX, cellY,
  neighbors, groupAt, anchored, deal, colorsOn, trace, snapCell, resolveShot };
`);

const C = await import(pathToFileURL(tmp).href);
const { COLS, ROWS, ROWH, RAD, COLORS, DANGER_ROW, idx, rowOf, colOf, rowLen, valid, cellX, cellY,
  neighbors, groupAt, anchored, deal, colorsOn, trace, snapCell, resolveShot } = C;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const empty = () => new Uint8Array(COLS * ROWS);

console.log('grid ' + COLS + 'x' + ROWS + ', row pitch ' + ROWH.toFixed(4) + ', ' + COLORS + ' colours, danger row ' + DANGER_ROW);

// ---- 1) geometry: hex neighbours are symmetric and one diameter apart
console.log('1) hex geometry');
let sym = true, distOk = true;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < rowLen(r); c++) {
  for (const j of neighbors(r, c)) {
    const rr = rowOf(j), cc = colOf(j);
    if (!neighbors(rr, cc).includes(idx(r, c))) sym = false;
    const d = Math.hypot(cellX(rr, cc) - cellX(r, c), cellY(rr) - cellY(r));
    if (Math.abs(d - 2 * RAD) > 1e-6) distOk = false;
  }
}
ok(sym, 'every neighbour link is mutual');
ok(distOk, 'every neighbour centre is exactly one bubble diameter away');

// ---- 2) deals
console.log('2) deals (40 seeds)');
let countsOk = true, bounded = true, pairsOk = true, minPairs = 99;
for (let s = 1; s <= 40; s++) {
  const g = deal(mulberry32(s), 4);
  const counts = [0, 0, 0, 0, 0].map((_, k) => g.reduce((a, b) => a + (b === k + 1 ? 1 : 0), 0));
  const used = counts.filter((n) => n > 0);
  const tot = g.reduce((a, b) => a + (b ? 1 : 0), 0);
  if (tot !== 34) bounded = false;
  if (tot !== counts.reduce((a, b) => a + b, 0)) bounded = false;
  if (used.some((n) => n < 3)) countsOk = false;
  if (Math.max(...used) - Math.min(...used) > 1) countsOk = false;
  // opening: at least two touching same-colour pairs, so the board can be opened
  let pairs = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < rowLen(r); c++) {
    const i = idx(r, c);
    if (!g[i]) continue;
    for (const j of neighbors(r, c)) if (g[j] === g[i] && j > i) pairs++;
  }
  minPairs = Math.min(minPairs, pairs);
  if (pairs < 2) pairsOk = false;
}
ok(bounded, 'every deal fills rows 0-3 only (34 bubbles)');
ok(countsOk, 'every colour appears 3+ times, counts within one of each other');
ok(pairsOk, 'every deal opens with at least 2 touching same-colour pairs (min ' + minPairs + ')');

const deterministic = (() => {
  const a = deal(mulberry32(7), 4), b = deal(mulberry32(7), 4);
  return a.join(',') === b.join(',');
})();
ok(deterministic, 'the same seed deals the same board');

// ---- 3) trace + snap: a straight shot lands under the column it is aimed at
console.log('3) trace and snap');
const launch = { x: 4.0, y: (ROWS - 1) * ROWH + 1.06 };
{
  const g = empty();
  for (let c = 2; c < 5; c++) g[idx(0, c)] = 1;
  const p = trace(g, launch.x, launch.y, 2.5 - launch.x, 2 - launch.y);
  const cell = snapCell(g, p);
  ok(p.hit === idx(0, 2) || p.hit === idx(0, 3), 'aiming at column 2.5 hits the row-0 bubble above it');
  ok(rowOf(cell) === 1 && (colOf(cell) === 2 || colOf(cell) === 3), 'the shot snaps into the row-1 cell under the hit');
  ok(g[cell] === 0, 'the snap cell was empty');
}
// ceiling shot in an empty board
{
  const g = empty();
  const p = trace(g, launch.x, launch.y, 0, -1);
  const cell = snapCell(g, p);
  ok(rowOf(cell) === 0 && p.ceiling === true, 'a straight shot on an empty board sticks to the ceiling row');
}
// wall bounce: steep aim keeps the ball inside the field and reflects
{
  const g = empty();
  let maxX = -1, minX = 99, bounced = 0, offBoard = 0;
  for (const ang of [1.0, 1.1, 1.19, -1.0, -1.19]) {
    const p = trace(g, launch.x, launch.y, Math.sin(ang), -Math.cos(ang));
    bounced = Math.max(bounced, p.bounces);
    for (const [x] of p.pts) { maxX = Math.max(maxX, x); minX = Math.min(minX, x); if (x < -1e-6 || x > 8 + 1e-6) offBoard++; }
  }
  ok(bounced >= 2, 'a 68-degree shot bounces off the side wall (' + bounced + ' bounces)');
  ok(offBoard === 0 && minX >= -1e-6 && maxX <= 8 + 1e-6, 'the traced path never leaves x 0..8 (' + minX.toFixed(2) + '..' + maxX.toFixed(2) + ')');
}

// ---- 4) pop: 3+ of a colour pop, and the shot's own bubble joins the group
console.log('4) pops');
{
  const g = empty();
  g[idx(0, 4)] = 1; g[idx(0, 5)] = 1;
  const p = trace(g, launch.x, launch.y, 4.5 - launch.x, 2 - launch.y);
  const cell = snapCell(g, p);
  const r = resolveShot(g, 1, cell);
  ok(r.popped.length === 3, 'three touching of a colour + the shot pops 3 (' + r.popped.length + ')');
  ok(r.won === true && r.lost === false, 'emptying the board is a win');
}
{
  const g = empty();
  g[idx(0, 4)] = 1; g[idx(0, 5)] = 1;
  const r = resolveShot(g, 2, idx(1, 4));
  ok(r.popped.length === 0 && r.won === false, 'a mismatched bubble just sticks (no pop)');
}

// ---- 5) drops: a blob hanging off the popped group falls
console.log('5) kicks');
{
  const g = empty();
  // stem of colour 1 along the ceiling, a colour-2 blob hanging off it
  g[idx(0, 4)] = 1; g[idx(0, 5)] = 1; g[idx(1, 4)] = 1;
  g[idx(2, 4)] = 2; g[idx(2, 5)] = 2; g[idx(3, 4)] = 2;
  const before = g.reduce((a, b) => a + (b ? 1 : 0), 0);
  const r = resolveShot(g, 1, idx(1, 5));      // 4th colour-1 bubble touching (1,4)
  ok(r.popped.length === 4, 'the colour-1 stem pops (' + r.popped.length + ')');
  ok(r.dropped.length === 3, 'the three colour-2 bubbles hanging off it drop (' + r.dropped.length + ')');
  ok(r.grid.every((v) => v === 0) && r.won, 'nothing is left and the board is won');
  ok(before === 6, 'six bubbles before the shot');
}
// a bubble that is still connected must never drop
{
  const g = empty();
  for (let c = 0; c < rowLen(0); c++) g[idx(0, c)] = 1;
  for (let c = 0; c < rowLen(1); c++) g[idx(1, c)] = 1;
  for (let c = 0; c < rowLen(2); c++) g[idx(2, c)] = 1;
  g[idx(2, 3)] = 3; g[idx(2, 4)] = 3; g[idx(2, 5)] = 3;   // a group with nothing hanging off it
  const r = resolveShot(g, 3, idx(3, 3));
  ok(r.popped.length === 4 && r.dropped.length === 0, 'popping a group inside a solid block drops nothing else (' + r.popped.length + '/' + r.dropped.length + ')');
}

// ---- 6) danger line
console.log('6) danger line');
{
  const g = empty();
  for (let r = 0; r <= DANGER_ROW; r++) g[idx(r, 4)] = 2;
  const r = resolveShot(g, 3, idx(0, 0));
  ok(r.lost === true && r.won === false, 'a bubble on the danger row ends the run');
}
{
  const g = empty();
  for (let r = 0; r < DANGER_ROW; r++) g[idx(r, 4)] = 2;
  const r = resolveShot(g, 3, idx(0, 0));
  ok(r.lost === false, 'bubbles one row above the danger line are still in play');
}

// ---- 7) greedy playthrough: one lookahead step must clear a dealt board
console.log('7) greedy playthrough');
{
  // Every candidate aim point is an empty cell that touches the board (or the ceiling row); each is
  // traced once and resolved for each of the four colours, so this is exactly the pick a player
  // makes: shoot at the gap, see what pops.
  const aims = (g) => {
    const out = [];
    for (let i = 0; i < g.length; i++) {
      if (g[i]) continue;
      const r = rowOf(i), c = colOf(i);
      if (!valid(r, c)) continue;
      if (r === 0 || neighbors(r, c).some((j) => g[j])) out.push(i);
    }
    return out;
  };
  let wins = 0, floating = 0, stuckShots = 0, totalShots = 0, totalPops = 0;
  for (const seed of [3, 11, 29]) {
    const rnd = mulberry32(seed);
    let g = deal(rnd, 4);
    for (let turn = 0; turn < 400; turn++) {
      if (!g.some((v) => v)) { wins++; break; }
      let best = null;
      const on = colorsOn(g);
      for (const aimCell of aims(g)) {
        const p = trace(g, launch.x, launch.y, cellX(rowOf(aimCell), colOf(aimCell)) - launch.x, cellY(rowOf(aimCell)) - launch.y);
        const cell = snapCell(g, p);
        if (cell < 0) continue;
        for (const k of on) {
          const res = resolveShot(g, k, cell);
          if (res.stuck || res.lost) continue;
          // pops first, then drops; a shot that pops nothing is scored by how many of its own colour
          // it lands next to, which is what builds the next triple.
          const same = neighbors(rowOf(cell), colOf(cell)).filter((j) => g[j] === k).length;
          const v = res.popped.length * 100 + res.dropped.length * 10 + same;
          if (!best || v > best.v) best = { v, res };
        }
      }
      if (!best) { stuckShots++; break; }
      const res = best.res;
      const seen = anchored(res.grid);
      for (let i = 0; i < res.grid.length; i++) if (res.grid[i] && !seen[i]) floating++;
      totalPops += res.popped.length + res.dropped.length;
      totalShots++;
      g = res.grid;
    }
  }
  ok(floating === 0, 'no floating bubble ever survives a shot');
  ok(stuckShots === 0, 'the greedy player always finds a legal shot');
  ok(wins === 3, 'one-step-lookahead play clears the dealt board on every seed (' + wins + '/3, ' + totalPops + ' bubbles popped in ' + totalShots + ' shots)');
}

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nOK: bubble shooter core');
process.exit(fails ? 1 : 0);
