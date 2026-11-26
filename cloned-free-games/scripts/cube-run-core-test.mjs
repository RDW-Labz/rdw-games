#!/usr/bin/env node
// Proves the Cube Run port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/cube-run/index.html.
//
// Assertions: the jump clears a wall and a standing cube does not; a slide clears a bar,
// standing and jumping do not; a pillar admits no way through; every generated row leaves
// a survivable lane; a pilot that reads the rows wins the circuit on several seeds while an
// idle cube dies; the shave bonus is worth exactly 2; the deal is deterministic and the
// opening row is never in the cube's own lane.
//
// usage: node cube-run-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/cube-run/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { LANE_X, WIN_ROWS, LEAD, GRAV, JUMP_V, WALL_TOP, BAR_LO, SLIDE_T, SLAM_G, HERO_D, OBJ_D, NEAR, SLIDE_SPAN, mulberry32, mkState, laneAt, safe, pickPattern, spawnAhead, passRow, step, moveLane, jump, slide, rowOptions };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LANE_X, WIN_ROWS, LEAD, GRAV, JUMP_V, WALL_TOP, BAR_LO, SLIDE_T, HERO_D, OBJ_D, NEAR, SLIDE_SPAN,
  mkState, laneAt, step, moveLane, jump, slide, rowOptions, passRow } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;
const HALF = (OBJ_D + HERO_D) / 2;

// ---- physics: the jump and the slide both cover the footprint at top speed
{
  const peak = (JUMP_V * JUMP_V) / (2 * GRAV);
  ok(peak > WALL_TOP + 0.6, 'jump apex barely clears a wall', { peak, WALL_TOP });
  const up = Math.sqrt(2 * (peak - WALL_TOP) / GRAV);
  const clearDist = 2 * up * 27;
  ok(clearDist > (OBJ_D + HERO_D) * 3, 'a full-speed jump cannot stay above a wall long enough', clearDist);
  ok(SLIDE_T * 27 > (OBJ_D + HERO_D) * 3, 'a slide is shorter than a bar footprint', SLIDE_T * 27);
  ok(BAR_LO < 0.90, 'the bar underside is too high to threaten a standing cube', BAR_LO);
  console.log(`physics: apex=${peak.toFixed(2)} jumpWindow=${clearDist.toFixed(1)}m slide=${(SLIDE_T * 27).toFixed(1)}m`);
}

// ---- one row, one verb: wall
{
  const make = () => {
    const S = mkState(7);
    S.dist = 100; S.nextAt = 1e6;
    S.groups.push({ at: 108, items: [{ kind: 'wall', lane: 1 }], kind: 'wall1', passed: false });
    return S;
  };
  const A = make();
  for (let i = 0; i < 90 && !A.over; i++) step(A, DT);
  ok(A.over === true && A.won === false && A.crash && A.crash.kind === 'wall', 'a standing cube passed through a wall', { over: A.over, crash: A.crash });

  const B = make();
  let jumped = false, peakY = 0;
  for (let i = 0; i < 120 && !B.over; i++) {
    const z = 108 - B.dist;
    if (!jumped && z < B.speed * 0.30) { jump(B); jumped = true; }
    step(B, DT);
    peakY = Math.max(peakY, B.y);
  }
  ok(B.over === false, 'a well-timed jump still hit the wall', { dist: B.dist, y: B.y, crash: B.crash });
  ok(B.rows === 1 && peakY > WALL_TOP + 0.4, 'the wall was not scored as a cleared row', { rows: B.rows, peakY });
}

// ---- one row, one verb: bar (slide clears, standing and jumping do not)
{
  const make = () => {
    const S = mkState(7);
    S.dist = 100; S.nextAt = 1e6;
    S.groups.push({ at: 108, items: [{ kind: 'bar', lane: 1 }], kind: 'bar1', passed: false });
    return S;
  };
  const A = make();
  for (let i = 0; i < 90 && !A.over; i++) step(A, DT);
  ok(A.over === true && A.crash && A.crash.kind === 'bar', 'a standing cube walked under a bar untouched', { over: A.over });

  const B = make();
  let slid = false;
  for (let i = 0; i < 120 && !B.over; i++) {
    if (!slid && 108 - B.dist < B.speed * 0.25) { slide(B); slid = true; }
    step(B, DT);
  }
  ok(B.over === false && B.rows === 1, 'a slide still clipped the bar', { over: B.over, rows: B.rows, slides: B.slides });

  const C = make();
  let jumped = false;
  for (let i = 0; i < 120 && !C.over; i++) {
    if (!jumped && 108 - C.dist < C.speed * 0.30) { jump(C); jumped = true; }
    step(C, DT);
  }
  ok(C.over === true, 'jumping into a bar should not save the cube', { over: C.over });
}

