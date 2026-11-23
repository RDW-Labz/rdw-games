#!/usr/bin/env node
// Proves the Alex vs Bus port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/alex-vs-bus/index.html.
// Assertions: three generated levels whose geometry is sane (gap widths inside jump
// reach, run-up before every hazard, coins inside reach and clear of hazards), a plain
// pilot that catches the bus on every level inside the clock, a crate stumble and a hole
// fall that each cost real seconds and reset the runner, coin scoring, and both terminal
// states (bus caught / bus gone).
//
// usage: node alex-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/alex-vs-bus/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { RUN, ACCEL, GRAV, JUMP_V, MAX_FALL, BODY_W, BODY_H, STUMBLE_COST, FALL_COST, LEVELS, buildLevel, mkState, step, press, inGap, overGround, gapAt, crateHit, clearOfHazards };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { RUN, GRAV, JUMP_V, BODY_W, BODY_H, STUMBLE_COST, FALL_COST, LEVELS, buildLevel, mkState, step, press, inGap, overGround, gapAt } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 120;
const apex = (JUMP_V * JUMP_V) / (2 * GRAV);
const air = (2 * JUMP_V) / GRAV;
const reach = RUN * air;

// ---- physics budget
{
  ok(apex > 1.1, 'jump apex cannot clear a crate', apex);
  ok(reach > 4.2, 'a running jump cannot cross the widest gap', reach);
  ok(RUN * 0.5 < 4, 'run speed is not a run', RUN);
  console.log(`physics: apex=${apex.toFixed(2)} air=${air.toFixed(2)}s reach=${reach.toFixed(2)}`);
}

// ---- level geometry
for (const def of LEVELS) {
  const L = buildLevel(def);
  const tag = L.name;
  ok(L.gaps.length >= 2, tag + ': too few holes', L.gaps.length);
  ok(L.crates.length >= 1, tag + ': no crates', L.crates.length);
  ok(L.coins.length >= 5, tag + ': too few coins', L.coins.length);
  ok(L.busX === def.len - 7, tag + ': bus is not at the end of the street', L.busX);

  const gaps = [...L.gaps].sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    ok(g.x1 > g.x0, tag + ': inverted gap', g);
    ok(g.x1 - g.x0 <= 3.05, tag + ': gap wider than the jump', g.x1 - g.x0);
    ok(g.x1 - g.x0 >= 1.8, tag + ': gap too narrow to read as a hole', g.x1 - g.x0);
    if (i) ok(g.x0 - gaps[i - 1].x1 >= 6, tag + ': two holes with no run-up between', [gaps[i - 1], g]);
    // the floor must exist both sides of a hole
    ok(overGround(L, g.x0 - 0.6), tag + ': no ground before a hole', g);
    ok(overGround(L, g.x1 + 0.6), tag + ': no ground after a hole', g);
  }

  for (const c of L.crates) {
    ok(!gaps.some((g) => c.x + c.w / 2 > g.x0 - 2 && c.x - c.w / 2 < g.x1 + 2), tag + ': crate too close to a hole', c);
    ok(c.h > 0.6 && c.h < apex, tag + ': crate is not jumpable', c.h);
  }
  for (const p of L.peels) {
    ok(!gaps.some((g) => p.x > g.x0 - 1 && p.x < g.x1 + 1), tag + ': peel inside a hole', p);
  }

  // every coin is inside jump reach, and the gold ones sit over a hazard (that is the point of them)
  for (const co of L.coins) {
    ok(co.y <= 0.4 + apex + 0.35, tag + ': coin above jump reach', co);
    ok(co.y >= 0.9, tag + ': coin buried in the pavement', co);
    const overHole = gaps.some((g) => co.x > g.x0 && co.x < g.x1);
    const overCrate = L.crates.some((c) => Math.abs(co.x - c.x) < c.w / 2 + 0.3);
    if (overHole || overCrate) {
      // a coin over a hazard is only fair if the jump it pays for can actually reach it
      ok(co.y >= 1.6, tag + ': a jump coin hangs too low to be worth the hop', co);
    } else {
      ok(overGround(L, co.x), tag + ': a street coin sits over a hole', co);
      ok(!overCrate, tag + ': a street coin is inside a crate', co);
    }
  }

  // the clock has to allow the run, with room for a couple of mistakes
  const bare = def.len / RUN;
  ok(bare < def.time * 0.82, tag + ': the bus cannot be caught even running clean', { bare: +bare.toFixed(1), time: def.time });
}

// ---- a plain pilot: run right, hop the next hazard, catch the bus
function pilotInput(S) {
  if (!S.grounded) return { right: true };
  const p = S.p, L = S.L;
  let next = Infinity;
  for (const g of L.gaps) if (g.x0 > p.x && g.x0 - p.x < next) next = g.x0 - p.x;
  for (const c of L.crates) { const d = c.x - c.w / 2 - BODY_W / 2 - p.x; if (d > -0.05 && d < next) next = d; }
  for (const pe of L.peels) { const d = pe.x - pe.w / 2 - BODY_W / 2 - p.x; if (d > -0.05 && d < next) next = d; }
  return { right: true, jump: next < 2.35 && next > 0.05 };
}

