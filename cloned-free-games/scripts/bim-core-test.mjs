#!/usr/bin/env node
// Core-rules test for the Bim! port. Slices the // >>>CORE block out of the SHIPPED page and
// replays the exact rules the browser runs: lattice, arena deals, blast rays and chains, bomb
// occupancy, movement, drops, rival AI safety, and the balance sweep (a passive pilot must lose,
// a competent one must be able to win a round).
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = '/home/cluer/Projects/rdw-games/shelf/games/arcade/bim/index.html';
const src = await readFile(PAGE, 'utf8');
const a = src.indexOf('// >>>CORE');
const b = src.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) { console.error('no CORE block'); process.exit(2); }
const body = src.slice(a, b);
const dir = await mkdtemp(join(tmpdir(), 'bimcore-'));
const mod = join(dir, 'core.mjs');
await writeFile(mod, body + `
export { W, H, FUSE, BLAST_T, RANGE0, SPAWNS, ROUNDS_TO_WIN, DIRS, isHard, mkArena, mkRun, free,
  blastZone, inBlast, dangerMap, placeBomb, moveP, stepToward, aiStep, safeStep, fireTimes, verdict, tick, nextRound,
  explode, liveBombs };
`);
const C = await import(mod);

let n = 0, bad = 0;
const ok = (c, msg, extra) => {
  n++;
  if (c) return true;
  bad++;
  console.log('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---------- 1) lattice ----------
const { W, H } = C;
let hardBad = 0, spawnBad = 0;
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  const border = c === 0 || r === 0 || c === W - 1 || r === H - 1;
  const want = border || (c % 2 === 0 && r % 2 === 0);
  if (C.isHard(c, r) !== want) hardBad++;
}
ok(hardBad === 0, 'stone sits on every even crossing and the whole outer ring', hardBad);
for (const [c, r] of C.SPAWNS) if (C.isHard(c, r)) spawnBad++;
ok(spawnBad === 0, 'all four spawn corners are open', spawnBad);

// every non-stone cell is connected to every other through crates-a-plenty (crates are destructible)
const key = (c, r) => c + ',' + r;
function connected(crate) {
  const seen = new Set([key(1, 1)]);
  const q = [[1, 1]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dc, dr] of C.DIRS || [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dc, ny = y + dr;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H || C.isHard(nx, ny) || seen.has(key(nx, ny))) continue;
      if (crate && crate[ny][nx]) continue;
      seen.add(key(nx, ny)); q.push([nx, ny]);
    }
  }
  return seen.size;
}
{
  const A = C.mkArena(11);
  let nonHard = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (!C.isHard(c, r)) nonHard++;
  ok(connected(false) === nonHard, 'the whole floor is reachable once crates are broken', { got: connected(false), nonHard });
  const A2 = C.mkArena(11);
  ok(JSON.stringify(A.crates) === JSON.stringify(A2.crates), 'a seed rebuilds the same arena');
  const density = A.crates.reduce((s, row) => s + row.filter(Boolean).length, 0) / nonHard;
  ok(density > 0.20 && density < 0.62, 'crate density leaves room to fight', density.toFixed(2));
}

// ---------- 2) blast rays ----------
function bare(seed = 5) {
  const S = C.mkRun(seed, 3);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { S.crates[r][c] = false; S.pups[r][c] = null; }
  for (const p of S.players) p.alive = false;          // park the cast off the board
  return S;
}
{
  const S = bare();
  const zone = [...C.blastZone(S, 5, 3, 2).keys()].sort();
  ok(zone.includes('5,3') && zone.includes('3,3') && zone.includes('7,3') && zone.includes('5,1') && zone.includes('5,5'),
    'a range-2 bomb covers two cells on each arm', zone);
  ok(!zone.includes('1,3') && !zone.includes('9,3'), 'and no further', zone);
  const corner = [...C.blastZone(S, 1, 1, 3).keys()].sort();
  ok(!corner.includes('0,1') && !corner.includes('1,0'), 'the outer ring stops the ray', corner);
  ok(corner.includes('4,1') && corner.includes('1,4'), 'the open arms still run three cells', corner);
}

// ---------- 3) crates stop a ray, chains run through them ----------
{
  const S = bare(7);
  S.crates[3][6] = true;
  S.crates[3][8] = true;
  const cells = C.explode(S, { c: 5, r: 3, range: 4, owner: 0 });
  const hit = cells.map(g => g.c + ',' + g.r);
  ok(S.crates[3][6] === false, 'the first crate on a ray is destroyed', S.crates[3][6]);
  ok(hit.includes('6,3'), 'the crate cell is in the blast', hit);
  ok(!hit.includes('7,3') && S.crates[3][8] === true, 'a crate shields everything behind it', { hit, behind: S.crates[3][8] });
}
{
  const S = bare(7);
  S.bombs.push({ c: 5, r: 3, owner: 0, range: 2, t: 0.01 });
  S.bombs.push({ c: 7, r: 3, owner: 1, range: 2, t: 5 });
  C.explode(S, S.bombs[0]);
  const cells = S.blasts.map(g => g.c + ',' + g.r);
  ok(S.bombs[1].dead === true, 'a blast detonates the next bomb', S.bombs[1].dead);
  ok(cells.includes('9,3'), 'the chained bomb extends the blast past the first range', cells.slice(0, 14));
  ok(S.bombs.filter(b => !b.dead).length === 0, 'both bombs are spent', S.bombs.length);
}

