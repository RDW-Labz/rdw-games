#!/usr/bin/env node
// Proves the Flicky Bee port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/flicky-bee/index.html.
//
// Assertions: the meadow is 12 rungs of two blooms and every bloom on the next rung sits inside
// one flick of both blooms below it; nectar, the depth payout, the rich bloom, the honey
// multiplier and the wasp sting each move the state they claim to; a bloom can be spent only
// once and siblings are never a target; an idle bee drains out and ends 'tired'; a pilot that
// flicks rung to rung without meeting a wasp reaches the hive and wins; the deal is deterministic.
//
// usage: node flicky-bee-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/flicky-bee/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const names = ['REACH', 'STAM_MAX', 'DRAIN_BASE', 'DRAIN_RISE', 'FLIGHT_DRAIN', 'NECTAR', 'HONEY_PER',
  'COMBO_T', 'STING_STAM', 'STING_HONEY', 'HIT_R', 'DEPTHS', 'N_FLOWERS', 'HIVE_BONUS', 'HIVE',
  'buildCourse', 'mkState', 'makeWasps', 'waspPos', 'perch', 'posOf', 'reachable', 'flyTo',
  'land', 'sting', 'step', 'dist3'];
const src = m[1] + '\nexport { ' + names.join(', ') + ' };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  REACH, NECTAR, HONEY_PER, COMBO_T, STING_HONEY, DEPTHS, N_FLOWERS, HIVE_BONUS, HIVE,
  buildCourse, mkState, makeWasps, waspPos, posOf, reachable, flyTo, land, step, dist3,
} = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;
const settle = (S, max = 900) => {
  let n = 0;
  while (S.travel && n < max) { step(S, DT); n++; }
  return n;
};
const payout = (f) => (HONEY_PER + f.d * 3 + (f.rich ? 15 : 0));

// ---- the meadow: 12 rungs of two blooms, every next bloom inside one flick of both below it
{
  let worst = 0, pairs = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const c = buildCourse(seed);
    ok(c.length === N_FLOWERS + 1, 'seed ' + seed + ': wrong node count', c.length);
    ok(c[HIVE].hive === true && c.slice(0, N_FLOWERS).every((f) => !f.hive), 'seed ' + seed + ': the hive is not the last node alone');
    ok(c.slice(0, N_FLOWERS).every((f, i) => f.d === Math.floor(i / 2)), 'seed ' + seed + ': depths do not run in pairs', c.slice(0, 6).map((f) => f.d));
    ok(c[HIVE].d === DEPTHS, 'seed ' + seed + ': the hive is not on the last rung', c[HIVE].d);
    for (let i = 1; i < N_FLOWERS; i++) ok(c[i].y > c[i - 1].y - 0.7, 'seed ' + seed + ': the meadow does not climb', [c[i - 1].y, c[i].y]);
    for (let d = 1; d <= DEPTHS; d++) {
      const cur = c.filter((f) => f.d === d);
      const below = d === 1 ? c.filter((f) => f.d === 0) : c.filter((f) => f.d === d - 1);
      ok(cur.length === (d === DEPTHS ? 1 : 2), 'seed ' + seed + ': rung ' + d + ' does not hold the right blooms', cur.length);
      ok(below.length === 2, 'seed ' + seed + ': rung ' + (d - 1) + ' is not a pair', below.length);
      for (const f of cur) for (const b of below) {
        const dist = dist3(b, f);
        worst = Math.max(worst, dist);
        pairs++;
        ok(dist <= REACH, 'seed ' + seed + ': bloom ' + f.d + '/' + f.col + ' is outside a flick from ' + b.d + '/' + b.col, { dist: Math.round(dist * 100) / 100, REACH });
      }
    }
    // a pair is a real choice: two different sides of the meadow
    for (let d = 0; d < DEPTHS; d++) {
      const a = c[d * 2], b = c[d * 2 + 1];
      ok(Math.sign(a.x) !== Math.sign(b.x), 'seed ' + seed + ': the pair at rung ' + d + ' is not a left/right choice', [a.x, b.x]);
    }
    const rich = c.filter((f) => f.rich).length;
    ok(rich >= DEPTHS - 4 && rich <= DEPTHS + 4, 'seed ' + seed + ': the rich blooms are not one per rung-ish', rich);
  }
  ok(worst <= REACH, 'an unreachable bloom was generated', worst);
  console.log(`course: ${pairs} bloom/flick pairs over 24 seeds, longest ${worst.toFixed(2)} of REACH ${REACH}`);
}

