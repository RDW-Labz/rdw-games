#!/usr/bin/env node
// Core test for the Super Retro Mega Wars port. Slices the page's // >>>CORE block out of
// the shipped HTML and plays the three games headless at a fixed 1/120 step, so the rules
// asserted here are the exact rules the browser runs (no copy that can drift).
//
//   node scripts/srmw-core-test.mjs [path/to/index.html]
//
// Prints one line per assertion, a balance ladder per game, and exits 1 on any failure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/super-retro-mega-wars/index.html');
const html = readFileSync(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE\n([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + FILE); process.exit(1); }
const EXPORTS = ['W', 'H', 'HALF_W', 'HALF_H', 'DUR', 'TARGET', 'SHIP_Z', 'PADDLE_Z', 'PADDLE_W', 'SERVE_Z',
  'BRICK_COLS', 'BRICK_ROWS', 'BRICK_W', 'BRICK_H', 'SNAKE_COLS', 'SNAKE_ROWS', 'SNAKE_TICK',
  'makeAsteroids', 'stepAsteroids', 'makeBreakout', 'stepBreakout', 'makeSnake', 'stepSnake',
  'pace', 'verdict', 'ballSpeed', 'MODES', 'steer', 'snakeBlocked', 'snakeSpace'];
// The CORE block is sliced from this repo's own shipped page and evaluated here — trusted
// source read off disk, never anything from a request or the network.
const G = new Function(m[1] + '\nreturn {' + EXPORTS.join(',') + '};')();

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) { console.log('ok   ' + msg); return true; }
  fails++;
  console.log('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const STEP = 1 / 120;
const run = (step, S, pilot, seconds) => {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n && !S.over; i++) step(S, STEP, pilot(S, i * STEP));
  return S;
};

console.log('--- structure ---');
ok(G.W === 13 && G.H === 18, 'the arena is 13 x 18 units', [G.W, G.H]);
ok(G.DUR === 60, 'rounds are 60 s', G.DUR);
ok(typeof G.MODES.asteroids === 'object' && G.MODES.breakout && G.MODES.snake, 'three games are declared');
for (const k of ['asteroids', 'breakout', 'snake']) ok(/^[A-Z]/.test(G.MODES[k].label) && G.MODES[k].hint.length > 40, k + ' has a label and a hint');

console.log('--- handicap ---');
ok(G.pace(0) === 1, 'pace starts at 1x', G.pace(0));
ok(G.pace(250) === 2 && G.pace(1000) === 2, 'pace caps at 2x', [G.pace(250), G.pace(1000)]);
ok(G.pace(125) > 1 && G.pace(125) < 2, 'pace rises with the rival score', G.pace(125));

/* ------------------------------- asteroids ------------------------------- */
console.log('--- asteroids ---');
const A0 = G.makeAsteroids(7);
ok(A0.lives[0] === 3 && A0.lives[1] === 3, 'both hulls start with 3 lives', A0.lives);
ok(A0.rocks.length === 1 && A0.rocks[0].z < 0, 'one rock opens the round', A0.rocks);
ok(A0.over === false && A0.you === 0 && A0.cpu === 0, 'a fresh round is 0-0', [A0.you, A0.cpu]);

const A1 = G.makeAsteroids(11);
G.stepAsteroids(A1, 1.4, { x: 0 });
ok(A1.lives[0] === 3 && !A1.over, 'an idle visitor is not hit inside 1.4 s', { lives: A1.lives, t: A1.t });

const idle = [];
for (let s = 1; s <= 12; s++) idle.push(run(G.stepAsteroids, G.makeAsteroids(s), () => ({ x: 0 }), 70));
ok(idle.every((S) => S.over), 'every idle round reaches a verdict', idle.map((S) => S.result));
ok(idle.every((S) => S.result === 'lose'), 'an idle visitor never wins asteroids', idle.map((S) => [S.you, S.cpu, S.result]));
ok(idle.every((S) => S.lives[0] <= 0 || S.cpu >= G.TARGET || S.t >= S.dur), 'idle rounds end on the bell, a wipe-out or the cpu target');

