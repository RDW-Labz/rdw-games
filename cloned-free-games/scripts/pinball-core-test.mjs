#!/usr/bin/env node
// Core test for the Vector Pinball port: slices the // >>>CORE block out of the shipped HTML and
// exercises the exact physics the browser runs.
// usage: node pinball-core-test.mjs [path/to/index.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/vector-pinball/index.html';
const html = readFileSync(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + FILE); process.exit(2); }
const tmp = `/tmp/pinball-core-${process.pid}.mjs`;
writeFileSync(tmp, m[1] + '\nexport { BALL_R, TILT_G, TABLE, TARGET, BALLS, SCORE, WALLS, SLINGS, BUMPERS, FL, FR, FLIP_LEN, FLIP_T, FLIP_REST, FLIP_UP, closestOnSeg, resolveSeg, resolveBumper, resolveFlipper, flipperEnd, matchesLaunch, LAUNCH_VZ };\n');
const C = await import(pathToFileURL(tmp).href);

let fail = 0;
const ok = (name, cond, detail) => { if (!cond) { fail++; console.log('FAIL ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); } else console.log('ok   ' + name); };

// 1) the flipper pair leaves a drain gap at rest, and closes when raised
const tipL = C.flipperEnd(C.FL, C.FL.rest), tipR = C.flipperEnd(C.FR, C.FR.rest);
const gapRest = tipR.x - tipL.x;
const gapMidZ = (tipL.z + tipR.z) / 2;
ok('rest gap wider than the ball so a drain is possible', gapRest > C.BALL_R * 2.1, { gapRest });
ok('flippers point inboard at rest', tipL.x > C.FL.px && tipR.x < C.FR.px);
// The pair does not close horizontally when raised (the tips swing up and back), so the centre
// line between the pivots is the drain in every pose — that is what makes a lost ball possible.
const inMouth = () => ({ x: 0, z: gapMidZ + C.BALL_R * 0.4, vx: 0, vz: 3 });
const mouthRest = inMouth();
const caughtRest = [C.FL, C.FR].reduce((acc, f) => C.resolveFlipper(mouthRest, f, f.rest, 0) || acc, false);
const mouthUp = inMouth();
const caughtUp = [C.FL, C.FR].reduce((acc, f) => C.resolveFlipper(mouthUp, f, f.up, 0) || acc, false);
ok('a ball down the centre line is untouched by the resting flippers', !caughtRest);
ok('the centre line is still open with both flippers raised (drain reachable)', !caughtUp);
ok('raised tips sit above the resting line', C.flipperEnd(C.FL, C.FL.up).z < tipL.z && C.flipperEnd(C.FR, C.FR.up).z < tipR.z);
ok('a raised flipper reaches further up-table than at rest', C.flipperEnd(C.FL, C.FL.up).z < tipL.z - 0.6);
ok('raised tips sit above the resting line', C.flipperEnd(C.FL, C.FL.up).z < tipL.z && C.flipperEnd(C.FR, C.FR.up).z < tipR.z);

// 2) a ball outside the nearest point on a rail is untouched
ok('closestOnSeg clamps to the segment ends', C.closestOnSeg(-99, 0, C.WALLS[0]).x === C.WALLS[0].ax);
const far = { x: 0, z: 0, vx: 0, vz: 0 };
ok('resolveSeg ignores a distant ball', C.resolveSeg(far, C.WALLS[0]) === false);

// 3) a ball driven into the left wall is pushed out and reflected
const hit = { x: C.TABLE.left + 0.05, z: -1, vx: -6, vz: 0 };
const touched = C.resolveSeg(hit, C.WALLS[0]);
ok('resolveSeg reports the contact', touched === true);
ok('ball is pushed clear of the rail', hit.x >= C.TABLE.left + C.BALL_R - 0.01, { x: hit.x });
ok('normal velocity is reflected', hit.vx > 0, { vx: hit.vx });

// 4) a rail with e<1 loses energy, a powered sling gains it
const w1 = { x: C.TABLE.left + 0.05, z: -1, vx: -8, vz: 0 };
C.resolveSeg(w1, C.WALLS[0]);
ok('wall bounce loses speed (e<1)', Math.abs(w1.vx) < 8, { vx: w1.vx });
const sl = C.SLINGS[0];
const mid = { x: (sl.ax + sl.bx) / 2, z: (sl.az + sl.bz) / 2 };
const nx = -0.8, nz = -0.6;
const s1 = { x: mid.x + nx * (C.BALL_R + sl.t - 0.02), z: mid.z + nz * (C.BALL_R + sl.t - 0.02), vx: -nx * 5, vz: -nz * 5 };
C.resolveSeg(s1, sl);
const outSpeed = Math.hypot(s1.vx, s1.vz);
ok('sling throws the ball back faster than it arrived', outSpeed > 5.02, { outSpeed });

// 5) a bumper always leaves with at least its kick
const bm = C.BUMPERS[1];
const b1 = { x: bm.x + 0.01, z: bm.z + 0.01, vx: 0.1, vz: 0.1 };
const bump = C.resolveBumper(b1, bm);
ok('bumper contact reported', bump === true);
const bs = Math.hypot(b1.vx, b1.vz);
ok('bumper kick at least the post power', bs >= bm.kick - 1e-6, { bs, kick: bm.kick });
ok('bumper pushes the ball out of its face', Math.hypot(b1.x - bm.x, b1.z - bm.z) >= C.BALL_R + bm.r - 1e-6);

// 6) a ball lying on the resting flipper is shot up-table by the sweep (the pump calls this per
// substep with the current angle, so sweep it here too)
const surfMid = { x: C.FL.px + Math.cos(C.FL.rest) * C.FLIP_LEN * 0.6, z: C.FL.pz + Math.sin(C.FL.rest) * C.FLIP_LEN * 0.6 };
const nl = { x: Math.sin(C.FL.rest), z: -Math.cos(C.FL.rest) };     // up-table face of the flipper
const rb = { x: surfMid.x + nl.x * (C.BALL_R + C.FLIP_T - 0.02), z: surfMid.z + nl.z * (C.BALL_R + C.FLIP_T - 0.02), vx: 0, vz: 1.2 };
const before = Math.hypot(rb.vx, rb.vz);
let flick = false, ang = C.FL.rest;
for (let i = 0; i < 8; i++) {
  const next = C.FL.rest + (C.FL.up - C.FL.rest) * ((i + 1) / 8);
  flick = C.resolveFlipper(rb, C.FL, next, (next - ang) / 0.01) || flick;
  ang = next;
}
ok('flipper sweep reports contact', flick === true);
ok('a rising flipper sends the ball back up the table', rb.vz < 0, { vz: rb.vz });
ok('the flipper kick adds speed', Math.hypot(rb.vx, rb.vz) > before, { before, after: Math.hypot(rb.vx, rb.vz) });
const away = { x: C.FL.px + Math.cos(C.FL.rest) * C.FLIP_LEN * 0.7, z: C.FL.pz + Math.sin(C.FL.rest) * C.FLIP_LEN * 0.7 + 1.2, vx: 0, vz: 0 };
ok('a flipper far from the ball does not touch it', C.resolveFlipper(away, C.FL, C.FL.rest, 0) === false);

// 7) the launch lane is open at the top and the rollover only fires there
ok('launch rollover fires on the lane exit', C.matchesLaunch({ x: 4.0, z: -5.2 }) === true);
ok('launch rollover stays quiet mid-table', C.matchesLaunch({ x: 0, z: -5.2 }) === false);
ok('plunger speed clears the lane (energy check)', (C.LAUNCH_VZ ** 2) / (2 * C.TILT_G) > Math.abs(C.TABLE.top) * 0.4, { rise: (C.LAUNCH_VZ ** 2) / (2 * C.TILT_G) });

// 8) the table is winnable: one bumper hit per point of the target is a handful of hits
ok('target reachable from bumper scores alone', C.TARGET / C.SCORE.bumper <= 20, { hits: C.TARGET / C.SCORE.bumper });
ok('three balls to a game', C.BALLS === 3);
// 9) every rail and bumper sits inside the frame the camera fits
ok('all rails inside the table box', C.WALLS.every((s) => [s.ax, s.bx].every((x) => x >= C.TABLE.left - 0.05 && x <= C.TABLE.right + 0.05)
  && [s.az, s.bz].every((z) => z >= C.TABLE.top - 0.75 && z <= C.TABLE.bot + 0.05)));
ok('bumpers do not overlap each other', C.BUMPERS.every((a, i) => C.BUMPERS.every((b, j) => i === j || Math.hypot(a.x - b.x, a.z - b.z) > a.r + b.r + C.BALL_R * 0.9)));

console.log(fail ? `PINBALL CORE FAIL (${fail})` : 'PINBALL CORE PASS');
process.exit(fail ? 1 : 0);
