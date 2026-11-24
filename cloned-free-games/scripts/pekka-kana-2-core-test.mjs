#!/usr/bin/env node
// Proves the Pekka Kana 2 port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/pekka-kana-2/index.html.
//
// Level geometry (every egg and door has ground under it, spawn is clear), gravity and land,
// the jump arc, wall collision, the stomp, the side hit costing a life, pits and spikes,
// egg pickups, the door needing every egg, the level hand-off, the win and the out-of-lives
// loss — then an autopilot plays BOTH shipped levels through the real step() to prove they
// are completable, and a too-late jump proves the levels can be failed by play.
//
// usage: node pekka-kana-2-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/pekka-kana-2/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { TILE, GRAV, JUMP, SPEED, MAXFALL, HERO_W, HERO_H, ENEMY_W, ENEMY_H, ENEMY_V,
  STOMP, INVULN, COYOTE, BUFFER, LIVES, LEVELS, buildLevel, newState, loadLevel, tileAt, solidAt,
  press, hurt, overlaps, step };`;
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
  ok(S.grid.length === L.H && S.grid[0].length === L.W, `level ${li} grid is W x H`, [S.grid.length, S.grid[0].length]);
  let solids = 0;
  for (let r = 0; r < S.H; r++) for (let c = 0; c < S.W; c++) if (S.grid[r][c] === 1) solids++;
  ok(solids > L.W, `level ${li} has a floor to stand on`, solids);
  for (const s of L.solids) {
    ok(s.c0 >= 0 && s.c1 < L.W && s.r0 >= 0 && s.r1 < L.H && s.r0 <= s.r1 && s.c0 <= s.c1,
      `level ${li} rect is inside the board`, s);
  }
  // spawn stands on solid ground, not inside it
  const sp = S.hero;
  ok(!C.solidAt(S, Math.floor(sp.x + sp.w / 2), Math.floor(sp.y + 0.3)), `level ${li} spawn is not inside a block`);
  ok(C.solidAt(S, Math.floor(sp.x + sp.w / 2), Math.floor(sp.y - 0.05)), `level ${li} spawn has ground under it`);
  // every egg, enemy and the door has ground under it (nothing floats unreachable)
  for (const g of S.eggs) {
    const c = Math.floor(g.x), r = Math.floor(g.y);
    let down = false;
    for (let rr = r - 1; rr >= 0; rr--) { if (C.solidAt(S, c, rr)) { down = true; break; } }
    ok(down, `level ${li} egg ${g.id} has something to stand on`, g);
  }
  for (const e of S.enemies) {
    ok(C.solidAt(S, Math.floor(e.x + e.w / 2), Math.floor(e.y - 0.05)), `level ${li} enemy ${e.id} stands on ground`, e);
  }
  ok(C.solidAt(S, Math.floor(S.door.x + S.door.w / 2), Math.floor(S.door.y - 0.05)), `level ${li} door has a floor`);
  ok(S.need === L.eggs.length, `level ${li} needs every egg`, [S.need, L.eggs.length]);
  ok(S.lives === C.LIVES, 'a new run starts with the declared lives', S.lives);
}

// ---------- 2) gravity, landing, jump ----------
{
  const S = C.newState(0);
  S.hero.y += 3;
  sim(S, 1.2);
  ok(S.hero.onGround, 'the rooster lands on the floor');
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
  C.press(air, 'jump');           // no double jump: the air press must not re-launch
  C.step(air, 1 / 120, {});
  ok(air.hero.vy < vyBefore, 'a second press in the air does not add a second jump', [vyBefore, air.hero.vy]);
  ok(vyBefore < C.JUMP, 'the first jump already spent the launch speed', vyBefore);
}

// ---------- 3) walking and walls ----------
{
  const S = C.newState(0);
  const x0 = S.hero.x;
  sim(S, 0.6, { right: true });
  ok(S.hero.x > x0 + 2.0, 'holding right walks the bird right', [x0, S.hero.x]);
  sim(S, 0.6, { left: true });
  ok(S.hero.vx < 0.5, 'holding left reverses it', S.hero.vx);

  // the level's right wall must stop a walker
  const W = C.newState(0);
  W.hero.x = C.LEVELS[0].W - 1.5; W.hero.y = 2; W.hero.vx = 0; W.hero.vy = 0;
  let sawWall = false;
  for (let i = 0; i < 200; i++) { C.step(W, 1 / 120, { right: true }); if (W.hero.hitWall) sawWall = true; }
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
  ok(peakVy > 4, 'the stomp bounces the rooster back up', peakVy);
  ok(S.lives === C.LIVES, 'a stomp costs no life', S.lives);

  const H = C.newState(0);
  const e2 = H.enemies[0];
  H.hero.x = e2.x; H.hero.y = e2.y; H.hero.vy = 0; H.hero.vx = 0;
  const x0 = H.hero.x;
  sim(H, 0.4);
  ok(H.lives === C.LIVES - 1, 'running into a monster costs a life', H.lives);
  ok(H.hero.x < x0, 'and the rooster restarts at the level spawn', [x0, H.hero.x]);
  ok(H.invuln > 0, 'with a moment of mercy afterwards', H.invuln);
  ok(!e2.dead, 'the monster survives a side hit', e2.dead);
}

// ---------- 5) pits and spikes ----------
{
  const P = C.newState(0);
  P.hero.x = 21.4; P.hero.y = 2.0;          // over the 21-23 gap
  P.hero.vx = 0; P.hero.vy = 0;
  let dropped = false;
  for (let i = 0; i < 400 && !P.over; i++) { C.step(P, 1 / 120, {}); if (P.lives < C.LIVES) dropped = true; }
  ok(dropped, 'falling in a pit costs a life', { lives: P.lives, y: P.hero.y });

  const K = C.newState(0);
  K.hero.x = 16.2; K.hero.y = 2.0; K.hero.vy = 0; K.hero.vx = 0;
  sim(K, 0.2);
  ok(K.lives === C.LIVES - 1, 'standing on spikes costs a life', K.lives);
}

// ---------- 6) eggs, door, level hand-off ----------
{
  const S = C.newState(0);
  const g0 = S.eggs[0];
  S.hero.x = g0.x - S.hero.w / 2; S.hero.y = g0.y - S.hero.h / 2;
  C.step(S, 1 / 120, {});
  ok(g0.taken, 'walking into an egg collects it');
  ok(S.got === 1, 'the egg count rises', S.got);

  const D = C.newState(0);
  D.hero.x = D.door.x; D.hero.y = D.door.y;
  C.step(D, 1 / 120, {});
  ok(D.level === 0 && !D.over, 'the door refuses to open before every egg is in', { level: D.level, got: D.got });

  const F = C.newState(0);
  F.eggs.forEach((g) => { g.taken = true; }); F.got = F.need;
  F.hero.x = F.door.x; F.hero.y = F.door.y;
  C.step(F, 1 / 120, {});
  ok(F.level === 1, 'the door hands over to level 2', F.level);
  ok(F.got === 0, 'the new level starts with no eggs', F.got);
  ok(F.lives === C.LIVES && F.kills === 0, 'lives carry over, level state does not', [F.lives, F.kills]);

  const N = C.newState(1);
  N.eggs.forEach((g) => { g.taken = true; }); N.got = N.need;
  N.hero.x = N.door.x; N.hero.y = N.door.y;
  C.step(N, 1 / 120, {});
  ok(N.over === true && N.result === 'win' && N.why === 'door', 'the last door wins the game', { result: N.result, why: N.why });
}

// ---------- 7) out of lives ----------
{
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

// ---------- 8) autopilot: both shipped levels are completable ----------
function autopilot(level, budget = 150) {
  const S = C.newState(level);
  const dt = 1 / 120;
  let t = 0, stuckAt = S.hero.x, stuckT = 0;
  while (t < budget && !S.over) {
    const h = S.hero;
    const hold = { right: true };
    // the next thing worth jumping: the first pit column, spike column or live monster ahead
    const bodyR = Math.floor(h.y + 0.2), floorR = Math.floor(h.y - 0.1);
    let nextX = Infinity;
    for (let k = 0.1; k < 6; k += 0.25) {
      const c = Math.floor(h.x + h.w + k);
      if (!C.solidAt(S, c, floorR) || C.tileAt(S, c, bodyR) === 2) { nextX = Math.min(nextX, c); break; }
    }
    for (const e of S.enemies) {
      if (e.dead) continue;
      if (e.x + e.w > h.x + h.w && e.x - (h.x + h.w) < 6 && Math.abs(e.y - h.y) < 1.4) nextX = Math.min(nextX, e.x);
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
  const run = autopilot(li, 150);
  const S = run.S;
  ok(!(run.stuckT > 2.5), `level ${li} (${L.name}) is not a dead end for a right-running pilot`, { x: S.hero.x, t: run.t });
  ok(S.level > li || (li === 1 && S.result === 'win'), `level ${li} (${L.name}) is completable by play`, {
    level: S.level, result: S.result, x: S.hero.x, got: S.got, need: S.need, lives: S.lives, kills: S.kills, why: S.why,
  });
  ok(S.got >= S.need || S.level > li, `level ${li} eggs are all reachable`, { got: S.got, need: S.need });
}
{
  // a pilot that never jumps must fail: pits cannot be walked over
  const S = C.newState(0);
  S.hero.x = 19.2; S.hero.y = 2; S.hero.vx = 0; S.hero.vy = 0;
  sim(S, 4, { right: true });
  ok(S.lives < C.LIVES || S.over, 'a pilot that never jumps falls in the first pit', { lives: S.lives, x: S.hero.x });
}

// ---------- 9) determinism ----------
{
  const A = autopilot(0, 60).S, B = autopilot(0, 60).S;
  ok(A.hero.x === B.hero.x && A.got === B.got, 'the same level plays the same way twice', [A.hero.x, B.hero.x]);
}

if (fails) { console.error(`FAILED ${fails} check(s)`); process.exit(1); }
console.log('OK pekka-kana-2 core: geometry, physics, stomp, hazards, eggs, door, win/lose, both levels autopiloted');