// a pilot that defends its lane: lead the rock that will reach its hull soonest
const astPilot = (S) => {
  let tgt = null, best = 1e9;
  for (const r of S.rocks) {
    const rel = 26 + r.vz;
    if (rel <= 1) continue;
    const tta = (G.SHIP_Z - 0.95 - r.z) / rel;
    if (tta < 0) continue;
    const x = r.x + r.vx * tta;
    const threat = r.vz > 0 ? (G.SHIP_Z - r.z) / r.vz : 99;
    const s = threat + Math.abs(x - S.shipX[0]) * 0.4 + tta * 0.2;
    if (s < best) { best = s; tgt = { x }; }
  }
  return { x: tgt ? tgt.x : S.shipX[0], fire: !!tgt && Math.abs(tgt.x - S.shipX[0]) < 0.35 };
};
let astWins = 0, astScore = 0;
const astRows = [];
for (let s = 1; s <= 40; s++) {
  const S = run(G.stepAsteroids, G.makeAsteroids(s), astPilot, 70);
  astRows.push(`${s}:${S.you}-${S.cpu}:${S.result}:${S.lives[0]}L`);
  if (S.result === 'win') astWins++;
  astScore += S.you;
}
console.log('asteroids ladder (seed:you-cpu:result:lives) ' + astRows.join(' '));
console.log(`asteroids: a lane-defending pilot wins ${astWins}/40, mean score ${(astScore / 40).toFixed(1)}`);
ok(astWins >= 12, 'a lane-defending pilot wins at least 12 of 40 asteroidal rounds', astWins);
ok(astScore / 40 > 40, 'that pilot actually scores', astScore / 40);

// a kill: one rock above the ship, the cpu disarmed
const A2 = G.makeAsteroids(3);
A2.rocks = [{ id: 0, x: 0, z: -2.2, vx: 0, vz: 0.6, r: 0.8 }];
A2.invuln = [9, 9];
A2.cool = [0, 9];
for (let i = 0; i < 240 && A2.rocks.length; i++) G.stepAsteroids(A2, STEP, { x: 0, fire: true });
ok(A2.rocks.length === 0, 'a shot clears the rock above the ship', A2.rocks.length);
ok(A2.you > 0, 'a kill scores for the visitor', A2.you);

// the target ends the round immediately
const A3 = G.makeAsteroids(5);
A3.you = G.TARGET - 10;
A3.rocks = [{ id: 0, x: 0, z: -2.0, vx: 0, vz: 0.3, r: 0.7 }];
A3.invuln = [9, 9];
A3.cool = [0, 9];
for (let i = 0; i < 240 && !A3.over; i++) G.stepAsteroids(A3, STEP, { x: 0, fire: true });
ok(A3.over && A3.result === 'win', 'reaching the target ends the round as a win', { over: A3.over, result: A3.result, you: A3.you });
ok(A3.you >= G.TARGET, 'the target is ' + G.TARGET, A3.you);

// losing the third hull ends the round
const A4 = G.makeAsteroids(6);
A4.lives = [1, 3];
A4.invuln = [0, 0];
A4.cool = [0, 9];
A4.rocks = [{ id: 0, x: 0, z: G.SHIP_Z - 2.2, vx: 0, vz: 6, r: 0.9 }];
for (let i = 0; i < 240 && !A4.over; i++) G.stepAsteroids(A4, STEP, { x: 0 });
ok(A4.over && A4.result === 'lose' && A4.lives[0] === 0, 'a rock on the last hull ends the round as a loss', { over: A4.over, result: A4.result, lives: A4.lives });

/* ------------------------------- breakout ------------------------------- */
console.log('--- breakout ---');
const B0 = G.makeBreakout(9);
ok(B0.bricks.length === G.BRICK_COLS * G.BRICK_ROWS * 2, 'two 9 x 4 walls face each other', B0.bricks.length);
ok(B0.bricks.filter((b) => b.side === 0).every((b) => b.z > 1.5), 'your wall sits in your half', B0.bricks.filter((b) => b.side === 0).map((b) => b.z));
ok(B0.bricks.filter((b) => b.side === 1).every((b) => b.z < -1.5), 'the cpu wall sits in its half', B0.bricks.filter((b) => b.side === 1).map((b) => b.z));
ok(B0.balls.length === 2 && Math.abs(B0.balls[0].z - G.SERVE_Z) < 1e-6 && Math.abs(B0.balls[1].z + G.SERVE_Z) < 1e-6, 'one ball is served each end', B0.balls.map((b) => b.z));

const bidle = [];
for (let s = 1; s <= 10; s++) bidle.push(run(G.stepBreakout, G.makeBreakout(s), () => ({ x: 0 }), 70));
ok(bidle.every((S) => S.over), 'every idle breakout round reaches a verdict');
ok(bidle.every((S) => S.result !== 'win'), 'an idle visitor never wins breakout', bidle.map((S) => [S.you, S.cpu, S.result]));

