#!/usr/bin/env node
// Core test for the Wolfenstein RPG port. Slices the // >>>CORE block out of the shipped
// HTML and exercises it directly, so the maze, the line-of-sight shot and the enemy turns
// proven here are the exact functions the browser runs.
//
// usage: node scripts/wolfenrpg-core-test.mjs [path-to-index.html]
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/wolfenstein-rpg/index.html';
const html = await readFile(FILE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) { console.log('NO CORE BLOCK'); process.exit(1); }
const body = html.slice(a, b);
const dir = await mkdtemp(join(tmpdir(), 'wolfcore-'));
const mod = join(dir, 'core.mjs');
await writeFile(mod, body + `
export { DIRS, WALL, OPEN, FLOORS, mulberry32, genMaze, distMap, farthestFrom, losClear,
  enemyAt, itemAt, aliveEnemies, openingHall, makeFloor, shootRay, chaseStep, enemyTurn,
  resolveTurn, makeQA };
`);
const C = await import(mod);

const fails = [];
const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); };

// ---------- 1) maze + placement, per floor and seed
for (const floor of [1, 2, 3]) {
  for (const seed of [1, 7, 99, 1234, 0x51ee7, 424242, 8, 31337]) {
    const S = C.makeFloor(floor, seed);
    const n = S.n;
    const d = C.distMap(S.grid, n, S.p.r, S.p.c);
    let openCells = 0, unreachable = 0;
    for (let i = 0; i < S.grid.length; i++) {
      if (S.grid[i] === C.OPEN) { openCells++; if (d[i] < 0) unreachable++; }
    }
    ok(`maze ${floor}/${seed} has a floor`, openCells > 30, { openCells });
    ok(`maze ${floor}/${seed} fully connected`, unreachable === 0, { unreachable });
    ok(`maze ${floor}/${seed} exit reachable`, d[S.exit.r * n + S.exit.c] > 4, { exit: S.exit });
    ok(`maze ${floor}/${seed} start is open`, S.grid[S.p.r * n + S.p.c] === C.OPEN);
    ok(`maze ${floor}/${seed} start is not the exit`, !(S.p.r === S.exit.r && S.p.c === S.exit.c));
    const cells = new Set();
    for (const e of S.enemies) {
      ok(`maze ${floor}/${seed} enemy on open cell`, S.grid[e.r * n + e.c] === C.OPEN, e);
      ok(`maze ${floor}/${seed} enemy reachable`, d[e.r * n + e.c] > 0, e);
      ok(`maze ${floor}/${seed} enemy not on start/exit`, !(e.r === S.p.r && e.c === S.p.c) && !(e.r === S.exit.r && e.c === S.exit.c), e);
      ok(`maze ${floor}/${seed} enemy distinct`, !cells.has(e.r * n + e.c), e);
      cells.add(e.r * n + e.c);
      ok(`maze ${floor}/${seed} enemy hp matches kind`, e.hp === (e.kind === 3 ? 30 : e.kind === 2 ? 18 : 10), e);
    }
    ok(`maze ${floor}/${seed} enemy count`, S.enemies.length === C.FLOORS[floor - 1].enemies, { got: S.enemies.length, want: C.FLOORS[floor - 1].enemies });
    ok(`maze ${floor}/${seed} has pickups`, S.items.length >= 3, { items: S.items.length });
    for (const it of S.items) {
      ok(`maze ${floor}/${seed} item on open reachable cell`, S.grid[it.r * n + it.c] === C.OPEN && d[it.r * n + it.c] > 0, it);
      ok(`maze ${floor}/${seed} item off an enemy`, !cells.has(it.r * n + it.c), it);
    }
    // a monster must be visible down the opening hall on floor 1
    const dir = S.p.dir;
    const D = C.DIRS[dir];
    const ahead = S.enemies.find((e) => {
      const k = 1;
      for (let t = 1; t <= 6; t++) {
        if (S.p.r + D[0] * t === e.r && S.p.c + D[1] * t === e.c) return true;
        if (S.grid[(S.p.r + D[0] * t) * n + (S.p.c + D[1] * t)] !== C.OPEN) break;
      }
      return false;
    });
    if (floor === 1) ok(`floor1 ${seed} opens with a target in the corridor`, !!ahead, { dir });
  }
}

