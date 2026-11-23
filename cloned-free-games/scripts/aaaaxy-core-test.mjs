#!/usr/bin/env node
// Proves the AAAAAXY port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/aaaaxy/index.html.
// Assertions: collision, the jump apex, the gravity flip and ceiling walking, floor spikes
// costing a life, the door refusing a gem-less hero, the door clearing with every gem,
// both terminal states, and a plain pilot that finishes all three levels — so no level
// ships unwinnable.
//
// usage: node aaaaxy-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/aaaaxy/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { HERO_W, HERO_H, WALK, JUMP_V, GRAV, COYOTE, LEVELS, parseLevel, mkState, step, press, hurt, hitsSolid, cellAt, isSolidCell, isSpikeCell, rowOf, rowBottom, rowTop, placeHero };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { HERO_W, HERO_H, WALK, JUMP_V, GRAV, LEVELS, mkState, step, press, hitsSolid, cellAt, isSolidCell, isSpikeCell, rowOf, rowBottom } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 120;

// ---- geometry: every level is rectangular, has a spawn, a door and gems
{
  ok(LEVELS.length === 3, 'expected three levels', LEVELS.length);
  for (const def of LEVELS) {
    const w = def.grid[0].length;
    ok(def.grid.every((r) => r.length === w), 'ragged rows in ' + def.name, def.grid.map((r) => r.length));
    ok(def.grid.join('').includes('E'), 'no door in ' + def.name);
    ok(def.grid.join('').includes('P'), 'no spawn in ' + def.name);
    ok(def.grid.join('').includes('o'), 'no gems in ' + def.name);
    ok(def.grid.join('').includes('#'), 'no walls in ' + def.name);
  }
  const apex = (JUMP_V * JUMP_V) / (2 * GRAV);
  ok(apex > 1.6, 'jump apex cannot clear a tile', apex);
  const air = (2 * JUMP_V) / GRAV;
  ok(WALK * air > 4.2, 'a full jump does not cross a two-tile spike patch', WALK * air);
  console.log(`physics: apex=${apex.toFixed(2)} air=${air.toFixed(2)}s reach=${(WALK * air).toFixed(2)}`);
}

// ---- a hero dropped on the floor settles on it
{
  const S = mkState(0, 3);
  for (let i = 0; i < 120; i++) step(S, DT, {});
  ok(S.grounded === true, 'the hero never landed on the floor', { y: S.p.y, g: S.g });
  ok(Math.abs(S.p.y - 1) < 0.06, 'the hero does not rest on top of the floor row', S.p.y);
  ok(hitsSolid(S.L, S.p.x, S.p.y) === false, 'the hero is standing inside a wall');
}

// ---- walk right, gems are collected on the way
{
  const S = mkState(0, 3);
  for (let i = 0; i < 240; i++) step(S, DT, { right: true });
  ok(S.p.x > 5, 'the hero did not walk right', S.p.x);
  ok(S.gems >= 1, 'a gem on the walking line was not collected', { gems: S.gems, x: S.p.x });
}

// ---- gravity flip: the hero rises to the ceiling and walks on it
{
  const S = mkState(0, 3);
  for (let i = 0; i < 60; i++) step(S, DT, {});
  const y0 = S.p.y;
  ok(press(S, 'flip') === true && S.g === -1 && S.flips === 1, 'flip did not invert gravity', { g: S.g });
  for (let i = 0; i < 200; i++) step(S, DT, {});
  ok(S.p.y > y0 + 5, 'the hero did not rise toward the ceiling', { y0, y: S.p.y });
  ok(S.grounded === true, 'the hero never settled on the ceiling', S.p.y);
  ok(Math.abs(S.p.y + HERO_H - (S.L.h - 1)) < 0.1, 'the hero is not standing under the ceiling row', { y: S.p.y, want: S.L.h - 1 - HERO_H });
  const x0 = S.p.x;
  for (let i = 0; i < 120; i++) step(S, DT, { right: true });
  ok(S.p.x > x0 + 1.5, 'the hero cannot walk along the ceiling', { x0, x: S.p.x });
  ok(press(S, 'flip') === true && S.g === 1, 'flipping back failed');
}

// ---- floor spikes cost a life and reload the level; the last one ends the game
{
  const S = mkState(0, 3);
  S.L.coins.forEach((c) => { c.got = true; });
  S.gems = S.total;
  let hurtAt = null;
  for (let i = 0; i < 120 * 8 && !S.deaths; i++) {
    step(S, DT, { right: true });
    if (S.deaths) hurtAt = S.p.x;
  }
  ok(S.deaths === 1 && S.lives === 2, 'walking into the spikes was free', { deaths: S.deaths, lives: S.lives, hurtAt });
  ok(S.gems === 0 && S.L.coins.every((c) => !c.got), 'a death did not reload the level gems');
  ok(S.p.x < 4, 'a death did not put the hero back at the spawn', S.p.x);

  const D = mkState(0, 1);
  for (let i = 0; i < 120 * 8 && !D.over; i++) step(D, DT, { right: true });
  ok(D.over === true && D.won === false && D.why === 'spikes', 'the last life did not end the game on spikes',
    { over: D.over, why: D.why, lives: D.lives });
}