for (const li of [0, 1, 2]) {
  const S = mkState(li, {});
  let n = 0;
  while (!S.over && !S.cleared && n++ < 120 * 200) step(S, DT, pilotInput(S));
  ok(S.cleared === true, LEVELS[li].name + ': the pilot never reached the bus', { x: +S.p.x.toFixed(1), t: +S.t.toFixed(1), why: S.why, hits: S.hits, falls: S.falls });
  ok(S.falls === 0, LEVELS[li].name + ': the pilot fell into a hole — the gaps are unfair', S.falls);
  ok(S.won === (li === LEVELS.length - 1), LEVELS[li].name + ': wrong win flag', S.won);
  ok(S.busBonus > 0 && S.score >= S.busBonus, LEVELS[li].name + ': no time bonus at the bus', { bonus: S.busBonus, score: S.score });
  console.log(`${LEVELS[li].name}: cleared at x=${S.p.x.toFixed(1)} with ${S.t.toFixed(1)}s left, ${S.coinsGot}/${S.total} coins, ${S.score} pts, hits=${S.hits}`);
}

// ---- a crate really does cost time, and knocks Alex back
{
  const S = mkState(0, {});
  const c = S.L.crates[0];
  S.p.x = c.x - 2.4; S.p.y = 0; S.p.vx = 0;
  const t0 = S.t, x0 = S.p.x;
  for (let i = 0; i < 120; i++) step(S, DT, { right: true });
  ok(S.hits >= 1, 'running into a crate did not stumble Alex', S.hits);
  ok(t0 - S.t >= STUMBLE_COST - 0.2, 'a stumble cost no time', +(t0 - S.t).toFixed(2));
  ok(S.p.x < c.x, 'Alex walked through the crate', { x: S.p.x, crate: c.x });
  ok(S.p.x >= x0 - 0.2, 'Alex was thrown back past the start', { x0, x: S.p.x });
}

// ---- a hole costs more time and puts him back before it
{
  const S = mkState(0, {});
  const g = S.L.gaps[0];
  S.p.x = (g.x0 + g.x1) / 2; S.p.y = 0.4; S.p.vy = 0; S.grounded = false;
  const t0 = S.t;
  for (let i = 0; i < 90; i++) step(S, DT, {});
  ok(S.falls === 1, 'a runner dropped into a hole did not fall', S.falls);
  ok(t0 - S.t >= FALL_COST - 0.2, 'a fall cost no time', +(t0 - S.t).toFixed(2));
  ok(S.p.x < g.x0, 'the fall did not reset Alex before the hole', { x: S.p.x, gap: g });
  ok(!S.over, 'a single fall ended the run', S.over);
}

// ---- coins pay, and a tap on the pavement is a jump
{
  const S = mkState(0, {});
  const co = S.coins.find((c) => c.kind !== 'gold' && c.y < 1.3);
  S.p.x = co.x - 1.6; S.p.y = 0; S.p.vx = 0;
  const s0 = S.score;
  for (let i = 0; i < 90; i++) step(S, DT, { right: true });
  ok(S.coinsGot >= 1, 'a coin on the walking line was not collected', { coinsGot: S.coinsGot, x: +S.p.x.toFixed(1), coin: co });
  ok(S.score - s0 >= 50, 'a coin paid nothing', S.score - s0);

  const J = mkState(0, {});
  ok(press(J, 'jump') === true, 'a grounded jump tap was refused');
  ok(J.p.vy > 0, 'the jump set no upward velocity', J.p.vy);
  ok(J.jumps === 1 && J.inputs === 1, 'the jump counters did not move', [J.jumps, J.inputs]);
  ok(press(J, 'jump') === false, 'a second jump in the air was accepted');
  ok(J.blocked === 1, 'the blocked-air-jump counter did not move', J.blocked);
}

// ---- terminal states: the bus, and the bus leaving
{
  const W = mkState(LEVELS.length - 1, { time: 30 });
  W.p.x = W.L.busX - 2.5; W.p.y = 0; W.p.vx = RUN;
  const s0 = W.score;
  for (let i = 0; i < 120 && !W.cleared; i++) step(W, DT, { right: true });
  ok(W.cleared === true, 'walking into the bus did not clear the level', { x: W.p.x, bus: W.L.busX });
  ok(W.won === true, 'the last stop was not a win', W.won);
  ok(W.why === 'bus', 'the clear reason is not the bus', W.why);
  ok(W.score > s0, 'catching the bus paid no time bonus', { s0, score: W.score });

  const L = mkState(0, { time: 0.4 });
  for (let i = 0; i < 80 && !L.over; i++) step(L, DT, { right: true });
  ok(L.over === true, 'the clock never ran out', { t: L.t, x: L.p.x });
  ok(L.why === 'late' && L.won === false, 'the timeout did not read as a missed bus', [L.why, L.won]);
  ok(L.cleared === false, 'the run was cleared and lost at once', L.cleared);
}

// ---- the clock never goes backwards on its own
{
  const S = mkState(1, {});
  let prev = S.t, bad = 0;
  for (let i = 0; i < 600; i++) { step(S, DT, {}); if (S.t > prev + 1e-9) bad++; prev = S.t; }
  ok(bad === 0, 'the clock climbed during a run', bad);
  ok(Math.abs((mkState(1, {}).t - S.t) - 5) < 0.2, 'five seconds of stepping did not take five seconds', +(mkState(1, {}).t - S.t).toFixed(2));
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