// ---------- 4) crates drop powerups ----------
{
  const S = bare(9);
  S.crates[3][6] = true;
  S.pups[3][6] = 'blast';
  C.explode(S, { c: 5, r: 3, range: 3, owner: 0 });
  ok(S.drops.length === 1 && S.drops[0].kind === 'blast' && S.drops[0].c === 6 && S.drops[0].r === 3, 'a destroyed crate leaves its powerup on the floor', S.drops);
  const me = S.players[0];
  me.alive = true; me.c = 5; me.r = 3; me.blast = 2;
  C.moveP(S, me, { c: 6, r: 3 });
  ok(me.c === 6 && me.r === 3 && me.blast === 3, 'stepping on a powerup takes it', { c: me.c, blast: me.blast });
  ok(S.drops.length === 0, 'and the drop is consumed', S.drops.length);
}

// ---------- 5) bombs block, and you can walk off your own ----------
{
  const S = bare(3);
  const me = S.players[0];
  me.alive = true; me.c = 1; me.r = 1; me.cool = 0; me.bombsMax = 1;
  ok(C.placeBomb(S, 0) === true, 'a bomb lands under the bomber');
  ok(C.free(S, 1, 1) === false, 'a live bomb closes its cell to everyone');
  me.cool = 0;
  ok(C.moveP(S, me, 'right') === true && me.c === 2, 'the bomber steps off its own bomb', { c: me.c });
  me.cool = 0;
  ok(C.moveP(S, me, 'left') === false && me.c === 2, 'and cannot walk back onto it', { c: me.c });
  ok(C.placeBomb(S, 0) === false, 'a second bomb is refused at one bomb capacity', C.liveBombs(S, 0));
  me.bombsMax = 2; me.cool = 0;
  C.placeBomb(S, 0);
  ok(S.bombs.length === 2, 'two bombs once the capacity is two', S.bombs.length);
}

// ---------- 6) blast kills, and the round ends when one side is gone ----------
{
  const S = bare(3);
  const me = S.players[0];
  me.alive = true; me.c = 3; me.r = 3;
  for (const p of S.players.slice(1)) p.alive = false;
  S.bombs.push({ c: 5, r: 3, owner: 1, range: 2, t: 0.2 });
  C.tick(S, 0.3);
  ok(me.alive === false && S.result === 'lose', 'a blast under the bomber loses the run', { alive: me.alive, result: S.result });
  ok(S.why === 'blast', 'the loss names its cause', S.why);
}
{
  const S = bare(3);
  for (const p of S.players) { p.alive = true; p.c = 1; p.r = 1; }
  S.players[0].c = 1; S.players[0].r = 1;
  for (const p of S.players.slice(1)) p.alive = false;
  C.tick(S, 0.05);
  ok(S.result === 'round', 'the last bomber standing wins the round', { result: S.result, alive: S.players.filter(p => p.alive).length });
}

// ---------- 7) rival AI never suicides on the first tick ----------
{
  let early = 0, opened = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const S = C.mkRun(seed * 13, 3);
    S.players[0].alive = true;
    const start = S.players.filter(p => p.alive).length;
    C.tick(S, 0.05);
    const now = S.players.filter(p => p.alive).length;
    if (now < start) early++;
    // does the cast actually fight? play out 60 s with the player parked as a spectator
    let t = 0, kills0 = 0;
    while (t < 60 && !S.over) { C.tick(S, 1 / 30); t += 1 / 30; }
    kills0 = S.kills;
    if (kills0 > 0) opened++;
  }
  ok(early === 0, 'no rival blows itself up on the opening tick', early);
  ok(opened >= 34, 'the rivals actually fight (a kill in 34+ of 40 arenas)', opened);
}

// ---------- 8) balance: passive loses, competent can win ----------
function playout(seed, mode, limit = 150) {
  const S = C.mkRun(seed);
  let t = 0, think = 0;
  while (t < limit && !S.over) {
    C.tick(S, 1 / 30);
    t += 1 / 30;
    if (mode === 'greedy' && !S.over) {
      think += 1 / 30;
      if (think >= 0.22) { think = 0; C.aiStep(S, S.players[0]); }
    }
  }
  return { result: S.result, t: t.toFixed(1), rounds: S.rounds, kills: S.kills, alive: S.players.filter(p => p.alive).length };
}
{
  const seeds = [11, 22, 33, 44, 55];
  const passive = seeds.map(s => playout(s, 'idle'));
  const greedy = seeds.map(s => playout(s, 'greedy'));
  console.log('passive:', JSON.stringify(passive));
  console.log('greedy :', JSON.stringify(greedy));
  ok(passive.every(r => r.result === 'lose'), 'a bomber who never moves loses every arena', passive);
  ok(greedy.some(r => r.result === 'round' || r.result === 'win'), 'a bomber who plays can take a round', greedy);
  ok(greedy.filter(r => r.result === 'win').length <= 3, 'and does not walk it', greedy.map(r => r.result));
}

console.log(bad ? `FAILED — ${bad}/${n}` : `PASS — ${n}/${n} checks`);
process.exit(bad ? 1 : 0);