// ---- a pillar is a wall you cannot jump or slide: only the lane change saves you
{
  const make = (lane) => {
    const S = mkState(7);
    S.dist = 100; S.nextAt = 1e6;
    S.groups.push({ at: 108, items: [{ kind: 'pillar', lane: 1 }], kind: 'pillar1', passed: false });
    S.lane = lane;
    return S;
  };
  const A = make(1);
  let jumped = false;
  for (let i = 0; i < 120 && !A.over; i++) {
    if (!jumped && 108 - A.dist < A.speed * 0.30) { jump(A); jumped = true; }
    step(A, DT);
  }
  ok(A.over === true && A.crash && A.crash.kind === 'pillar', 'a jump carried the cube through a pillar', { over: A.over });

  const B = make(0);
  for (let i = 0; i < 120 && !B.over; i++) step(B, DT);
  ok(B.over === false && B.rows === 1, 'a cube in the open lane still hit the pillar', { over: B.over, rows: B.rows });
}

// ---- the slam: pressing down in mid-air lands the cube early and slides on arrival
{
  const S = mkState(7);
  S.dist = 100; S.nextAt = 1e6;
  jump(S);
  for (let i = 0; i < 18; i++) step(S, DT);
  const airY = S.y;
  ok(airY > 0.8, 'jump did not leave the deck', airY);
  slide(S);
  ok(S.slams === 1 && S.vy < 0, 'the mid-air swipe down did not slam', { slams: S.slams, vy: S.vy });
  let frames = 0;
  while (S.y > 0 && frames < 120) { step(S, DT); frames++; }
  ok(S.y === 0 && S.slideT > 0.3, 'the slam did not land into a slide', { y: S.y, slideT: S.slideT, frames });
  ok(frames < 18, 'the slam did not fall faster than a normal jump', frames);
}

// ---- lanes clamp, a second jump in the air is refused, drift is not applied while over
{
  const S = mkState(7);
  S.nextAt = 1e6;
  ok(moveLane(S, -1) === true && S.lane === 0, 'lane left failed');
  ok(moveLane(S, -1) === false && S.lane === 0 && S.blocked === 1, 'lane 0 clamped badly');
  ok(moveLane(S, 1) === true && S.lane === 1, 'lane right failed');
  ok(jump(S) === true && S.jumps === 1, 'jump refused');
  ok(jump(S) === false && S.blocked === 2, 'a second jump in the air was allowed');
  S.over = true;
  const d0 = S.dist;
  step(S, DT);
  ok(S.dist === d0, 'a finished run kept rolling', { dist: S.dist });
}

// ---- the shave bonus is exactly two points, and only for a genuinely tight pass
{
  const mk = (y) => {
    const S = mkState(7);
    S.dist = 100; S.nextAt = 1e6; S.y = y;
    const g = { at: 98.6, items: [{ kind: 'wall', lane: 1 }], kind: 'wall1', passed: false };
    S.groups.push(g);
    step(S, DT);
    return { S, g };
  };
  const tight = mk(WALL_TOP + 0.1);
  ok(tight.S.near === 1, 'a shave over the wall top paid nothing', { near: tight.S.near, rows: tight.S.rows });
  ok(tight.S.score === 3, 'the shave is not worth exactly two points', tight.S.score);
  const loose = mk(WALL_TOP + 0.9);
  ok(loose.S.near === 0 && loose.S.score === 1, 'a roomy clearance paid a shave bonus', { near: loose.S.near, score: loose.S.score });

  const S = mkState(7);
  S.dist = 100; S.nextAt = 1e6; S.y = 0; S.slideT = 0.9;
  S.groups.push({ at: 100.5, items: [{ kind: 'bar', lane: 1 }], kind: 'bar1', passed: false });
  step(S, DT);
  ok(S.near === 0, 'a generous slide paid a shave bonus', { near: S.near, slideT: S.slideT });
}

// ---- every generated row is survivable, the opening row is not in the cube's lane,
//      and the first obstacle comes after a fair reaction distance
{
  let worst = 0, rows = 0, openingBad = 0;
  // direct invariant sweep over the real generator
  const G = M.spawnAhead;
  for (let seed = 1; seed <= 8; seed++) {
    const S = mkState(seed);
    S.dist = 0; S.rows = 0;
    for (let r = 0; r < 600; r++) {
      S.rows = r;
      S.nextAt = Math.min(S.nextAt, S.dist + LEAD + 0.5);
      G(S);
      S.dist += 2;
      for (const g of S.groups) {
        const opts = rowOptions(g, S);
        const best = Math.min(...opts.map((o) => o.cost));
        if (best > 1) worst++;
        rows++;
        if (g.items.length === 1 && g.kind === 'slider') {
          // the slider must actually change lane, and must not land in all three
          const it = g.items[0];
          if (it.lane === it.mvTo) worst++;
        }
      }
      S.groups.length = 0;
    }
    const first = mkState(seed);
    G(first);
    const g0 = first.groups[0];
    ok(g0.at >= 25, 'seed ' + seed + ': the first obstacle is too close', g0.at);
    if (g0.items.some((it) => it.lane === 1)) openingBad++;
  }
  ok(worst === 0, 'generated rows with no survivable lane', worst);
  ok(openingBad === 0, 'the opening row can stand in the cube’s own lane', openingBad);
  ok(rows > 500, 'generator produced suspiciously few rows', rows);
  console.log(`generated rows checked: ${rows}`);
}

