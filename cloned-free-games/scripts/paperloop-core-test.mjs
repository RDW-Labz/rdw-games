#!/usr/bin/env node
// Rules test for the Paper Loop 2 port. Slices the // >>>CORE block out of the SHIPPED page and
// imports it, so the browser and this test run the same code. No DOM, no three.js.
//
// usage: node scripts/paperloop-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/paper-loop-2/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + FILE); process.exit(2); }
const exports = ['AR','CELL','STEP','INSIDE','INSIDE_COUNT','MODES','MODE_ORDER','mkState','step','run',
  'recount','turfCentroid','cellIndex','cellCentre','fillPolygon','insideCircle','kill'];
const src = m[1] + `\nexport { ${exports.join(', ')} };\n`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const { AR, CELL, STEP, INSIDE_COUNT, mkState, step, run, turfCentroid, cellCentre } = C;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const area = (cells) => cells * CELL * CELL;
const polyArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
};
const hashGrid = (g) => {
  let h = 2166136261;
  for (let i = 0; i < g.length; i++) { h ^= g[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
};
const turfCells = (S, id) => {
  let n = 0;
  for (let k = 0; k < S.own.length; k++) if (S.own[k] === id) n++;
  return n;
};
// A greedy visitor: leave the disc, run out ~2.6 units, curl home, repeat.
function pilotDrive(S, goal = 2.6) {
  const you = S.you;
  if (!you.alive || S.over) return;
  const r = Math.hypot(you.x, you.z);
  if (r > AR.R - 1.6) { you.drive = Math.atan2(-you.z, -you.x); return; }
  const home = turfCentroid(S, you.id);
  if (!you.out) { you.drive = Math.atan2(you.z - home.z, you.x - home.x); return; }
  const travelled = Math.hypot(you.x - you.exit.x, you.z - you.exit.z);
  if (travelled >= goal) you.drive = Math.atan2(home.z - you.z, home.x - you.x);
}

// ---- 1) the arena grid covers the disc ----
{
  const a = area(INSIDE_COUNT);
  const want = Math.PI * AR.R * AR.R;
  ok(Math.abs(a - want) / want < 0.01, 'arena grid area is off', { got: +a.toFixed(2), want: +want.toFixed(2) });
  ok(INSIDE_COUNT > 20000, 'arena grid is too coarse', INSIDE_COUNT);
}

// ---- 2) the deal is deterministic per seed ----
{
  const a = mkState(7, { mode: 'hard' }), b = mkState(7, { mode: 'hard' });
  ok(hashGrid(a.own) === hashGrid(b.own), 'two states from one seed deal different turf');
  for (let i = 0; i < 400; i++) { pilotDrive(a); step(a, STEP); pilotDrive(b); step(b, STEP); }
  ok(a.you.x === b.you.x && a.you.z === b.you.z, 'the same seed drifts apart after 3.3 s', [a.you.x, b.you.x]);
  ok(a.snakes[1].x === b.snakes[1].x, 'bots are not deterministic for one seed');
}

// ---- 3) everyone starts on their own disc ----
{
  const S = mkState(7, { mode: 'hard' });
  ok(S.snakes.length === 3, 'hard mode is not two rivals', S.snakes.length);
  for (const sn of S.snakes) {
    ok(Math.abs(area(sn.cells) - Math.PI * sn.disc.r * sn.disc.r) / (Math.PI * sn.disc.r * sn.disc.r) < 0.06,
      `snake ${sn.id} does not own its starting disc`, +area(sn.cells).toFixed(2));
  }
  const none = mkState(7, { mode: 'none' });
  ok(none.snakes.length === 1, 'NONE mode still spawns rivals', none.snakes.length);
}

// ---- 4) an idle visitor is not killed by the opening position ----
{
  const S = mkState(7, { mode: 'hard' });
  const x0 = S.you.x, z0 = S.you.z;
  run(S, 10);
  ok(S.you.alive && !S.over, 'the visitor dies without pressing anything', { cause: S.cause, t: S.time });
  ok(S.you.x === x0 && S.you.z === z0, 'an unsteered head drifted off its mark', [S.you.x, S.you.z]);
  ok(S.you.out === false && S.you.trailPts.length === 0, 'an unsteered head lays a ribbon');
  ok(S.you.cells > 0, 'the visitor stands on no turf at all');
}

// ---- 5) a loop claims exactly the ground its polygon encloses ----
{
  const S = mkState(7, { mode: 'none' });
  const before = S.you.cells;
  let closed = 0;
  for (let i = 0; i < 1200 && !closed; i++) {
    pilotDrive(S);
    const loops0 = S.you.loops;
    step(S, STEP);
    if (S.you.loops > loops0) closed = 1;
  }
  ok(closed === 1, 'going out and curling home never closed a loop', { out: S.you.out, t: +S.time.toFixed(2) });
  const got = S.you.cells - before;
  const poly = S.you.polys[0] || [];
  const want = polyArea(poly);
  ok(got > 40, 'the loop claimed almost nothing', got);
  ok(Math.abs(area(got) - want) / want < 0.15, 'the fill does not match the loop polygon', { claimed: +area(got).toFixed(2), poly: +want.toFixed(2) });
  ok(S.you.out === false, 'the ribbon is still out after closing');
  let trailLeft = 0;
  for (let k = 0; k < S.trail.length; k++) if (S.trail[k] === S.you.id) trailLeft++;
  ok(trailLeft === 0, 'the ribbon was left behind in the trail grid', trailLeft);
  ok(S.share > 0.02, 'share did not follow the claim', S.share);
}

// ---- 6) the rails kill, and the death is a loss ----
{
  const S = mkState(7, { mode: 'none' });
  S.you.x = 0; S.you.z = AR.R - 0.45; S.you.heading = Math.PI / 2; S.you.drive = Math.PI / 2; S.you.auto = false;
  run(S, 1.5);
  ok(!S.you.alive && S.you.cause === 'wall', 'drifting into the rails does not end the run', { cause: S.you.cause, alive: S.you.alive });
  ok(S.over && S.result === 'lose', 'a wall death did not lose the round', { over: S.over, result: S.result });
}

// ---- 7) crossing your own ribbon closes a loop instead of killing you ----
{
  const S = mkState(7, { mode: 'none' });
  // steer a tight circle out of the disc: the head must cross its own ribbon
  let closed = 0, died = false;
  for (let i = 0; i < 1400; i++) {
    if (S.you.out) S.you.drive = S.you.heading + 2.2;
    else S.you.drive = S.you.heading + 0.6;
    step(S, STEP);
    if (S.you.loops > 0) { closed = 1; break; }
    if (!S.you.alive) { died = true; break; }
  }
  ok(!died, 'crossing own ribbon killed the visitor instead of closing the loop', S.you.cause);
  ok(closed === 1, 'a self-crossing ribbon never closed', { out: S.you.out, t: +S.time.toFixed(2) });
  ok(S.you.cells > 100, 'the self-closed loop claimed nothing', S.you.cells);
}

// ---- 8) a rival ribbon in the way slices the rival ----
{
  const S = mkState(7, { mode: 'hard' });
  const bot = S.snakes.find((s) => s.bot);
  // park the rival's ribbon straight ahead of the visitor, three units out
  const hx = S.you.x + Math.cos(S.you.heading) * 3, hz = S.you.z + Math.sin(S.you.heading) * 3;
  bot.x = hx; bot.z = hz; bot.heading = S.you.heading + Math.PI / 2; bot.speed = 0;
  bot.alive = true; bot.out = true; bot.trailPts = [{ x: hx, z: hz }];
  for (let i = -10; i <= 10; i++) {
    const p = { x: hx + Math.cos(bot.heading) * 0.06 * i, z: hz + Math.sin(bot.heading) * 0.06 * i };
    const k = C.cellIndex(p.x, p.z);
    if (k >= 0) S.trail[k] = bot.id;
  }
  const botCells0 = bot.cells;
  S.you.drive = S.you.heading; S.you.auto = false;   // a live head flies straight at the ribbon
  for (let i = 0; i < 240 && bot.alive; i++) step(S, STEP);
  ok(!bot.alive && bot.cause === 'sliced', 'driving through a rival ribbon did not knock it out', { alive: bot.alive, cause: bot.cause });
  ok(S.you.kills === 1, 'the slice was not counted', S.you.kills);
  ok(S.you.alive, 'the visitor died on a rival ribbon');
  ok(bot.cells === 0 && botCells0 > 0, 'the knocked-out rival kept its ground', { before: botCells0, after: bot.cells });
}

// ---- 9) scripted rivals actually claim ground ----
{
  const S = mkState(7, { mode: 'hard' });
  const start = S.snakes.filter((s) => s.bot).map((s) => s.cells);
  run(S, 25);
  const bots = S.snakes.filter((s) => s.bot);
  const grew = bots.filter((b, i) => b.cells > start[i] * 1.15).length;
  ok(grew >= 1, 'no rival claimed any ground in 25 s', bots.map((b) => [b.cells, start[b.id - 2], b.alive, b.cause]));
  ok(bots.some((b) => b.loops > 0), 'a rival never closed a loop in 25 s');
}

// ---- 10) a greedy visitor can win the arena, and it takes a real round ----
{
  const times = [];
  for (let seed = 1; seed <= 6; seed++) {
    const S = mkState(seed, { mode: 'hard' });
    let t = 0;
    while (!S.over && t < 180) { pilotDrive(S); step(S, STEP); t += STEP; }
    if (S.result === 'win') times.push(+t.toFixed(1));
    ok(S.over, `seed ${seed}: the round never ended in 180 s`, { share: S.share, alive: S.you.alive });
    ok(S.share >= S.winAt - 1e-9 || S.result !== 'win', `seed ${seed}: won below the target share`, S.share);
  }
  ok(times.length >= 4, 'a greedy visitor cannot win the arena', times);
  ok(times.every((t) => t >= 12 && t <= 150), 'win times are outside a sane round length', times);
  console.log('  win times (s):', times.join(', '));
}

// ---- 11) the share readout tracks the grid ----
{
  const S = mkState(7, { mode: 'none' });
  run(S, 6);
  const n = turfCells(S, S.you.id);
  ok(Math.abs(S.share - n / INSIDE_COUNT) < 1e-9, 'share is not cells / arena cells', [S.share, n / INSIDE_COUNT]);
  ok(S.you.cells === n, 'the snake cell count drifted from the grid', [S.you.cells, n]);
}

console.log(fails ? `FAIL: ${fails} assertion(s)` : 'PASS — paper loop 2 rules hold');
process.exit(fails ? 1 : 0);
