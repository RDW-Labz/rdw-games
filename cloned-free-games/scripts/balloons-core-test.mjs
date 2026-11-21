#!/usr/bin/env node
// Proves the Non-Stop Balloons Shooter port's shipped rules against the exact code the browser
// runs: the // >>>CORE ... // <<<CORE block is sliced out of
// games/arcade/balloons-shooter/index.html and driven through whole closed-loop runs at 60 Hz.
//
// Assertions: six waves and a real arena; an idle crossbow is overrun (balloons are a threat); a
// gunner that aims at the most advanced balloon clears all six waves on every seed; both outcomes
// are deterministic for a seed; nothing goes NaN or leaves the arena; one leak costs exactly one
// life; a heavy balloon needs two hits; the cooldown actually rate-limits; a shot down an empty
// bearing scores nothing.
//
// usage: node balloons-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/balloons-shooter/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { newState, step, fireAt, planWave, WAVES, KINDS, ARENA, CORE_R, BAL_R, AR_R, AR_SPEED, COOLDOWN, LIVES0, WAVE_GAP, WAVE_SCORE };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { newState, step, fireAt, WAVES, KINDS, ARENA, CORE_R, BAL_R, AR_R, AR_SPEED, COOLDOWN, LIVES0, WAVE_SCORE } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;

// A competent crossbow: aim at the balloon closest to the red line, i.e. the one with the least
// time left. This is what a player does — the rule of the game is "shoot the next one in".
function gunner(S) {
  if (S.fireT > 0.001) return null;
  let best = null;
  for (const b of S.balloons) if (!best || b.d < best.d) best = b;
  if (!best) return null;
  return { x: best.x, z: best.z, id: best.id };
}

function run(seed, withGunner, maxT = 300) {
  const S = newState(seed);
  let t = 0, bad = 0, minD = ARENA;
  while (!S.over && t < maxT) {
    step(S, DT, withGunner ? gunner(S) : null);
    t += DT;
    for (const b of S.balloons) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.z) || !Number.isFinite(b.d)) bad++;
      if (b.d > ARENA + 0.001) bad++;
      if (b.d < minD) minD = b.d;
    }
    for (const a of S.arrows) if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) bad++;
    if (S.arrows.length > 40) bad++;
  }
  return { S, t, bad, minD };
}

// ---- shape of the game
{
  ok(WAVES.length === 6, 'the run is not six waves', WAVES.length);
  ok(ARENA > 4 && ARENA < 12, 'arena radius is off', ARENA);
  ok(CORE_R < ARENA * 0.3, 'the red line is too far out to be survivable', { CORE_R, ARENA });
  ok(AR_R + BAL_R < 0.75, 'hit radii are absurd', { AR_R, BAL_R });
  const total = WAVES.reduce((a, w) => a + w.n, 0);
  ok(total >= 40, 'too few balloons for a run', total);
  // a balloon must survive a full inbound trip long enough to be shot
  const trip = (ARENA - CORE_R) / WAVES[WAVES.length - 1].sp;
  ok(trip > 4, 'the fastest wave crosses the arena in under 4 s — nothing to aim at', trip);
  console.log(`arena r=${ARENA}, red line r=${CORE_R}, ${total} balloons over ${WAVES.length} waves, slowest-to-fastest trip ${((ARENA - CORE_R) / WAVES[0].sp).toFixed(1)}s..${trip.toFixed(1)}s`);
}

// ---- an idle crossbow is overrun
{
  const { S, t, bad } = run(7, false, 300);
  ok(S.over === true, 'an idle crossbow never loses — nothing threatens it', { lives: S.lives, t: +t.toFixed(1) });
  ok(S.won === false, 'an idle crossbow won', { won: S.won });
  ok(S.lives === 0, 'lives did not reach zero on a loss', S.lives);
  ok(S.escapes >= LIVES0, 'escapes do not add up to the lives lost', { escapes: S.escapes, lives: S.lives });
  ok(!!S.why, 'the loss has no stated cause', S.why);
  ok(bad === 0, 'a balloon or arrow went NaN / left the arena', bad);
  console.log(`idle: over=${S.over} won=${S.won} why="${S.why}" t=${t.toFixed(1)}s score=${S.score} escapes=${S.escapes}`);
}