// ---- a pilot that reads the rows clears the circuit; an idle cube dies
function pilot(S) {
  const cands = S.groups.filter((g) => !g.passed && g.at - S.dist > -(HALF + 0.05)).sort((a, b) => a.at - b.at);
  const g = cands[0];
  if (!g) return;
  const opts = rowOptions(g, S);
  const z = g.at - S.dist;
  const cur = opts[S.lane];
  if (cur.cost > 0) {
    const better = opts.filter((o) => o.cost < cur.cost)
      .sort((a, b) => (a.cost - b.cost) || (Math.abs(a.lane - S.lane) - Math.abs(b.lane - S.lane)))[0];
    if (better && z > 0) { moveLane(S, Math.sign(better.lane - S.lane)); return; }
  }
  const here = opts[S.lane];
  if (here.verb === 'jump' && z < S.speed * 0.30 && z > -0.35) jump(S);
  if (here.verb === 'slide' && z < S.speed * 0.25 && z > -0.35) slide(S);
}

const pilotResults = [];
for (const seed of [1, 2, 3, 4, 5, 6, 11, 23]) {
  const S = mkState(seed);
  let ticks = 0;
  while (!S.over && ticks < 60 * 600) { pilot(S); step(S, DT); ticks++; }
  pilotResults.push({ seed, won: S.won, rows: S.rows, dist: Math.round(S.dist), why: S.why, crash: S.crash, jumps: S.jumps, slides: S.slides, near: S.near });
  ok(S.won === true && S.over === true && S.why === 'circuit', 'seed ' + seed + ': a row-reading pilot could not finish the circuit', { rows: S.rows, dist: Math.round(S.dist), crash: S.crash });
  ok(S.rows === WIN_ROWS, 'seed ' + seed + ': the circuit finished at the wrong row count', S.rows);
  ok(S.hits === 0, 'seed ' + seed + ': the pilot was hit', S.crash);
}
console.log('pilot: ' + JSON.stringify(pilotResults.map((r) => ({ seed: r.seed, won: r.won, rows: r.rows, dist: r.dist, near: r.near }))));

{
  const S = mkState(7);
  let firstHitAt = null, ticks = 0;
  while (!S.over && ticks < 60 * 240) {
    step(S, DT); ticks++;
    if (S.hits && firstHitAt === null) firstHitAt = Math.round(S.dist);
  }
  ok(S.over === true && S.won === false, 'an unattended cube never dies', { dist: Math.round(S.dist) });
  ok(firstHitAt === null || firstHitAt > 25, 'the first obstacle arrived before the player could read it', firstHitAt);
  ok(S.rows < WIN_ROWS, 'a no-input run finished the circuit', S.rows);
  console.log(`idle: died at ${Math.round(S.dist)}m after ${S.rows} rows (first hit at ${firstHitAt}m)`);
}

// ---- determinism: same seed, same track; a different seed deals a different one
{
  const A = mkState(7), B = mkState(7), C = mkState(8);
  for (let i = 0; i < 600; i++) { step(A, DT); step(B, DT); step(C, DT); }
  ok(JSON.stringify(A.groups) === JSON.stringify(B.groups) && A.rows === B.rows,
    'two identical runs diverged', { a: A.rows, b: B.rows });
  ok(JSON.stringify(C.groups) !== JSON.stringify(A.groups), 'a different seed dealt the same track');
}

// ---- the circuit win fires on the last row, and the sheet's reason is set
{
  const S = mkState(7);
  S.dist = 100; S.rows = WIN_ROWS - 1; S.nextAt = 1e6; S.lane = 1;
  S.groups.push({ at: 108, items: [{ kind: 'wall', lane: 0 }], kind: 'wall1', passed: false });
  for (let i = 0; i < 200 && !S.over; i++) step(S, DT);
  ok(S.over === true && S.won === true && S.why === 'circuit', 'the last row did not win the circuit', { over: S.over, won: S.won, rows: S.rows, why: S.why });
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
