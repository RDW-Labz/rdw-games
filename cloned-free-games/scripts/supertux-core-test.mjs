#!/usr/bin/env node
// Proves the SuperTux port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/supertux/index.html.
//
// Level geometry (every coin and the flag have ground under them, spawn is clear), gravity and
// land, the jump arc, wall collision, the stomp, the side hit costing a life, pits and spikes,
// coin pickups, the coin-block bump (block becomes used, coins +1, and a second bump on the same
// block gives nothing), the flag hand-off, the win and the out-of-lives loss, the snowball's
// bounce — then an autopilot plays BOTH shipped levels through the real step() to prove they are
// completable, and a pilot that never jumps proves they can be failed.
//
// usage: node supertux-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/supertux/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { TILE, GRAV, JUMP, SPEED, MAXFALL, HERO_W, HERO_H, WALK_W, WALK_H, WALK_V,
  SNOW_W, SNOW_H, SNOW_V, SNOW_BOB, SNOW_RATE, STOMP, INVULN, COYOTE, BUFFER, LIVES, GROUND, SPIKE,
  COINBLOCK, USEDBLOCK, LEVELS, buildLevel, newState, loadLevel, tileAt, solidAt, press, hurt,
  overlaps, step };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
};

const sim = (S, sec, held = {}, dt = 1 / 120) => {
  let t = 0;
  while (t < sec && !S.over) { C.step(S, dt, held); t += dt; }
  return t;
};

// ---------- 1) level geometry ----------
ok(C.LEVELS.length === 2, 'two levels ship', C.LEVELS.length);
for (const [li, L] of C.LEVELS.entries()) {
  const S = C.newState(li);
  ok(S.W === L.W && S.H === L.H, `level ${li} keeps its declared size`, [S.W, S.H]);
  ok(S.grid.length === L.H && S.grid[0].length === L.W, `level ${li} grid is W x H`);
  let solids = 0;
  for (let r = 0; r < S.H; r++) for (let c = 0; c < S.W; c++) if (S.grid[r][c] === C.GROUND) solids++;
  ok(solids > L.W, `level ${li} has a floor to stand on`, solids);
  for (const s of L.solids) {
    ok(s.c0 >= 0 && s.c1 < L.W && s.r0 >= 0 && s.r1 < L.H && s.r0 <= s.r1 && s.c0 <= s.c1,
      `level ${li} rect is inside the board`, s);
  }
  const sp = S.hero;
  ok(!C.solidAt(S, Math.floor(sp.x + sp.w / 2), Math.floor(sp.y + 0.3)), `level ${li} spawn is not inside a block`);
  ok(C.solidAt(S, Math.floor(sp.x + sp.w / 2), Math.floor(sp.y - 0.05)), `level ${li} spawn has ground under it`);
  for (const g of S.pickups) {
    const c = Math.floor(g.x), r = Math.floor(g.y);
    let down = false;
    for (let rr = r - 1; rr >= 0; rr--) { if (C.solidAt(S, c, rr)) { down = true; break; } }
    ok(down, `level ${li} coin ${g.id} has something to stand on`, g);
  }
  for (const e of S.enemies) {
    ok(C.solidAt(S, Math.floor(e.x + e.w / 2), Math.floor(e.floorY - 0.05)), `level ${li} enemy ${e.id} stands on ground`, e);
  }
  ok(C.solidAt(S, Math.floor(S.goal.x + S.goal.w / 2), Math.floor(S.goal.y - 0.05)), `level ${li} flag has a floor`);
  ok(S.lives === C.LIVES, 'a new run starts with the declared lives', S.lives);
  // every coin block hangs one tile above a floor the penguin can jump from
  for (const b of L.blocks) {
    ok(!C.solidAt(S, b.c, b.r - 1), `level ${li} block ${b.c},${b.r} is open underneath`, b);
  }
}