// ---- a competent crossbow clears all six waves
{
  const seeds = [7, 11, 23, 42, 99];
  const results = seeds.map((sd) => run(sd, true, 300));
  const wins = results.filter((r) => r.S.won).length;
  ok(wins === seeds.length, 'a competent crossbow cannot clear the run on every seed',
    results.map((r) => ({ won: r.S.won, wave: r.S.wave + 1, lives: r.S.lives, t: +r.t.toFixed(0) })));
  ok(results.every((r) => r.bad === 0), 'winning runs put an entity out of bounds', results.map((r) => r.bad));
  ok(results.every((r) => r.S.pops >= 40), 'pops do not add up to the balloons spawned', results.map((r) => r.S.pops));
  ok(results.every((r) => r.S.score > 400 && r.S.score < 3000), 'finishing the run scores oddly', results.map((r) => r.S.score));
  ok(results.every((r) => r.t < 200), 'a full run takes absurdly long', results.map((r) => +r.t.toFixed(0)));
  ok(results.every((r) => r.S.lives >= 1), 'the gunner clears with zero lives left', results.map((r) => r.S.lives));
  console.log('gunner: ' + results.map((r) => `seed${r.S.seed} won=${r.S.won} w=${r.S.wave + 1} lives=${r.S.lives} score=${r.S.score} pops=${r.S.pops} minD=${r.minD.toFixed(2)} ${r.t.toFixed(0)}s`).join(' | '));
}

// ---- determinism
{
  const a = run(23, true, 300).S;
  const b = run(23, true, 300).S;
  ok(a.score === b.score && a.pops === b.pops && a.t === b.t && a.won === b.won,
    'the same seed produced two different runs', { a: [a.score, a.pops, a.t], b: [b.score, b.pops, b.t] });
}

// ---- one leak costs exactly one life, and the loss names its cause
{
  const S = newState(5);
  S.spawnQ = []; S.balloons = [];
  S.balloons = [{ id: 1, a: 0, d: CORE_R - 0.01, kind: 'plain', hp: 1, r: BAL_R, pts: 10, sp: 0.5, wa: 0, x: CORE_R, z: 0 }];
  const l0 = S.lives;
  step(S, DT, null);
  ok(S.lives === l0 - 1, 'a balloon crossing the red line did not cost a life', S.lives);
  ok(S.balloons.length === 0, 'the leaked balloon stayed on the board', S.balloons.length);
  ok(/crossbow/i.test(S.why), 'the leak did not state its cause', S.why);
}

// ---- the last life ends the run
{
  const S = newState(5);
  S.spawnQ = []; S.balloons = [];
  S.lives = 1;
  S.balloons = [{ id: 1, a: 1.0, d: CORE_R, kind: 'swift', hp: 1, r: 0.34, pts: 15, sp: 0.5, wa: 0, x: CORE_R * Math.cos(1), z: CORE_R * Math.sin(1) }];
  step(S, DT, null);
  ok(S.over === true && S.won === false, 'losing the last life did not end the run', { over: S.over, won: S.won });
}

