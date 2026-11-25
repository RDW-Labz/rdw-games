#!/usr/bin/env node
// Proves the OpenSGolf port's rules with the exact // >>>CORE block the browser runs, sliced
// straight out of games/arcade/opensgolf/index.html — no second copy of the physics.
//
// The load-bearing test is the last one: it replays, in pure JS, the *same* shot the browser gate
// will play (aim quantised to the keyboard's 0.5° step, power to its 1% step) and requires every
// hole to be finished inside the 10-stroke pickup limit. If the course or the physics drifts, this
// fails here in a second instead of after a four-minute headless-chromium run.
//
// usage: node opensgolf-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/opensgolf/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { PHYS, HOLES, DEG, segDist, inAny, surfaceAt, shotSpeed, powerForDistance, clubFor, scoreLabel, scorecard, stepBall };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { PHYS, HOLES, DEG, segDist, surfaceAt, shotSpeed, powerForDistance, clubFor, scoreLabel, scorecard, stepBall } = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; return false; }
  console.log('  ok   ' + msg); return true;
};

// ---------- course shape ----------
console.log('\ncourse');
ok(HOLES.length === 3, 'three holes ship', { got: HOLES.length });
ok(HOLES.every((h) => h.par >= 3 && h.par <= 5), 'every hole carries a real par', HOLES.map((h) => h.par));
ok(HOLES.map((h) => h.par).join('') === '345', 'the course is a par 3, 4 then 5', HOLES.map((h) => h.par));
ok(HOLES.every((h) => Math.hypot(h.pin.x - h.tee.x, h.pin.z - h.tee.z) > 30), 'every hole is longer than a single wedge', HOLES.map((h) => +Math.hypot(h.pin.x - h.tee.x, h.pin.z - h.tee.z).toFixed(0)));

for (const h of HOLES) {
  console.log(`\nhole ${h.name} (par ${h.par})`);
  ok(surfaceAt(h, h.tee.x, h.tee.z) !== 'water', 'the tee is not in water');
  ok(surfaceAt(h, h.pin.x, h.pin.z) === 'green', 'the pin sits on the green');
  ok(h.bunkers.every((b) => surfaceAt(h, b.x, b.z) === 'sand'), 'bunkers read as sand');
  ok(h.water.every((w) => surfaceAt(h, w.x, w.z) === 'water'), 'water reads as water');

  // the line of play must be free of trees and water, or the bot (and a naive player) is walled off
  const blocked = [];
  for (const t of h.trees) if (segDist(t.x, t.z, h.tee, h.pin) < t.r + 4) blocked.push(['tree', t]);
  for (const w of h.water) if (segDist(w.x, w.z, h.tee, h.pin) < w.r + 3) blocked.push(['water', w]);
  ok(blocked.length === 0, 'trees and water are clear of the tee-to-pin corridor', blocked);

  // and the straight line itself is fairway or green all the way
  let line = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    line.push(surfaceAt(h, h.tee.x + (h.pin.x - h.tee.x) * t, h.tee.z + (h.pin.z - h.tee.z) * t));
  }
  ok(line.every((s) => s === 'fairway' || s === 'green'), 'the straight line plays as fairway into the green',
    line.filter((s) => s !== 'fairway' && s !== 'green').slice(0, 3));
}

// ---------- clubs and scoring ----------
console.log('\nclubs and scoring');
ok(clubFor(3) === 'Putter' && clubFor(12) === 'Wedge' && clubFor(30) === 'Iron' && clubFor(80) === 'Driver',
  'the club suggestion follows the distance', [clubFor(3), clubFor(12), clubFor(30), clubFor(80)]);
ok(scoreLabel(-2) === 'eagle' && scoreLabel(-1) === 'birdie' && scoreLabel(0) === 'par' &&
  scoreLabel(1) === 'bogey' && scoreLabel(2) === 'double bogey' && scoreLabel(5) === '+5',
  'every score name lands on the right number', [scoreLabel(-2), scoreLabel(-1), scoreLabel(0), scoreLabel(1), scoreLabel(2), scoreLabel(5)]);

const card = scorecard(HOLES, [3, 5, 0], [true, true, false]);
ok(card.total === 8 && card.par === 7 && card.toPar === 1, 'the card counts only holes played', card);
ok(scorecard(HOLES, [0, 0, 0], [false, false, false]).toPar === 0, 'an untouched card is level par');

// ---------- the shot model ----------
console.log('\nshot model');
ok(shotSpeed(0) === PHYS.base && shotSpeed(1) === PHYS.base + PHYS.span, 'power maps onto the speed span');

// distance = v^2/(2a): powerForDistance must be the honest inverse on every surface
for (const [name, a] of Object.entries(PHYS.fric)) {
  let worst = 0;
  for (const d of [8, 20, 40, 60, 90]) {
    const p = powerForDistance(d, a);
    if (p <= 0 || p >= 1) continue;          // outside the club's range, nothing to invert
    const v = shotSpeed(p);
    const got = (v * v) / (2 * a);
    worst = Math.max(worst, Math.abs(got - d) / d);
  }
  ok(worst < 0.001, `powerForDistance inverts the ${name} friction exactly`, { worst: +worst.toFixed(5) });
}