// ---- the door: sealed without every gem, open with them
{
  const S = mkState(0, 3);
  const ex = S.L.exit.c + 0.5;
  S.p.x = ex - 1.4; S.p.y = 1;
  for (let i = 0; i < 60 && !S.cleared; i++) step(S, DT, { right: true });
  ok(S.cleared === false, 'the door opened without the gems', { gems: S.gems, total: S.total });
  ok(S.hints >= 1 && S.blocked >= 1, 'the sealed door did not report a hint', { hints: S.hints });

  const G = mkState(0, 3);
  G.L.coins.forEach((c) => { c.got = true; });
  G.gems = G.total;
  G.p.x = G.L.exit.c + 0.5 - 1.4; G.p.y = 1;
  for (let i = 0; i < 60 && !G.cleared; i++) step(G, DT, { right: true });
  ok(G.cleared === true && G.won === false && G.li === 0, 'the door did not clear the level',
    { cleared: G.cleared, won: G.won });

  // and the last level's door wins the game
  const W = mkState(2, 3);
  W.L.coins.forEach((c) => { c.got = true; });
  W.gems = W.total;
  W.p.x = W.L.exit.c + 0.5 - 0.2;
  W.p.y = rowBottom(W.L, W.L.exit.r) - 0.02;
  W.g = -1;
  for (let i = 0; i < 40 && !W.cleared; i++) step(W, DT, { left: true });
  ok(W.cleared === true && W.won === true, 'the final ceiling door did not win the game',
    { cleared: W.cleared, won: W.won, x: W.p.x, y: W.p.y, ex: W.L.exit.c });
}

// ---- falling out of the world costs a life
{
  const S = mkState(0, 3);
  S.p.x = S.L.exit.c + 0.5;
  S.p.y = -1.6;
  step(S, DT, {});
  ok(S.deaths === 1 && S.lives === 2, 'falling out of the world was free', { deaths: S.deaths, lives: S.lives });
}

// ---- a plain pilot must finish every level: nothing ships unwinnable
function pilot(S, t, memo) {
  const inp = { right: true };
  if (S.grounded) {
    const gy = S.g > 0 ? S.p.y : S.p.y + HERO_H;      // the surface plane under the feet
    const surf = cellAt(S.L, Math.floor(S.p.x + HERO_W / 2 + 0.55), rowOf(S.L, gy - S.g * 0.5));
    const body = rowOf(S.L, S.p.y + HERO_H / 2);
    let danger = false;
    for (let k = 1; k <= 3; k++) {
      const c = Math.floor(S.p.x + HERO_W / 2 + k * 0.5);
      if (isSpikeCell(cellAt(S.L, c, body))) danger = true;
      if (!isSolidCell(cellAt(S.L, c, body + (S.g > 0 ? 1 : -1)))) danger = true;   // a hole ahead
    }
    if (danger || !isSolidCell(surf)) inp.jump = true;
    if (S.stuckT > 0.25 && t - memo.flip > 0.7) { press(S, 'flip'); memo.flip = t; S.stuckT = 0; }
  }
  return inp;
}

for (let li = 0; li < LEVELS.length; li++) {
  const S = mkState(li, 99);
  const memo = { flip: -9 };
  let t = 0, clearedAt = null;
  for (let i = 0; i < 120 * 70 && !S.cleared && !S.over; i++) {
    const inp = pilot(S, t, memo);
    step(S, DT, inp);
    t += DT;
    if (S.cleared && clearedAt === null) clearedAt = t;
  }
  ok(S.cleared === true, 'the pilot could not finish level ' + (li + 1) + ' (' + S.L.name + ')',
    { x: +S.p.x.toFixed(2), y: +S.p.y.toFixed(2), g: S.g, gems: S.gems, total: S.total, deaths: S.deaths, flips: S.flips });
  ok(S.deaths === 0, 'the pilot had to die on level ' + (li + 1), S.deaths);
  console.log(`level ${li + 1} ${S.L.name}: cleared=${S.cleared} in ${clearedAt === null ? '—' : clearedAt.toFixed(1)}s, ${S.gems}/${S.total} gems, ${S.flips} flips`);
}

// ---- determinism of the shipped levels
{
  const A = mkState(1, 3), B = mkState(1, 3);
  for (let i = 0; i < 400; i++) { step(A, DT, { right: true }); step(B, DT, { right: true }); }
  ok(JSON.stringify([A.p, A.gems, A.lives]) === JSON.stringify([B.p, B.gems, B.lives]), 'two identical runs diverged');
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