// ---- a shot down the balloon's bearing pops it; a shot down an empty bearing does not
{
  const S = newState(9);
  S.spawnQ = []; S.balloons = []; S.arrows = [];
  S.balloons = [{ id: 1, a: 0.9, d: 4.2, kind: 'plain', hp: 1, r: BAL_R, pts: 10, sp: 0, wa: 0, x: Math.cos(0.9) * 4.2, z: Math.sin(0.9) * 4.2 }];
  const b = S.balloons[0];
  const beforeShots = S.shots, beforePops = S.pops, beforeScore = S.score;
  fireAt(S, b.x - 0.0, b.z);   // straight at it
  let guard = 0;
  while (S.balloons.length && guard++ < 120) step(S, DT, null);
  ok(S.pops === beforePops + 1, 'a shot straight at a balloon did not pop it', { pops: S.pops, shots: S.shots });
  ok(S.score === beforeScore + 10, 'the pop did not score 10', S.score - beforeScore);
  ok(S.shots === beforeShots + 1, 'the shot was not counted', S.shots);

  const T2 = newState(9);
  T2.spawnQ = []; T2.balloons = []; T2.arrows = [];
  T2.balloons = [{ id: 1, a: 2.4, d: 4.2, kind: 'plain', hp: 1, r: BAL_R, pts: 10, sp: 0, wa: 0, x: Math.cos(2.4) * 4.2, z: Math.sin(2.4) * 4.2 }];
  fireAt(T2, 1, 0);   // 90-odd degrees away
  guard = 0;
  while (T2.arrows.length && guard++ < 120) step(T2, DT, null);
  ok(T2.pops === 0, 'a shot down an empty bearing still popped a balloon', T2.pops);
  ok(T2.shots === 1, 'the empty shot was not counted', T2.shots);
}

// ---- a heavy balloon absorbs one hit and dies to the second
{
  const S = newState(9);
  S.spawnQ = []; S.balloons = []; S.arrows = [];
  S.balloons = [{ id: 1, a: 0, d: 4.0, kind: 'heavy', hp: 2, r: KINDS.heavy.r, pts: 20, sp: 0, wa: 0, x: 4.0, z: 0 }];
  fireAt(S, 4, 0);
  let guard = 0;
  while (S.arrows.length && guard++ < 120) step(S, DT, null);
  ok(S.balloons.length === 1 && S.balloons[0].hp === 1, 'the heavy balloon did not survive the first hit', S.balloons.map((b) => b.hp));
  ok(S.pops === 0, 'the heavy balloon popped on the first hit', S.pops);
  S.fireT = 0;
  fireAt(S, 4, 0);
  guard = 0;
  while (S.arrows.length && guard++ < 120) step(S, DT, null);
  ok(S.pops === 1 && S.score === 20, 'the heavy balloon did not die to the second hit / score 20', { pops: S.pops, score: S.score });
}

// ---- the cooldown rate-limits, and a dead-centre aim is refused
{
  const S = newState(4);
  const a1 = fireAt(S, 3, 0);
  const a2 = fireAt(S, -3, 0);
  ok(a1 === true, 'the first shot was refused', a1);
  ok(a2 === false, 'a second shot inside the cooldown was accepted', a2);
  ok(S.blocked >= 1, 'the refused shot was not counted as blocked', S.blocked);
  S.fireT = 0;
  const a3 = fireAt(S, 0.05, -0.02);
  ok(a3 === false, 'a shot at the crossbow itself was accepted', a3);
  ok(COOLDOWN > 0.05 && COOLDOWN < 0.4, 'the cooldown is unusable', COOLDOWN);
  ok(AR_SPEED > 8, 'arrows are too slow to hit anything at range', AR_SPEED);
}

// ---- aiming matters: a pilot that holds one fixed bearing only ever hits balloons on that line
{
  const S = newState(7);
  let t = 0;
  while (!S.over && t < 200) {
    const aim = S.fireT <= 0.001 ? { x: 4.0, z: 0 } : null;   // always fire down +x
    step(S, DT, aim);
    t += DT;
  }
  ok(S.over === true && S.won === false, 'firing down one fixed bearing still won — tracking does not matter', { over: S.over, pops: S.pops, shots: S.shots });
  ok(S.shots > 50, 'the fixed-bearing pilot barely fired', S.shots);
  ok(S.pops < 20, 'a fixed bearing popped most of the board', S.pops);
  console.log(`fixed-bearing: over=${S.over} won=${S.won} shots=${S.shots} pops=${S.pops} why="${S.why}"`);
}

if (fails) { console.error(`\nFAIL: ${fails} assertion(s)`); process.exit(1); }
console.log('\nPASS: balloons-shooter core rules');