// ---- reach: exactly the two blooms on the next rung, never a sibling, never a spent bloom
{
  const S = mkState(7);
  const t = (() => { const out = []; for (let i = 0; i <= HIVE; i++) if (reachable(S, i)) out.push(i); return out.sort((a, b) => a - b); })();
  ok(t.length === 2 && t[0] === 2 && t[1] === 3, 'from the start the bee did not see exactly the next pair', t);
  ok(reachable(S, 1) === false, 'the sibling bloom on the same rung was a legal target');
  ok(reachable(S, 0) === false, 'the bee could flick to the bloom it stands on');
  ok(reachable(S, HIVE) === false, 'the bee flicked straight to the hive from the start');
  ok(flyTo(S, HIVE) === false, 'the rules let the bee skip the meadow');
  ok(flyTo(S, 2) === true && S.travel && S.flights === 1, 'a legal flick did not start a flight');
  ok(flyTo(S, 3) === false, 'a second flick started while in the air');
  settle(S);
  ok(S.idx === 2, 'the flight did not land', S.idx);
  const after = (() => { const out = []; for (let i = 0; i <= HIVE; i++) if (reachable(S, i)) out.push(i); return out.sort((a, b) => a - b); })();
  ok(after.length === 2 && after[0] === 4 && after[1] === 5, 'the next rung was not offered after landing', after);
  ok(reachable(S, 3) === false, 'the bee could flick sideways to its sibling');
  ok(reachable(S, 0) === false, 'the bee could flick backwards down the meadow');
}

// ---- nectar, the depth payout and the rich bloom
{
  const S = mkState(7);
  S.stamina = 40;
  const f = S.course[2];
  land(S, 2);
  ok(S.idx === 2 && S.visited[2] === true, 'landing did not move the bee onto the bloom', { idx: S.idx });
  ok(Math.abs(S.stamina - (40 + (f.rich ? NECTAR * 1.6 : NECTAR))) < 1e-9, 'a fresh bloom did not restore nectar', S.stamina);
  ok(S.honey === payout(f), 'a fresh bloom paid the wrong honey', { got: S.honey, want: payout(f), rich: f.rich, d: f.d });
  ok(S.travel === null, 'landing left a flight in progress');
  ok(S.mult === 1, 'the first landing already had a multiplier', S.mult);

  S.stamina = 96;
  land(S, 4);
  ok(S.stamina === 100, 'nectar pushed the buzz past its cap', S.stamina);

  // deeper rungs pay more than the first one, before any multiplier
  const deep = mkState(7);
  land(deep, 22);
  ok(deep.honey > payout(S.course[2]), 'a deep bloom did not pay more than a shallow one', { deep: deep.honey, shallow: payout(S.course[2]) });

  // the meadow always carries rich blooms, and they pay more than the plain bloom on the same rung
  let sawRich = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const c = buildCourse(seed);
    for (let d = 1; d < DEPTHS; d++) {
      const a = c[d * 2], b = c[d * 2 + 1];
      if (a.rich !== b.rich) {
        const richOne = a.rich ? a : b, plain = a.rich ? b : a;
        ok(payout(richOne) > payout(plain), 'the rich bloom did not pay more', { d });
        sawRich++;
      }
    }
  }
  ok(sawRich > 6, 'the meadow rarely offers a rich choice', sawRich);
}

// ---- the multiplier: quick chaining climbs, a slow landing resets
{
  const S = mkState(7);
  S.t = 0; land(S, 2);
  for (let d = 2; d <= 6; d++) { S.t += COMBO_T * 0.5; land(S, d * 2); }
  ok(S.mult === 5, 'five quick landings did not reach the multiplier cap', { mult: S.mult, streak: S.streak });
  const honeyAtCap = S.honey;
  S.t += COMBO_T * 1.5;
  land(S, 14);
  ok(S.mult === 1, 'a slow landing kept the streak', { mult: S.mult, streak: S.streak });
  ok(S.honey === honeyAtCap + payout(S.course[14]), 'the reset landing paid a multiplier', S.honey);
}

// ---- a wasp on the target bloom stings: buzz and honey fall, the bee stays put
{
  const S = mkState(7);
  S.stamina = 80; S.honey = 200;
  S.wasps = [{ i: 2, r: 0, phase: 0, speed: 0.6, cool: 0 }];
  ok(flyTo(S, 2) === true, 'the test flick did not start');
  let ticks = 0, stung = 0;
  while (ticks < 400 && !S.over) { step(S, DT); ticks++; if (S.stings) { stung = 1; break; } }
  ok(stung === 1, 'flying into a wasp did not sting', { stings: S.stings, idx: S.idx });
  ok(S.idx === 0 && S.travel === null, 'a stung bee did not fall back to its bloom', { idx: S.idx });
  ok(S.stamina < 80 - 18 + 1e-6, 'the sting did not cost buzz', S.stamina);
  ok(S.honey <= 200 - STING_HONEY, 'the sting did not cost honey', S.honey);
  ok(S.mult === 1 && S.streak === 0, 'the sting kept the streak', { mult: S.mult });
  ok(S.visited[2] === false, 'a sting spent the bloom it never reached');
  ok(S.wasps[0].cool > 0, 'the wasp did not back off after a sting', S.wasps[0].cool);
  // and the bee can try the same bloom again once the wasp has cleared
  for (let i = 0; i < 120; i++) step(S, DT);
  ok(reachable(S, 2) === true || reachable(S, 3) === true, 'the bee was permanently locked out after one sting');
}

