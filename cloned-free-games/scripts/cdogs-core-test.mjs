#!/usr/bin/env node
/**
 * scripts/cdogs-core-test.mjs — rules proof for the C-Dogs SDL port.
 *
 * Slices the shipped // >>>CORE block out of the page and runs it in node, so the
 * floor generator, pathfinder, line of sight and the whole combat sim proven here
 * are the exact code the browser runs. Then it plays three pilot ladders:
 *   idle    — never touches the deck; must never clear a mission
 *   fighter — walks straight at the nearest hostile; the naive floor
 *   careful — breaks contact under 58 hp to let the dog patch up, then works the
 *             nearest hostile; the competent read
 */
import fs from 'node:fs';

const PAGE = '/home/cluer/kaos/work/site/games/arcade/cdogs-sdl/index.html';
const html = fs.readFileSync(PAGE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no CORE block'); process.exit(1); }

const api = new Function(m[1] + `
  return { CFG, makeLevel, newGame, buildState, stepSim, bfsPath, bfsDist, los, wallAt, cellOf, cw, ch, aliveCount };
`)();

let fails = 0, checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (!cond) { fails++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
  return !!cond;
}
const { CFG, makeLevel, newGame, buildState, stepSim, bfsPath, bfsDist, los, wallAt, cellOf, cw, ch } = api;

// ---------------------------------------------------------------- structure
console.log('structure');
{
  let reachable = 0, seeds = 0, minFoes = 99, maxFoes = 0;
  for (let level = 1; level <= 3; level++) {
    for (let seed = 1; seed <= 20; seed++) {
      seeds++;
      const L = makeLevel(seed, level);
      const g = L.grid;
      let border = true;
      for (let c = 0; c < CFG.W; c++) if (!g[c] || !g[(CFG.H - 1) * CFG.W + c]) border = false;
      for (let r = 0; r < CFG.H; r++) if (!g[r * CFG.W] || !g[r * CFG.W + CFG.W - 1]) border = false;
      ok(border, `seed ${seed}/${level}: border solid`);
      const dist = bfsDist(g, L.start.r * CFG.W + L.start.c);
      const exD = dist[L.exit.r * CFG.W + L.exit.c];
      ok(exD > 4, `seed ${seed}/${level}: exit reachable and far`, 'dist ' + exD);
      let allReach = true;
      for (const e of L.enemies) if (dist[e.r * CFG.W + e.c] < 0) allReach = false;
      ok(allReach, `seed ${seed}/${level}: every hostile reachable`);
      if (exD > 4) reachable++;
      let safe = true;
      for (const e of L.enemies) {
        const cheb = Math.max(Math.abs(e.r - L.start.r), Math.abs(e.c - L.start.c));
        if (cheb < 3) safe = false;
      }
      ok(safe, `seed ${seed}/${level}: no hostile beside the spawn`);
      ok(L.enemies.length >= 4, `seed ${seed}/${level}: hostiles placed`, 'n ' + L.enemies.length);
      minFoes = Math.min(minFoes, L.enemies.length);
      maxFoes = Math.max(maxFoes, L.enemies.length);
      ok(!wallAt(g, L.start.r, L.start.c) && !wallAt(g, L.exit.r, L.exit.c), `seed ${seed}/${level}: spawn/exit open`);
    }
  }
  console.log(`  ${seeds} floors, ${minFoes}-${maxFoes} hostiles each, ${reachable} with a reachable exit`);
}

// ---------------------------------------------------------------- determinism
console.log('determinism');
{
  const a = makeLevel(4242, 2), b = makeLevel(4242, 2), c = makeLevel(4243, 2);
  ok(a.grid.every((v, i) => v === b.grid[i]), 'same seed deals the same floor');
  ok(a.exit.r !== c.exit.r || a.exit.c !== c.exit.c || a.grid.some((v, i) => v !== c.grid[i]), 'a different seed deals a different floor');
}

// ---------------------------------------------------------------- LOS
console.log('line of sight');
{
  const g = new Uint8Array(CFG.W * CFG.H);
  g[6 * CFG.W + 5] = 1;
  const ax = cw(4), az = ch(6), bx = cw(7), bz = ch(6);
  ok(los(g, ax, az, bx, bz) === false, 'a crate between two points blocks sight');
  ok(los(g, ax, az, cw(4) + 0.6, az) === true, 'a short clear line sees through');
  ok(los(g, ax, az, ax, az) === true, 'a point sees itself');
  ok(los(new Uint8Array(CFG.W * CFG.H), ax, az, bx, bz) === true, 'a clear deck sees across');
  const route = bfsPath(g, { r: 6, c: 2 }, { r: 6, c: 8 });
  ok(route.length > 6, 'the pathfinder routes around a blocking crate', 'len ' + route.length);
  ok(route.every((p) => !wallAt(g, p.r, p.c)), 'no waypoint sits inside a wall');
}

// ---------------------------------------------------------------- pilots
function hideout(S) {
  let best = null, bs = -1e9;
  for (let r = 0; r < CFG.H; r++) {
    for (let c = 0; c < CFG.W; c++) {
      if (S.grid[r * CFG.W + c]) continue;
      let near = 1e9, seen = 0;
      for (const e of S.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(cw(c) - e.x, ch(r) - e.z);
        if (d < near) near = d;
        if (los(S.grid, e.x, e.z, cw(c), ch(r))) seen++;
      }
      const sc = Math.min(near, 9) - seen * 4;
      if (sc > bs) { bs = sc; best = { r, c }; }
    }
  }
  return best;
}

function pilot(S, kind, memo) {
  const P = S.player;
  S.input = { dx: 0, dz: 0, on: false };
  if (kind === 'idle') { S.path = []; return; }
  if (S.t - memo.last < 0.35) return;
  memo.last = S.t;
  const alive = S.enemies.filter((e) => e.alive);
  if (!alive.length) {
    if (S.armed) S.path = bfsPath(S.grid, cellOf(P.x, P.z), { r: S.exit.r, c: S.exit.c });
    return;
  }
  let target = null, bd = 1e9;
  for (const e of alive) {
    const d = Math.hypot(e.x - P.x, e.z - P.z);
    if (d < bd) { bd = d; target = e; }
  }
  if (kind === 'careful' && P.hp < 58) {
    const spot = hideout(S);
    S.path = spot ? bfsPath(S.grid, cellOf(P.x, P.z), spot) : [];
    return;
  }
  const hold = kind === 'careful' ? 5.2 : 4.6;
  S.path = bd > hold ? bfsPath(S.grid, cellOf(P.x, P.z), target.cell) : [];
}

function play(seed, level, kind, maxT = 150) {
  const S = newGame(seed, level);
  const memo = { last: -1 };
  while (!S.over && S.t < maxT) { pilot(S, kind, memo); stepSim(S, 1 / 60); }
  return S;
}

console.log('ladders (25 seeds per mission)');
{
  const rows = [];
  for (const kind of ['idle', 'fighter', 'careful']) {
    for (let level = 1; level <= 3; level++) {
      let wins = 0, downs = 0, stalls = 0, kills = 0;
      for (let i = 1; i <= 25; i++) {
        const S = play(i * 17, level, kind);
        if (S.result === 'clear') wins++;
        else if (S.result === 'down') downs++;
        else stalls++;
        kills += S.kills;
      }
      rows.push({ kind, level, wins, downs, stalls });
      console.log(`  ${kind.padEnd(8)} mission ${level}: cleared ${wins}/25, down ${downs}, stalled ${stalls}, kills/run ${(kills / 25).toFixed(1)}`);
    }
  }
  const idle = rows.filter((r) => r.kind === 'idle');
  const careful = rows.filter((r) => r.kind === 'careful');
  const fight = rows.filter((r) => r.kind === 'fighter');
  ok(idle.every((r) => r.wins === 0), 'an idle visitor never clears a mission', JSON.stringify(idle.map((r) => r.wins)));
  ok(idle.every((r) => r.stalls <= 3), 'an idle visitor is not left standing in an endless stand-off', JSON.stringify(idle.map((r) => r.stalls)));
  ok(careful[0].wins >= 15, 'a careful pilot clears mission 1', 'wins ' + careful[0].wins);
  ok(careful[2].wins >= 6, 'mission 3 is still winnable', 'wins ' + careful[2].wins);
  ok(careful[0].wins >= fight[0].wins, 'using cover beats walking at the gun', `${careful[0].wins} vs ${fight[0].wins}`);
  ok(rows.every((r) => r.stalls <= 3), 'no mission leaves the sim in an endless stand-off', JSON.stringify(rows.map((r) => r.stalls)));
}

// ---------------------------------------------------------------- rules
console.log('rules');
{
  // empty deck, hostile 4 cells away: auto-fire removes it, then the hatch arms
  const S = buildState({ grid: new Uint8Array(CFG.W * CFG.H), start: { r: 2, c: 2 }, exit: { r: 2, c: 4 }, enemies: [{ r: 2, c: 6, hp: 24 }] }, 1, 7);
  ok(S.enemies[0].hp === 24, 'a fixture keeps the hostile hp it was given');
  S.input = { dx: 0, dz: 0, on: false };
  for (let i = 0; i < 60 * 12 && S.enemies[0].alive; i++) stepSim(S, 1 / 60);
  ok(!S.enemies[0].alive && S.kills === 1, 'auto-fire removes a visible hostile', 'kills ' + S.kills + ' hp ' + S.enemies[0].hp);
  ok(S.armed === true, 'clearing the deck arms the hatch');
  ok(S.shots >= 1, 'shots were fired');
  S.path = bfsPath(S.grid, cellOf(S.player.x, S.player.z), S.exit);
  for (let i = 0; i < 60 * 10 && !S.over; i++) stepSim(S, 1 / 60);
  ok(S.over === true && S.result === 'clear', 'reaching the armed hatch clears the mission', S.result);

  // lose: a hostile that shoots while the visitor stands still at low health
  const L = buildState({ grid: new Uint8Array(CFG.W * CFG.H), start: { r: 6, c: 2 }, exit: { r: 6, c: 4 }, enemies: [{ r: 6, c: 8, hp: 400 }] }, 1, 9);
  L.player.hp = 18;
  L.input = { dx: 0, dz: 0, on: false };
  for (let i = 0; i < 60 * 20 && !L.over; i++) stepSim(L, 1 / 60);
  ok(L.over === true && L.result === 'down', 'a hostile that can see a low-health dog ends the run', L.result);

  // the hatch is not usable while hostiles live
  const N = buildState({ grid: new Uint8Array(CFG.W * CFG.H), start: { r: 2, c: 4 }, exit: { r: 2, c: 4 }, enemies: [{ r: 6, c: 8, hp: 400 }] }, 1, 3);
  N.input = { dx: 0, dz: 0, on: false };
  for (let i = 0; i < 60 * 2; i++) stepSim(N, 1 / 60);
  ok(N.over === false && N.armed === false, 'standing on the hatch does nothing while the deck is hot');

  // a dog that never gets hit patches itself back up
  const R = buildState({ grid: new Uint8Array(CFG.W * CFG.H), start: { r: 6, c: 2 }, exit: { r: 6, c: 4 }, enemies: [] }, 1, 5);
  R.player.hp = 40;
  R.armed = false;
  for (let i = 0; i < 60 * 8; i++) stepSim(R, 1 / 60);
  ok(R.player.hp > 45, 'an unhit dog regenerates', 'hp ' + R.player.hp.toFixed(1));
  ok(R.player.hp <= CFG.playerHp, 'regeneration never overshoots the cap');
}

// ---------------------------------------------------------------- score
console.log('score');
{
  const S = newGame(5, 1);
  const before = S.score;
  const e0 = S.enemies[0];
  e0.hp = 1;
  S.player.x = e0.x - 1.2; S.player.z = e0.z;
  S.input = { dx: 0, dz: 0, on: false };
  for (let i = 0; i < 60 * 6 && e0.alive; i++) stepSim(S, 1 / 60);
  ok(!e0.alive, 'the fixture kill landed');
  ok(S.score >= before + CFG.killScore, 'a kill pays the kill bounty', 'score ' + S.score);
  ok(S.hits >= 1, 'the hit counter moves');
}

console.log('');
console.log(fails === 0 ? `PASS ${checks} checks` : `FAIL ${fails}/${checks} checks`);
process.exit(fails === 0 ? 0 : 1);