// a ball struck at the pin drops in; the same ball struck at the same numbers twice lands in the
// same place (the whole reason the gate can auto-play this title)
const h1 = HOLES[0];
const sim = (b, aim, power, hole = h1) => {
  const bb = { ...b, vx: Math.sin(aim) * shotSpeed(power), vz: -Math.cos(aim) * shotSpeed(power) };
  let holed = false, water = false, frames = 0;
  for (; frames < 900; frames++) {
    const ev = stepBall(bb, 1 / 60, hole);
    if (ev.water) { water = true; break; }
    if (ev.holed) { holed = true; break; }
    if (ev.stopped) break;
  }
  return { holed, water, frames, x: +bb.x.toFixed(3), z: +bb.z.toFixed(3) };
};
const puttAim = Math.atan2(h1.pin.x - h1.pin.x, -(h1.pin.z - (h1.pin.z + 3)));   // 0: straight at the cup
const a1 = sim({ x: h1.pin.x, z: h1.pin.z + 3, vx: 0, vz: 0 }, puttAim, powerForDistance(3, PHYS.fric.green));
ok(a1.holed === true, 'a short straight putt drops in the cup', a1);

const straight = Math.atan2(h1.pin.x - h1.tee.x, -(h1.pin.z - h1.tee.z));
const near = { x: h1.tee.x, z: h1.tee.z, vx: 0, vz: 0 };
const r1 = sim(near, straight, 0.8), r2 = sim(near, straight, 0.8);
ok(r1.x === r2.x && r1.z === r2.z, 'the same shot is deterministic', [r1, r2]);
ok(r1.z < h1.tee.z - 20, 'a full swing really advances the ball down the fairway', r1);

const w = { ...h1, water: [{ x: 0, z: -10, r: 5 }] };
const splash = sim({ x: 0, z: 0, vx: 0, vz: 0 }, 0, 0.9, w);
ok(splash.water === true, 'a ball hit into water reports the hazard', splash);

// a tree in the line must bend the shot, not swallow it
const tw = { ...h1, trees: [{ x: 0, z: -12, r: 2 }] };
const treeShot = sim({ x: 0, z: 0, vx: 0, vz: 0 }, 0, 0.95, tw);
ok(!treeShot.holed && (Math.abs(treeShot.z + 12) > 2 || Math.abs(treeShot.x) > 0.01),
  'the ball does not pass through a tree', treeShot);

// ---------- the gate's own shot, played in pure JS ----------
console.log('\nauto-play (the same shot the browser gate will take)');
for (const h of HOLES) {
  const b = { x: h.tee.x, z: h.tee.z, vx: 0, vz: 0 };
  let holed = false, shots = 0;
  const log = [];
  while (shots < 10 && !holed) {
    shots++;
    const dx = h.pin.x - b.x, dz = h.pin.z - b.z;
    const d = Math.hypot(dx, dz);
    const surf = surfaceAt(h, b.x, b.z);
    const a = PHYS.fric[surf] || PHYS.fric.fairway;
    // aim snapped to the keyboard's 0.5° step, power to its 1% step — exactly what a key press does
    const aimDeg = Math.round((Math.atan2(dx, -dz) / DEG) / 0.5) * 0.5 * DEG;
    const p = Math.round(powerForDistance(d, a) * 100) / 100;
    const from = { x: b.x, z: b.z };
    b.vx = Math.sin(aimDeg) * shotSpeed(p);
    b.vz = -Math.cos(aimDeg) * shotSpeed(p);
    let water = false;
    for (let f = 0; f < 900; f++) {
      const ev = stepBall(b, 1 / 60, h);
      if (ev.water) { water = true; break; }
      if (ev.holed) { holed = true; break; }
      if (ev.stopped) break;
    }
    let pd = Math.hypot(b.x - h.pin.x, b.z - h.pin.z);
    if (water) { b.x = from.x; b.z = from.z; b.vx = 0; b.vz = 0; pd = Math.hypot(b.x - h.pin.x, b.z - h.pin.z); }
    log.push({ shot: shots, from: [+from.x.toFixed(1), +from.z.toFixed(1)], surface: surf, power: p, aim: +(aimDeg / DEG).toFixed(1), toPin: +pd.toFixed(2), water });
    if (pd <= PHYS.tapIn) { shots += 1; holed = true; }   // the tap-in costs a stroke, as it must
  }
  ok(holed && shots <= 10, `${h.name} is finished by the gate's own shot in <= 10 strokes`, { shots, log });
  ok(shots <= h.par + 2, `${h.name} plays to within two of its par for a straight-line swing`, { shots, par: h.par, log });
}

console.log(fails === 0 ? '\nCORE PASS' : `\nCORE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