const paddlePilot = (S) => ({ x: S.balls[0].x });
let bw = 0, bBroken = 0, bCpu = 0;
const bRows = [];
for (let s = 1; s <= 12; s++) {
  const S = run(G.stepBreakout, G.makeBreakout(s), paddlePilot, 70);
  bRows.push(`${s}:${S.you}-${S.cpu}:${S.result}:${S.broken[0]}-${S.broken[1]}`);
  if (S.result === 'win') bw++;
  bBroken += S.broken[0];
  bCpu += S.broken[1];
}
console.log('breakout ladder (seed:you-cpu:result:yourbricks-cpubricks) ' + bRows.join(' '));
console.log(`breakout: a ball-tracking paddle wins ${bw}/12, breaks ${(bBroken / 12).toFixed(1)} own bricks (cpu ${(bCpu / 12).toFixed(1)})`);
ok(bBroken / 12 > 12, 'a tracking paddle breaks a real share of its wall', bBroken / 12);
ok(bw >= 1, 'a ball-tracking paddle can win breakout', bw);

// a brick broken by your ball scores 10 for you
const B2 = G.makeBreakout(4);
B2.bricks = B2.bricks.filter((b) => b.side === 1).concat([{ x: 0, z: 3.0, hp: 1, row: 0, col: 0, side: 0 }]);
B2.balls[0] = { x: 0, z: 4.6, vx: 0, vz: -9, r: 0.34, wait: 0 };
for (let i = 0; i < 240 && B2.you === 0; i++) G.stepBreakout(B2, STEP, { x: 0 });
ok(B2.you === 10, 'a brick your ball breaks banks 10', B2.you);
ok(!B2.bricks.some((b) => b.side === 0 && b.hp > 0), 'that brick is gone', B2.bricks.filter((b) => b.side === 0));

// clearing your wall wins outright, whatever the score
const B3 = G.makeBreakout(4);
B3.bricks = B3.bricks.filter((b) => b.side === 1);
G.stepBreakout(B3, STEP, { x: 0 });
ok(B3.over && B3.result === 'win', 'clearing your wall ends the round as a win', { over: B3.over, result: B3.result });

// the cpu clearing its wall loses it
const B4 = G.makeBreakout(4);
B4.bricks = B4.bricks.filter((b) => b.side === 0);
G.stepBreakout(B4, STEP, { x: 0 });
ok(B4.over && B4.result === 'lose', 'the cpu clearing its wall ends the round as a loss', { over: B4.over, result: B4.result });

// missed balls cost 3 and re-serve inside the owner's half
const B5 = G.makeBreakout(14);
B5.balls[0] = { x: 0, z: G.HALF_H + 0.75, vx: 0, vz: 9, r: 0.34, wait: 0 };
B5.you = 10;
G.stepBreakout(B5, STEP, { x: 0 });
ok(B5.misses[0] === 1 && B5.you === 7, 'a missed ball costs 3 and re-serves', { misses: B5.misses, you: B5.you });
ok(B5.balls[0].z <= G.HALF_H, 'the re-served ball is back inside your half', B5.balls[0].z);

// neither ball can leave the arena
let tunnel = 0;
for (let s = 1; s <= 6; s++) {
  const S = run(G.stepBreakout, G.makeBreakout(s), paddlePilot, 70);
  for (const B of S.balls) if (B.z > G.HALF_H + 1.0 || B.z < -G.HALF_H - 1.0) tunnel++;
}
ok(tunnel === 0, 'no ball ends a frame outside the arena', tunnel);

/* -------------------------------- snake -------------------------------- */
console.log('--- snake ---');
const S0 = G.makeSnake(2);
ok(S0.bodies[0].length === 3 && S0.bodies[1].length === 3, 'both snakes start three long', S0.bodies.map((b) => b.length));
ok(S0.pellets.length === 2, 'two pellets are on the board', S0.pellets);
ok(S0.pellets.every((p) => !S0.bodies.some((b) => b.some(([c, r]) => c === p.c && r === p.r))), 'no pellet spawns on a snake');
ok(S0.started === false, 'the visitor snake waits for a first steer');

const S1 = G.makeSnake(2);
run(G.stepSnake, S1, () => ({}), 6);
ok(S1.t > 5.9, 'an idle round keeps ticking', S1.t);
ok(S1.over === false, 'an idle visitor is not killed at once', { over: S1.over, bodies: S1.bodies[0] });
ok(S1.bodies[0].length === 3 && S1.bodies[0][0][0] === 2, 'the unsteered snake stays put', S1.bodies[0]);
ok(S1.cpu > 0, 'the cpu eats while the visitor waits', S1.cpu);