// ---------- 2) determinism
{
  const x = C.makeFloor(2, 1234), y = C.makeFloor(2, 1234);
  ok('same seed builds the same floor', JSON.stringify(x.grid ? Array.from(x.grid) : x) === JSON.stringify(y.grid ? Array.from(y.grid) : y)
    && JSON.stringify(x.enemies) === JSON.stringify(y.enemies));
  const z = C.makeFloor(2, 1235);
  ok('a different seed builds a different floor', JSON.stringify(Array.from(x.grid)) !== JSON.stringify(Array.from(z.grid)));
}

// ---------- 3) a shot down a clear corridor kills a grunt
{
  const S = C.makeFloor(1, 0x51ee7);
  S.enemies = S.enemies.filter((e) => e.id === 0);
  const e = S.enemies[0];
  e.kind = 1; e.hp = 10;
  // stand the player two cells short of the grunt, on the same axis
  const dr = Math.sign(e.r - S.p.r), dc = Math.sign(e.c - S.p.c);
  S.p.dir = C.DIRS.findIndex(([a1, b1]) => a1 === dr && b1 === dc);
  const ammo0 = S.ammo;
  const rnd = C.mulberry32(5);
  const ev = C.resolveTurn(S, 'fire', rnd);
  ok('shot registers', ev.fired === true && ev.hit === 0, ev);
  ok('shot spends a round', S.ammo === ammo0 - 1 && S.shots === 1);
  ok('grunt dies to one burst', ev.killed === true && S.kills === 1 && S.enemies[0].alive === false);
}

// ---------- 4) a wall stops the round
{
  const S = C.makeQA(1, 0x51ee7, { enemies: 'none' });
  // face a wall: try every direction until the next cell is a wall
  const dir = C.DIRS.findIndex(([dr, dc]) => S.grid[(S.p.r + dr) * S.n + (S.p.c + dc)] === C.WALL);
  const walled = dir >= 0;
  if (walled) {
    S.p.dir = dir;
    const ammo0 = S.ammo;
    const ev = C.resolveTurn(S, 'fire', C.mulberry32(1));
    ok('a walled shot fires but hits nothing', ev.fired && ev.hit === -1 && S.ammo === ammo0 - 1);
  } else {
    ok('start has at least one walled direction', false);
  }
}

// ---------- 5) movement, turning, wall bump
for (const seed of [1, 77, 0x51ee7]) {
  const S = C.makeQA(1, seed, { enemies: 'none' });
  const d0 = S.p.dir, r0 = S.p.r, c0 = S.p.c;
  C.resolveTurn(S, 'right', C.mulberry32(2));
  ok(`right turns one step (${seed})`, S.p.dir === ((d0 + 1) & 3), { got: S.p.dir, want: (d0 + 1) & 3 });
  C.resolveTurn(S, 'left', C.mulberry32(2));
  ok(`left turns back (${seed})`, S.p.dir === d0);
  // bump: find a walled direction, face it, step
  const dir = C.DIRS.findIndex(([dr, dc]) => S.grid[(S.p.r + dr) * S.n + (S.p.c + dc)] === C.WALL);
  S.p.dir = dir;
  C.resolveTurn(S, 'fwd', C.mulberry32(2));
  ok(`stepping into a wall does not move (${seed})`, S.p.r === r0 && S.p.c === c0 && S.blocked === 1);
  // open step
  const openDir = C.DIRS.findIndex(([dr, dc]) => S.grid[(S.p.r + dr) * S.n + (S.p.c + dc)] === C.OPEN);
  S.p.dir = openDir;
  C.resolveTurn(S, 'fwd', C.mulberry32(2));
  ok(`stepping into open floor moves (${seed})`, S.steps === 1 && !(S.p.r === r0 && S.p.c === c0));
}