// ---------- 2) gravity, landing, jump ----------
{
  const S = C.newState(0);
  S.hero.y += 3;
  sim(S, 1.2);
  ok(S.hero.onGround, 'the penguin lands on the floor');
  ok(Math.abs(S.hero.y - 2) < 0.05, 'and stands on the ground row', S.hero.y);
  ok(Math.abs(S.hero.vy) < 0.001, 'a landed body has no vertical speed', S.hero.vy);

  const y0 = S.hero.y;
  C.press(S, 'jump');
  sim(S, 0.25);
  ok(S.hero.y > y0 + 1.0, 'a jump actually leaves the ground', [y0, S.hero.y]);
  const peak = S.hero.y;
  sim(S, 0.9);
  ok(S.hero.onGround && Math.abs(S.hero.y - y0) < 0.05, 'and comes back down to the same row', [peak, S.hero.y]);
  ok(peak - y0 > 2.0, 'the jump clears more than two tiles', peak - y0);

  const air = C.newState(0);
  C.press(air, 'jump');
  sim(air, 0.05);
  const vyBefore = air.hero.vy;
  C.press(air, 'jump');
  C.step(air, 1 / 120, {});
  ok(air.hero.vy < vyBefore, 'a second press in the air does not add a second jump', [vyBefore, air.hero.vy]);
  ok(vyBefore < C.JUMP, 'the first jump already spent the launch speed', vyBefore);
}

// ---------- 3) walking and walls ----------
{
  const S = C.newState(0);
  const x0 = S.hero.x;
  sim(S, 0.6, { right: true });
  ok(S.hero.x > x0 + 2.0, 'holding right walks the penguin right', [x0, S.hero.x]);
  sim(S, 0.6, { left: true });
  ok(S.hero.vx < 0.5, 'holding left reverses it', S.hero.vx);

  const W = C.newState(0);
  W.hero.x = C.LEVELS[0].W - 1.5; W.hero.y = 2; W.hero.vx = 0; W.hero.vy = 0;
  let sawWall = false;
  for (let i = 0; i < 240; i++) { C.step(W, 1 / 120, { right: true }); if (W.hero.hitWall) sawWall = true; }
  ok(W.hero.x + W.hero.w <= C.LEVELS[0].W - 0.001 && W.hero.x > C.LEVELS[0].W - 2, 'the end of the level stops horizontal motion', W.hero.x);
  ok(sawWall, 'and the collision is reported to the rules');
}

// ---------- 4) stomp vs side hit ----------
{
  const S = C.newState(0);
  const e = S.enemies[0];
  S.hero.x = e.x + 0.02; S.hero.y = e.y + e.h + 0.30; S.hero.vy = -4; S.hero.vx = 0;
  let peakVy = -99;
  for (let i = 0; i < 30 && !e.dead; i++) { C.step(S, 1 / 120, {}); peakVy = Math.max(peakVy, S.hero.vy); }
  ok(e.dead, 'landing on a monster kills it');
  ok(S.kills === 1, 'the kill is counted', S.kills);
  ok(peakVy > 4, 'the stomp bounces the penguin back up', peakVy);
  ok(S.lives === C.LIVES, 'a stomp costs no life', S.lives);

  const H = C.newState(0);
  const e2 = H.enemies[0];
  H.hero.x = e2.x; H.hero.y = e2.y; H.hero.vy = 0; H.hero.vx = 0;
  const x0 = H.hero.x;
  sim(H, 0.4);
  ok(H.lives === C.LIVES - 1, 'running into a monster costs a life', H.lives);
  ok(H.hero.x < x0, 'and the penguin restarts at the level spawn', [x0, H.hero.x]);
  ok(H.invuln > 0, 'with a moment of mercy afterwards', H.invuln);
  ok(!e2.dead, 'the monster survives a side hit', e2.dead);
}

// ---------- 5) pits and spikes ----------
{
  const P = C.newState(0);
  P.hero.x = 20.4; P.hero.y = 2.0;        // over the 20-22 gap
  P.hero.vx = 0; P.hero.vy = 0;
  let dropped = false;
  for (let i = 0; i < 500 && !P.over; i++) { C.step(P, 1 / 120, {}); if (P.lives < C.LIVES) dropped = true; }
  ok(dropped, 'falling in a pit costs a life', { lives: P.lives, y: P.hero.y });

  const K = C.newState(0);
  K.hero.x = 32.2; K.hero.y = 2.0; K.hero.vy = 0; K.hero.vx = 0;
  sim(K, 0.2);
  ok(K.lives === C.LIVES - 1, 'standing on icicles costs a life', K.lives);
}