// ---- an idle bee drains out and comes home tired (no wasps, no inputs)
{
  const S = mkState(7);
  S.wasps = [];
  let ticks = 0;
  while (!S.over && ticks < 60 * 600) { step(S, DT); ticks++; }
  const secs = ticks * DT;
  ok(S.over === true && S.won === false && S.why === 'tired', 'an idle bee never ran out of buzz', { why: S.why, secs });
  ok(S.stamina === 0, 'the tired bee kept a buzz balance', S.stamina);
  ok(secs > 20 && secs < 120, 'the idle run is not a fair length', secs);
  console.log(`idle: tired after ${secs.toFixed(1)}s on the first rung`);
}

// ---- flying itself costs extra buzz
{
  const a = mkState(7); a.wasps = []; a.stamina = 60;
  const b = mkState(7); b.wasps = []; b.stamina = 60;
  flyTo(a, 2);
  for (let i = 0; i < 20; i++) { step(a, DT); step(b, DT); }
  ok(a.stamina < b.stamina - 0.5, 'a flight did not cost more buzz than standing still', { flying: a.stamina, still: b.stamina });
}

// ---- a bee that flicks rung to rung, in order, wins at the hive
{
  const results = [];
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    for (const side of [0, 1]) {
      const S = mkState(seed);
      S.wasps = [];
      let guard = 0;
      while (!S.over && guard < 60 * 400) {
        if (!S.travel) {
          const d = S.course[S.idx].d;
          const next = d === DEPTHS - 1 ? HIVE : (d + 1) * 2 + side;
          ok(flyTo(S, next) === true, 'seed ' + seed + '/' + side + ': could not flick from ' + S.idx + ' to ' + next);
          if (!S.travel) break;
        }
        step(S, DT);
        guard++;
      }
      results.push({ seed, side, won: S.won, why: S.why, d: S.course[S.idx].d, honey: S.honey, stamina: Math.round(S.stamina) });
      ok(S.won === true && S.over === true && S.why === 'hive', 'seed ' + seed + '/' + side + ': an in-order pilot did not reach the hive', { idx: S.idx, why: S.why, stamina: S.stamina });
      ok(S.idx === HIVE, 'seed ' + seed + '/' + side + ': the win did not land on the hive', S.idx);
      ok(S.honey >= HONEY_PER * (DEPTHS - 1) + HIVE_BONUS, 'seed ' + seed + '/' + side + ': the hive run underpaid', S.honey);
      ok(S.stings === 0, 'seed ' + seed + '/' + side + ': the pilot was stung with no wasps on the meadow');
    }
  }
  console.log('pilot: ' + JSON.stringify(results.slice(0, 4)) + ' … ' + results.length + ' runs');
}

// ---- wasps sit on their own blooms and move while the clock runs
{
  const S = mkState(7);
  S.wasps = makeWasps(S);
  ok(S.wasps.length >= 3, 'the meadow has no wasps at all', S.wasps.length);
  ok(S.wasps.every((w) => w.i >= 4 && w.i < HIVE), 'a wasp guards a bloom off the meadow', S.wasps.map((w) => w.i));
  ok(S.wasps.every((w) => S.course[w.i].d % 2 === 0), 'a wasp guards a rung it should not', S.wasps.map((w) => [w.i, S.course[w.i].d]));
  const p0 = waspPos(S, S.wasps[0]);
  S.t += 1.3;
  const p1 = waspPos(S, S.wasps[0]);
  ok(dist3(p0, p1) > 0.05, 'a wasp never moves', { p0, p1 });
  const far = mkState(7);
  far.wasps = [{ i: 6, r: 0, phase: 0, speed: 0.6, cool: 0 }];
  for (let i = 0; i < 180; i++) step(far, DT);
  ok(far.stings === 0, 'a wasp stung from another rung', far.stings);
}

// ---- determinism, and the hive paying exactly once
{
  const A = mkState(7), B = mkState(7), C = mkState(8);
  ok(JSON.stringify(A.course) === JSON.stringify(B.course), 'two identical seeds dealt different meadows');
  ok(JSON.stringify(A.course) !== JSON.stringify(C.course), 'a different seed dealt the same meadow');
  ok(JSON.stringify(makeWasps(A)) === JSON.stringify(makeWasps(B)), 'two identical seeds dealt different wasps');

  const S = mkState(7);
  S.wasps = []; S.idx = 22; S.honey = 0;
  S.visited = new Array(N_FLOWERS + 1).fill(true);
  S.visited[HIVE] = false;
  ok(flyTo(S, HIVE) === true, 'the last flick to the hive was refused');
  settle(S);
  ok(S.won === true && S.honey === HIVE_BONUS, 'the hive did not pay exactly its bonus', S.honey);
  const before = S.honey;
  step(S, DT);
  ok(S.honey === before, 'a finished run kept scoring', S.honey);
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