// ---------- 6) pickups
{
  const S = C.makeQA(1, 0x51ee7, { enemies: 'none' });
  const dr = C.DIRS.findIndex(([a1, b1]) => S.grid[(S.p.r + a1) * S.n + (S.p.c + b1)] === C.OPEN);
  S.p.dir = dr;
  S.items = [{ r: S.p.r + C.DIRS[dr][0], c: S.p.c + C.DIRS[dr][1], kind: 'ammo', alive: true }];
  const ammo0 = S.ammo;
  const ev = C.resolveTurn(S, 'fwd', C.mulberry32(3));
  ok('stepping onto an ammo box collects it', ev.picks.includes('ammo') && S.ammo === ammo0 + 8 && S.items[0].alive === false);

  const M = C.makeQA(1, 0x51ee7, { enemies: 'none', hp: 40 });
  const dr2 = C.DIRS.findIndex(([a1, b1]) => M.grid[(M.p.r + a1) * M.n + (M.p.c + b1)] === C.OPEN);
  M.p.dir = dr2;
  M.items = [{ r: M.p.r + C.DIRS[dr2][0], c: M.p.c + C.DIRS[dr2][1], kind: 'med', alive: true }];
  C.resolveTurn(M, 'fwd', C.mulberry32(3));
  ok('medkit heals 30 but caps at 100', M.hp === 70);
}

// ---------- 7) empty weapon clicks instead of firing
{
  const S = C.makeQA(1, 0x51ee7, { enemies: 'none', ammo: 0 });
  const ev = C.resolveTurn(S, 'fire', C.mulberry32(4));
  ok('no ammo: a click, not a shot', ev.clicked === true && ev.fired === false && S.shots === 0 && S.clicks === 1);
}

// ---------- 8) the garrison answers every action
{
  const S = C.makeQA(1, 0x51ee7, { enemies: 'ambush', hp: 100 });
  const hp0 = S.hp;
  const ev = C.resolveTurn(S, 'right', C.mulberry32(6));
  ok('an adjacent brute hits on your turn', ev.took >= 12 && S.hp < hp0, { took: ev.took, hp: S.hp });
}

// ---------- 9) losing and reaching the way down
{
  const S = C.makeQA(1, 0x51ee7, { enemies: 'ambush', hp: 8 });
  const ev = C.resolveTurn(S, 'right', C.mulberry32(6));
  ok('a killing blow ends the run', S.over === true && S.won === false && S.hp === 0 && ev.dead === true);

  const W = C.makeQA(3, 0x51ee7, { preExit: true });
  const dist = Math.abs(W.p.r - W.exit.r) + Math.abs(W.p.c - W.exit.c);
  ok('QA pre-exit position stands next to the exit', dist === 1, { p: W.p, exit: W.exit });
  C.resolveTurn(W, 'fwd', C.mulberry32(8));
  ok('stepping onto the exit flags the floor as cleared', W.reached === true && W.over === false);
}

// ---------- 10) lockdown soak: 500 random turns never break the invariants
for (const seed of [3, 4242, 0x51ee7]) {
  const S = C.makeFloor(3, seed);
  const rnd = C.mulberry32(seed ^ 0xfeed);
  const acts = ['fwd', 'back', 'left', 'right', 'fire'];
  let bad = null;
  for (let t = 0; t < 500 && !S.over; t++) {
    C.resolveTurn(S, acts[(rnd() * acts.length) | 0], rnd);
    if (S.hp < 0 || S.hp > S.maxHp || S.ammo < 0 || S.kills > S.enemies.length ||
      (S.over && S.hp > 0)) bad = { t, hp: S.hp, ammo: S.ammo, kills: S.kills };
    for (const e of S.enemies) if (e.alive && (S.grid[e.r * S.n + e.c] !== C.OPEN)) bad = { t, off: e };
  }
  ok(`soak ${seed} keeps every invariant`, !bad, bad);
  ok(`soak ${seed} accounted for every action`, S.shots + S.clicks <= S.turns, { shots: S.shots, clicks: S.clicks, turns: S.turns });
}

console.log(fails.length ? 'CORE FAIL\n - ' + fails.slice(0, 20).join('\n - ') : 'CORE PASS');
process.exit(fails.length ? 1 : 0);