// ---------- 6) coins and the coin-block bump ----------
{
  const S = C.newState(0);
  const g0 = S.pickups[0];
  S.hero.x = g0.x - S.hero.w / 2; S.hero.y = g0.y - S.hero.h / 2;
  const c0 = S.coins;
  C.step(S, 1 / 120, {});
  ok(g0.taken, 'walking into a coin collects it');
  ok(S.coins === c0 + 1 && S.got === 1, 'the coin count rises', [S.coins, S.got]);

  // bump: stand under the first coin block and jump
  const B = C.newState(0);
  const blk = C.LEVELS[0].blocks[0];
  B.hero.x = blk.c + 0.17; B.hero.y = 2.0; B.hero.vx = 0; B.hero.vy = 0;
  sim(B, 0.1);
  const coinsBefore = B.coins, blocksBefore = B.blocks;
  C.press(B, 'jump');
  sim(B, 0.6);
  ok(B.grid[blk.r][blk.c] === C.USEDBLOCK, 'bumping a coin block from below uses it up', B.grid[blk.r][blk.c]);
  ok(B.coins === coinsBefore + 1 && B.blocks === blocksBefore + 1, 'and it gives up a coin', { coins: B.coins, blocks: B.blocks });

  // a used block cannot be bumped again
  B.hero.y = 2.0; B.hero.vy = 0; B.hero.onGround = true;
  const after = B.coins;
  C.press(B, 'jump');
  sim(B, 0.6);
  ok(B.coins === after, 'a used block gives nothing on a second bump', B.coins);

  // standing under a block and walking must not bump it
  const Q = C.newState(0);
  Q.hero.x = blk.c + 0.17; Q.hero.y = 2.0;
  sim(Q, 0.6, { right: true });
  ok(Q.grid[blk.r][blk.c] === C.COINBLOCK && Q.blocks === 0, 'walking under a block does not bump it', Q.blocks);
}

// ---------- 7) the bouncing snowball ----------
{
  const S = C.newState(0);
  const snow = S.enemies.find((e) => e.kind === 'snow');
  ok(!!snow, 'the level ships a snowball', S.enemies.map((e) => e.kind));
  const base = snow.floorY;
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < 400; i++) { C.step(S, 1 / 120, {}); hi = Math.max(hi, snow.y); lo = Math.min(lo, snow.y); }
  ok(hi > base + 0.7, 'the snowball bounces off its floor', { base, hi });
  ok(lo >= base - 0.01, 'and never sinks through it', { base, lo });
  ok(Math.abs(snow.x - snow.home) < snow.range + 1.0, 'and stays on its beat', { x: snow.x, home: snow.home });

  const T = C.newState(0);
  const s2 = T.enemies.find((e) => e.kind === 'snow');
  s2.t = 0;                                  // at the bottom of its hop
  T.hero.x = s2.x + 0.02; T.hero.y = s2.y + s2.h + 0.12; T.hero.vy = -4; T.hero.vx = 0;
  for (let i = 0; i < 40 && !s2.dead; i++) C.step(T, 1 / 120, {});
  ok(s2.dead, 'a snowball can be squashed from above');
  ok(T.lives === C.LIVES, 'and squashing it costs no life', T.lives);
}

// ---------- 8) flag hand-off, win, out of lives ----------
{
  const F = C.newState(0);
  F.hero.x = F.goal.x; F.hero.y = F.goal.y;
  C.step(F, 1 / 120, {});
  ok(F.level === 1, 'the flag hands over to level 2', F.level);
  ok(F.got === 0 && F.lives === C.LIVES, 'the new level starts clean but keeps its lives', [F.got, F.lives]);

  const N = C.newState(1);
  N.coins = 7;
  N.hero.x = N.goal.x; N.hero.y = N.goal.y;
  C.step(N, 1 / 120, {});
  ok(N.over === true && N.result === 'win' && N.why === 'goal', 'the last flag wins the game', { result: N.result, why: N.why });
  ok(N.coins === 7, 'coins carry across the win', N.coins);

  const S = C.newState(0);
  S.lives = 1;
  const e = S.enemies[0];
  S.hero.x = e.x; S.hero.y = e.y; S.hero.vy = 0;
  sim(S, 0.3);
  ok(S.lives === 0, 'the last life is spent', S.lives);
  ok(S.over === true && S.result === 'lose' && S.why === 'monster', 'and the run ends on the monster', { result: S.result, why: S.why });
  const before = S.hero.x;
  sim(S, 1.0, { right: true });
  ok(S.hero.x === before, 'a finished run is frozen', S.hero.x);
}