// determinism
const S2a = G.makeSnake(31), S2b = G.makeSnake(31);
run(G.stepSnake, S2a, (S) => ({ dir: S.t < 0.2 ? [1, 0] : null }), 12);
run(G.stepSnake, S2b, (S) => ({ dir: S.t < 0.2 ? [1, 0] : null }), 12);
ok(JSON.stringify(S2a.bodies) === JSON.stringify(S2b.bodies) && S2a.cpu === S2b.cpu, 'the same seed plays the same round', { a: S2a.cpu, b: S2b.cpu });

// a pellet straight ahead
const S3 = G.makeSnake(5);
S3.started = true;
S3.bodies[0] = [[2, 9], [1, 9], [0, 9]];
S3.want[0] = [1, 0];
S3.pellets = [{ c: 3, r: 9 }, { c: 11, r: 2 }];
const y0 = S3.you, len0 = S3.bodies[0].length;
for (let i = 0; i < 40 && S3.you === y0; i++) G.stepSnake(S3, G.SNAKE_TICK * 0.5, {});
ok(S3.you === y0 + 10, 'eating a pellet scores 10', S3.you);
ok(S3.bodies[0].length > len0, 'eating grows the snake', S3.bodies[0].length);
ok(S3.bodies[0][0][0] === 3, 'the head moved onto the pellet cell', S3.bodies[0][0]);

// steering into a wall costs 10 and respawns you short
const S4 = G.makeSnake(6);
S4.started = true;
S4.cpuAuto = false;
S4.you = 50;
S4.dirs[0] = [0, -1]; S4.want[0] = [0, -1];
S4.bodies[0] = [[2, 1], [1, 1], [0, 1]];
S4.bodies[1] = [[4, 16], [5, 16], [6, 16]];
S4.dirs[1] = [1, 0]; S4.want[1] = [1, 0];
for (let i = 0; i < 1200 && S4.respawns[0] === 0; i++) G.stepSnake(S4, STEP, {});
ok(S4.you === 40, 'hitting a wall costs 10 points', S4.you);
ok(S4.respawns[0] === 1 && S4.alive[0] === true, 'the dead snake respawns', { respawns: S4.respawns, alive: S4.alive });
ok(S4.bodies[0].length === 3, 'the respawn is a fresh three-cell snake', S4.bodies[0]);
ok(S4.over === false, 'a wall does not end the round', S4.over);

// the cpu hitting a wall costs it 10
const S5 = G.makeSnake(8);
S5.started = true;
S5.cpuAuto = false;
S5.cpu = 50;
S5.bodies[1] = [[6, 0], [6, 1], [6, 2]];
S5.dirs[1] = [0, -1]; S5.want[1] = [0, -1];
for (let i = 0; i < 900 && S5.respawns[1] === 0; i++) G.stepSnake(S5, STEP, {});
ok(S5.cpu === 40, 'the cpu loses 10 for hitting a wall', S5.cpu);
ok(S5.respawns[1] === 1 && S5.over === false, 'the cpu comes back without ending the round', { respawns: S5.respawns, over: S5.over });

// the cpu survives a long idle round
const S6 = G.makeSnake(12);
run(G.stepSnake, S6, () => ({}), 45);
ok(S6.cpu > S6.you, 'the cpu leads an idle round on points', [S6.you, S6.cpu]);
ok(S6.you === 0, 'an idle visitor scores nothing', S6.you);

// an equally-matched visitor: same steering rule the cpu uses, so the ladder measures
// the board, not the pilot
const snakePilot = (S) => {
  if (!S.alive[0]) return { dir: null };
  G.steer(S, 0);
  return { dir: S.want[0] };
};
let sw = 0; const sRows = [];
for (let s = 1; s <= 40; s++) {
  const S = run(G.stepSnake, G.makeSnake(100 + s), snakePilot, 70);
  sRows.push(`${100 + s}:${S.you}-${S.cpu}:${S.result}:a${S.ate[0]}-${S.ate[1]}:r${S.respawns[0]}-${S.respawns[1]}`);
  if (S.result === 'win') sw++;
}
console.log('snake ladder (seed:you-cpu:result) ' + sRows.join(' '));
console.log(`snake: an even visitor wins ${sw}/40`);
ok(sw >= 2, 'a competent visitor can win snake', sw);
ok(sw < 20, 'snake is not a free win', sw);

console.log(`\n${checks - fails}/${checks} assertions passed`);
if (fails) { console.log('FAIL ' + fails); process.exit(1); }
console.log('PASS');
