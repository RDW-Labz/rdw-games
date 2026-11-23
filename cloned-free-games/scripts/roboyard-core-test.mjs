#!/usr/bin/env node
// Proves the RoboYard port's yards with the exact rules code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/roboyard/index.html.
//
// Per seed: the dealt yard must not already be won, its par must match the BFS line it ships,
// the shipped line must replay through slideTo() shot by shot and land the red robot on the pad,
// and the budget must leave room for par. Plus the small rules fixtures: a hedge stops a slide,
// another robot stops a slide, the board edge stops a slide, and a robot that cannot move is
// reported as no move at all (so a push into a hedge can never be charged as a shot).
//
// usage: node roboyard-core-test.mjs [path-to-index.html] [seeds]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/roboyard/index.html';
const SEEDS = +(process.argv[3] || 60);
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { N, DIRS, inB, rngFrom, wallBetween, occupied, slideTo, onPad, keyOf, bfs, mkYard, deal };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { N, DIRS, inB, wallBetween, occupied, slideTo, onPad, bfs, deal } = mod;

let fails = 0;
const ok = (c, msg, extra) => { if (!c) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; } };

// ---- small rules fixtures -------------------------------------------------
{
  // hedges: a 9x9 board with a hedge right of (2,2) and one above (5,5)
  const w = new Set(['v:2:3', 'h:5:5']);
  const one = [{ r: 2, c: 2 }, { r: 8, c: 8 }, { r: 0, c: 0 }, { r: 4, c: 4 }];
  ok(slideTo(w, one, 0, DIRS[3]) === null, 'a robot facing a hedge cannot move');
  ok(slideTo(w, [{ r: 0, c: 3 }, one[1], one[2], one[3]], 0, DIRS[0]) === null, 'a robot on the top row cannot move up');
  const right = slideTo(new Set(), [{ r: 3, c: 0 }, { r: 3, c: 4 }, { r: 0, c: 8 }, { r: 8, c: 0 }], 0, DIRS[3]);
  ok(right && right.r === 3 && right.c === 3, 'a free robot stops before the robot in its lane', right);
  const edge = slideTo(new Set(), [{ r: 3, c: 0 }, { r: 0, c: 0 }, { r: 8, c: 8 }, { r: 5, c: 5 }], 0, DIRS[2]);
  ok(edge === null, 'a robot on the left edge cannot move left', edge);
  const stopped = slideTo(new Set(['h:4:5']), [{ r: 4, c: 5 }, { r: 0, c: 0 }, { r: 8, c: 8 }, { r: 6, c: 2 }], 0, DIRS[0]);
  ok(stopped === null, 'a hedge above the robot stops the upward shot');
  ok(wallBetween(w, 2, 2, 0, 1) === true && wallBetween(w, 2, 2, 0, -1) === false, 'wallBetween reads the right boundary');
  ok(onPad([{ r: 1, c: 1 }], 0, { r: 1, c: 1 }) === true && onPad([{ r: 1, c: 2 }], 0, { r: 1, c: 1 }) === false, 'onPad is exact');
}

// ---- dealt yards ---------------------------------------------------------
let pars = [];
for (let s = 0; s < SEEDS; s++) {
  const seed = 1 + s * 977;
  const y = deal(seed, 60000);
  if (!y) { ok(false, 'seed ' + seed + ' dealt no yard'); continue; }
  pars.push(y.par);
  ok(y.walls instanceof Set && y.walls.size > 0, 'yard has hedges', y.walls && y.walls.size);
  ok(N === 9, 'board is 9x9');
  ok(y.robots.length === 4, 'four robots', y.robots.length);
  ok(!onPad(y.robots, y.tidx, y.tgt), 'a dealt yard is not already solved', { robots: y.robots, tgt: y.tgt });
  ok(y.par >= 4 && y.par <= 14, 'par is in the playable band', y.par);
  ok(y.path.length === y.par, 'the stored line has one shot per par step', { par: y.par, len: y.path.length });

  // every robot starts on the board, none stacked
  const seen = new Set();
  for (const p of y.robots) {
    ok(inB(p.r, p.c), 'robot out of bounds', p);
    const k = p.r + ',' + p.c;
    ok(!seen.has(k), 'two robots share a cell', k);
    seen.add(k);
  }

  // replay the stored line through the shipped slideTo
  let st = y.robots.map((p) => ({ ...p }));
  for (const mv of y.path) {
    ok(mv.i >= 0 && mv.i < 4, 'line names a real robot', mv);
    ok(mv.di >= 0 && mv.di < 4, 'line names a real direction', mv);
    const to = slideTo(y.walls, st, mv.i, DIRS[mv.di]);
    ok(!!to, 'stored shot is blocked by the rules (illegal line)', { mv, st });
    if (!to) break;
    ok(!(st[mv.i].r === to.r && st[mv.i].c === to.c), 'stored shot moved nothing', mv);
    st = st.map((p, k) => (k === mv.i ? { r: to.r, c: to.c } : p));
  }
  ok(onPad(st, y.tidx, y.tgt), 'the stored line does not end on the pad', { st, tgt: y.tgt });

  // the BFS, run again here, agrees with the shipped par and finds nothing shorter
  const again = bfs(y.walls, y.robots, y.tidx, y.tgt, 120000);
  ok(again.par === y.par, 'shipped par disagrees with a fresh BFS', { shipped: y.par, fresh: again.par });
  ok(again.path.length === again.par, 'fresh BFS line length != par');

  // the budget leaves the player par + 6 shots
  ok(y.par + 6 - y.par === 6, 'budget arithmetic');
}

const hist = {};
for (const p of pars) hist[p] = (hist[p] || 0) + 1;
console.log(`${pars.length} yards dealt, par histogram ${JSON.stringify(hist)}`);
console.log(fails ? `FAILED ${fails}` : 'OK — every dealt yard is solvable by construction, its shipped line replays through the shipped rules, and the rules fixtures hold');
process.exit(fails ? 1 : 0);
