#!/usr/bin/env node
// Proves the FaFa Runner port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/fafa-runner/index.html.
// Assertions: the jump clears a log (and survivable clearance), standing into a log hurts,
// sliding under a branch is safe, the gate needs the wizard's key, shards collect, an
// unattended run survives its opening and then ends in a loss, and the deal is deterministic.
//
// usage: node fafa-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/fafa-runner/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { LANE_X, GOAL, WIZ, LEAD, GRAV, JUMP_V, LOG_TOP, BRANCH_LO, SLIDE_T, HERO_D, OBJ_D, mulberry32, mkState, spawnAhead, step, hurt, moveLane, jump, slide };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LANE_X, GOAL, WIZ, GRAV, JUMP_V, LOG_TOP, SLIDE_T, HERO_D, OBJ_D, mkState, step, moveLane, jump, slide } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;

// ---- geometry: the jump has to clear a log with room to spare at top speed
{
  const peak = (JUMP_V * JUMP_V) / (2 * GRAV);
  ok(peak > LOG_TOP + 0.5, 'jump apex barely clears a log', { peak, LOG_TOP });
  // time spent above LOG_TOP  =>  distance covered at max speed
  const up = Math.sqrt(2 * (peak - LOG_TOP) / GRAV);
  const clearDist = 2 * up * 27;
  ok(clearDist > (OBJ_D + HERO_D) * 2, 'a full-speed jump cannot stay above a log long enough', { clearDist });
  ok(SLIDE_T * 27 > (OBJ_D + HERO_D) * 2, 'a slide is shorter than the branch footprint', SLIDE_T * 27);
  console.log(`physics: apex=${peak.toFixed(2)} clear=${clearDist.toFixed(1)}m slide=${(SLIDE_T * 27).toFixed(1)}m`);
}

// ---- a standing hero is hurt by a log, a jumping one is not
{
  const make = () => { const S = mkState(7, 100); S.nextAt = 1e6; S.nextShard = 1e6; S.objs.push({ kind: 'log', lane: 1, at: 100 + 8 }); return S; };
  const A = make();
  for (let i = 0; i < 90; i++) step(A, DT);
  ok(A.hits === 1 && A.hp === 2, 'standing into a log did not cost a heart', { hits: A.hits, hp: A.hp });

  const B = make();
  let jumped = false, peakY = 0;
  for (let i = 0; i < 120; i++) {
    const z = B.dist - (100 + 8);
    if (!jumped && z > -6) { jump(B); jumped = true; }
    step(B, DT);
    peakY = Math.max(peakY, B.y);
  }
  ok(B.hits === 0 && B.hp === 3, 'a well-timed jump still hit the log', { hits: B.hits, y: B.y, peakY });
  ok(peakY > LOG_TOP + 0.3, 'jump never rose above the log', peakY);
}
function pairDist() { return (OBJ_D + HERO_D + 0.6); }

// ---- sliding clears a branch, standing does not; jumping into it does not either
{
  const make = () => { const S = mkState(7, 100); S.nextAt = 1e6; S.nextShard = 1e6; S.objs.push({ kind: 'branch', lane: 1, at: 100 + 8 }); return S; };
  const A = make();
  for (let i = 0; i < 90; i++) step(A, DT);
  ok(A.hits === 1, 'standing under a branch was free', { hits: A.hits });

  const B = make();
  let slid = false;
  for (let i = 0; i < 120; i++) {
    if (!slid && B.dist - (100 + 8) > -pairDist()) { slide(B); slid = true; }
    step(B, DT);
  }
  ok(B.hits === 0 && B.hp === 3, 'a slide still clipped the branch', { hits: B.hits });

  const C = make();
  let jumped = false;
  for (let i = 0; i < 120; i++) {
    if (!jumped && C.dist - (100 + 8) > -pairDist()) { jump(C); jumped = true; }
    step(C, DT);
  }
  ok(C.hits === 1, 'jumping under a branch should not save you', { hits: C.hits });
}

// ---- the wizard hands over the key on the way past
{
  const S = mkState(7, 0);
  S.hp = 99; S.nextShard = 1e6;
  for (let i = 0; i < 4000 && !S.key; i++) step(S, DT);
  ok(S.key === true, 'the wizard never handed over the key', { dist: S.dist, WIZ });

  const W = mkState(7, GOAL - 30);
  W.nextAt = 1e6; W.nextShard = 1e6;
  ok(W.key === true, 'a position past the wizard should already carry the key');
  for (let i = 0; i < 240 && !W.over; i++) step(W, DT);
  ok(W.over === true && W.won === true && W.why === 'dawn', 'the dawn gate did not win', { over: W.over, won: W.won, why: W.why, dist: W.dist });
  ok(W.title === undefined && W.hp === 3, 'the QA position at the gate should arrive unhurt');
}

// ---- shards collect only in the hero's lane
{
  const S = mkState(7, 100);
  S.nextAt = 1e6; S.nextShard = 1e6; S.lane = 0;
  S.objs.push({ kind: 'shard', lane: 0, at: 108 });
  S.objs.push({ kind: 'shard', lane: 2, at: 108 });
  for (let i = 0; i < 90; i++) step(S, DT);
  ok(S.shards === 1, 'shard collection is not lane-scoped', { shards: S.shards });
}

// ---- lanes clamp, and an unattended run loses after a fair opening
{
  const S = mkState(7, 0);
  ok(moveLane(S, -1) === true && S.lane === 0, 'lane move left failed');
  ok(moveLane(S, -1) === false && S.lane === 0 && S.blocked === 1, 'lane 0 clamped badly');
  ok(moveLane(S, 1) === true && S.lane === 1, 'lane move right failed');
  ok(jump(S) === true && S.jumps === 1, 'jump refused');
  ok(jump(S) === false && S.blocked === 2, 'a second jump in the air was allowed');

  const R = mkState(7, 0);
  let firstHitAt = null;
  for (let i = 0; i < 60 * 300 && !R.over; i++) {
    step(R, DT);
    if (R.hits && firstHitAt === null) firstHitAt = R.dist;
  }
  ok(firstHitAt === null || firstHitAt > 25, 'an obstacle arrived before the player could react', firstHitAt);
  ok(R.over === true && R.won === false, 'an unattended run never ends', { dist: R.dist, hp: R.hp });
  ok(R.dist < GOAL, 'a no-input run reached the gate', R.dist);
  console.log(`unattended: ended at ${R.dist.toFixed(0)}m with ${R.hits} hits`);
}

// ---- determinism: same seed and dt sequence, same run
{
  const A = mkState(7, 0), B = mkState(7, 0), C = mkState(8, 0);
  A.hp = B.hp = C.hp = 99;
  for (let i = 0; i < 600; i++) { step(A, DT); step(B, DT); step(C, DT); }
  ok(A.dist === B.dist && A.objs.length === B.objs.length && A.shards === B.shards,
    'two identical runs diverged', { a: [A.dist, A.objs.length, A.shards], b: [B.dist, B.objs.length, B.shards] });
  ok(JSON.stringify(C.objs) !== JSON.stringify(A.objs), 'a different seed deals the same road');
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