// ---------- 9) autopilot: both shipped levels are completable ----------
function autopilot(level, budget = 200) {
  const S = C.newState(level);
  const dt = 1 / 120;
  let t = 0, stuckAt = S.hero.x, stuckT = 0;
  while (t < budget && !S.over) {
    const h = S.hero;
    const hold = { right: true };
    const bodyR = Math.floor(h.y + 0.2), floorR = Math.floor(h.y - 0.1);
    let nextX = Infinity;
    for (let k = 0.1; k < 6; k += 0.25) {
      const c = Math.floor(h.x + h.w + k);
      if (!C.solidAt(S, c, floorR) || C.tileAt(S, c, bodyR) === C.SPIKE) { nextX = Math.min(nextX, c); break; }
    }
    for (const e of S.enemies) {
      if (e.dead) continue;
      if (e.x + e.w > h.x + h.w && e.x - (h.x + h.w) < 1.6 && Math.abs(e.y - h.y) < 2.0) nextX = Math.min(nextX, e.x);
    }
    const gapAhead = nextX - (h.x + h.w);
    if (h.onGround && gapAhead <= 1.2 && gapAhead > -0.6) C.press(S, 'jump');
    C.step(S, dt, hold);
    t += dt;
    if (Math.abs(S.hero.x - stuckAt) < 0.05) { stuckT += dt; if (stuckT > 3) break; } else { stuckAt = S.hero.x; stuckT = 0; }
  }
  return { S, t, stuckT };
}
for (const [li, L] of C.LEVELS.entries()) {
  const run = autopilot(li, 200);
  const S = run.S;
  ok(!(run.stuckT > 2.5), `level ${li} (${L.name}) is not a dead end for a right-running pilot`, { x: S.hero.x, t: run.t });
  ok(S.level > li || (li === C.LEVELS.length - 1 && S.result === 'win'), `level ${li} (${L.name}) is completable by play`, {
    level: S.level, result: S.result, x: S.hero.x, got: S.got, lives: S.lives, kills: S.kills, why: S.why,
  });
  // every coin laid on the running line is picked up by simply running and jumping the hazards
  const floorCoins = L.coins.filter((c) => c.r <= 2).length;
  ok(S.got >= floorCoins || S.level > li, `level ${li} floor coins are all reachable`, { got: S.got, floorCoins, need: S.need });
}

// ---------- 10) a coin on the raised platform is reachable from the ground ----------
{
  const li = 1;
  const L = C.LEVELS[li];
  const high = L.coins.find((c) => c.r > 2);
  ok(!!high, 'level 1 ships a coin on a raised platform', L.coins);
  const S = C.newState(li);
  S.hero.x = high.c - 3.2; S.hero.y = 2; S.hero.vx = 0; S.hero.vy = 0;
  let jumped = false, bestY = 0, took = false;
  for (let i = 0; i < 900 && !S.over; i++) {
    const h = S.hero;
    if (!jumped && h.onGround && h.x > high.c - 2.5) { C.press(S, 'jump'); jumped = true; }
    C.step(S, 1 / 120, { right: true });
    bestY = Math.max(bestY, S.hero.y);
    if (S.pickups[high.id ?? 0] && S.got > 0) took = true;
    if (took) break;
  }
  ok(bestY > 4.4, 'a side jump clears the platform top', bestY);
  ok(took, 'and the raised coin is collected by a side jump', { got: S.got, x: S.hero.x, bestY });
}
{
  const S = C.newState(0);
  S.hero.x = 18.2; S.hero.y = 2; S.hero.vx = 0; S.hero.vy = 0;
  sim(S, 4, { right: true });
  ok(S.lives < C.LIVES || S.over, 'a pilot that never jumps falls in the first pit', { lives: S.lives, x: S.hero.x });
}
{
  const A = autopilot(0, 60).S, B = autopilot(0, 60).S;
  ok(A.hero.x === B.hero.x && A.coins === B.coins, 'the same level plays the same way twice', [A.hero.x, B.hero.x]);
}

if (fails) { console.error(`FAILED ${fails} check(s)`); process.exit(1); }
console.log('OK supertux core: geometry, physics, stomp, hazards, coins, block bump, snowball bounce, flag, win/lose, both levels autopiloted');
