#!/usr/bin/env node
// Proves the backgammon port's shipped rules against the exact code the browser plays: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/backgammon/index.html.
//
// Assertions: the opening position is the standard one (30 checkers, 167 pips each, five moves
// available from the 3-1), legal-move generation respects the bar, blocked points, the bear-off
// rules and the furthest-checker oversight rule, the max-play/larger-die rule of `sequences`,
// thousands of self-played games never break chip conservation or put both colours on a point,
// and a full game always terminates with fifteen checkers off.
//
// usage: node backgammon-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/backgammon/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { newState, roll, legalSteps, applyStep, sequences, bestSequence, pipCount, endTurn, playOut, canBear, cloneState, evalFor, own, inHome, distHome, NEED };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { newState, roll, legalSteps, applyStep, sequences, bestSequence, pipCount, endTurn, playOut, canBear, cloneState, own, inHome, distHome, NEED } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};

// ---- the opening position
{
  const S = newState(3);
  let w = 0, b = 0;
  for (let p = 0; p < 24; p++) { if (S.pts[p] > 0) w += S.pts[p]; else b -= S.pts[p]; }
  ok(w === 15 && b === 15, 'the opening does not deal fifteen checkers a side', { w, b });
  ok(pipCount(S, 'w') === 167, 'white does not start on 167 pips', pipCount(S, 'w'));
  ok(pipCount(S, 'b') === 167, 'black does not start on 167 pips', pipCount(S, 'b'));
  ok(S.pts[23] === 2 && S.pts[12] === 5 && S.pts[7] === 3 && S.pts[5] === 5, 'white is not on 24/13/8/6', [S.pts[23], S.pts[12], S.pts[7], S.pts[5]]);
  ok(S.pts[0] === -2 && S.pts[11] === -5 && S.pts[16] === -3 && S.pts[18] === -5, 'black is not on 1/12/17/19', [S.pts[0], S.pts[11], S.pts[16], S.pts[18]]);
  ok(S.dice.length === 2 && S.dice.every((d) => d >= 1 && d <= 6), 'the opening roll is not two dice', S.dice);
  ok(S.turn === 'w' && S.phase === 'move', 'the opening is not white to move', { turn: S.turn, phase: S.phase });
}

// ---- doubles deal four dice; singles deal two
{
  let four = 0, two = 0;
  for (let i = 0; i < 400; i++) {
    const S = newState(i);
    if (S.dice.length === 4) { four++; ok(S.dice.every((d) => d === S.dice[0]), 'doubles did not deal four equal dice', S.dice); }
    else two++;
  }
  ok(four > 30 && two > 200, 'the dice stream is not mixed', { four, two });
}

// ---- a 3-1 opening: seven single steps, and the point 13 die-1 is blocked by black on 12
{
  const S = newState(3);
  S.dice = [3, 1];
  const opts = legalSteps(S, 'w', S.dice);
  ok(opts.length === 7, 'the 3-1 opening does not offer seven steps', opts.map((o) => o.from + '>' + o.to + ':' + o.die));
  ok(opts.some((o) => o.from === 23 && o.to === 22 && o.die === 1), 'white cannot play 24/23', null);
  ok(opts.some((o) => o.from === 23 && o.to === 20 && o.die === 3), 'white cannot play 24/21', null);
  ok(!opts.some((o) => o.from === 12 && o.die === 1), 'white can move 13/12 although point 12 is black-owned', null);
  const seen = new Set(opts.map((o) => o.from + '>' + o.to));
  ok(seen.size === opts.length, 'the move list repeats a destination for the same source', [...seen]);
}

// ---- blocked points, the bar, and hitting
{
  const S = newState(5);
  S.pts = new Int8Array(24);
  S.pts[10] = 1;                 // a lone white checker on point 11
  S.pts[8] = -2;                 // black owns point 9 with two — white cannot land there
  S.bar = { w: 1, b: 0 };
  const opts = legalSteps(S, 'w', [2]);
  ok(opts.length === 1 && opts[0].from === -1 && opts[0].to === 1, 'a white checker on the bar must enter on point 2', opts);
  S.bar = { w: 0, b: 0 };
  const o2 = legalSteps(S, 'w', [2]);
  ok(!o2.some((o) => o.to === 8), 'white can land on a point black owns with two', o2);
  const o4 = legalSteps(S, 'w', [4]);
  ok(o4.some((o) => o.from === 10 && o.to === 6), 'white cannot move onto an empty point', o4);

  // hitting a blot sends it to the bar
  const H = newState(5);
  H.pts = new Int8Array(24);
  H.pts[10] = 1; H.pts[7] = -1;
  H.dice = [3];
  applyStep(H, 'w', { from: 10, to: 7, die: 3 });
  ok(H.bar.b === 1 && H.pts[7] === 1, 'moving onto a lone black checker did not hit it', { bar: H.bar, p7: H.pts[7] });
}

// ---- bear-off: only when every checker is home, exact throws, and the furthest-checker rule
{
  const S = newState(5);
  S.pts = new Int8Array(24);
  S.pts[5] = 14; S.pts[2] = 1;
  ok(canBear(S, 'w') === true, 'all checkers home did not enable bearing off', null);
  const opts = legalSteps(S, 'w', [3]);
  ok(opts.some((o) => o.from === 2 && o.to === -1 && o.die === 3), 'an exact throw from point 3 did not bear off', opts);
  // a 3 from point 6 reaches point 3 (occupied by our own checker), so it is a move, not a bear-off
  ok(opts.some((o) => o.from === 5 && o.to === 2), 'the 3 from point 6 did not move up to point 3', opts);
  ok(!opts.some((o) => o.from === 5 && o.to === -1 && o.die === 3), 'a 3 from point 6 bore off with a checker behind it', opts);

  // a checker outside home blocks bearing off entirely
  const T = newState(5);
  T.pts = new Int8Array(24);
  T.pts[5] = 14; T.pts[6] = 1;
  ok(canBear(T, 'w') === false, 'a checker outside home did not block bearing off', null);
  const o2 = legalSteps(T, 'w', [3]);
  ok(!o2.some((o) => o.to === -1), 'a checker outside home still bears off', o2);

  // overshooting is only allowed from the furthest checker: 15 on point 4 and a 6 is an overshoot
  const U = newState(5);
  U.pts = new Int8Array(24);
  U.pts[3] = 15;
  ok(legalSteps(U, 'w', [6]).some((o) => o.from === 3 && o.to === -1), 'the furthest checker cannot overshoot with a 6', null);
  const V = newState(5);
  V.pts = new Int8Array(24);
  V.pts[3] = 1; V.pts[5] = 14;   // a checker further from home than point 4
  ok(!legalSteps(V, 'w', [6]).some((o) => o.to === -1 && o.from === 3), 'a non-furthest checker overshot with a big die', null);
  ok(legalSteps(V, 'w', [6]).some((o) => o.from === 5 && o.to === -1), 'the furthest checker could not use the overshoot die', legalSteps(V, 'w', [6]));
}

// ---- the max-play rule: if only one die can be used, it must be the larger one
{
  const S = newState(5);
  S.pts = new Int8Array(24);
  S.pts[2] = 1;                  // white on point 3
  S.off = { w: 14, b: 0 };
  S.pts[0] = -2;                 // black owns point 1 with two, so a 2 (3 -> 1) is blocked
  S.bar = { w: 0, b: 0 };
  const seqs = sequences(S, 'w', [2, 5]);
  ok(seqs.length >= 1, 'no sequence at all where only the 5 is playable', seqs);
  ok(seqs.every((sq) => sq.length === 1), 'sequences used more dice than the position allows', seqs.map((s) => s.length));
  ok(seqs.every((sq) => sq[0].die === 5), 'the smaller die was used when only the larger was playable', seqs);
}

// ---- `sequences` returns only maximal plays, and every step in them is legal
{
  const S = newState(21);
  S.dice = [4, 3];
  const seqs = sequences(S, 'w', S.dice);
  ok(seqs.length > 0, 'the 4-3 opening produced no sequences', null);
  const maxLen = Math.max(...seqs.map((s) => s.length));
  ok(seqs.every((s) => s.length === maxLen), 'sequences are not all maximal', seqs.map((s) => s.length));
  for (const sq of seqs) {
    const sim = cloneState(S);
    for (const mv of sq) {
      const opts = legalSteps(sim, 'w', sim.dice);
      if (!opts.some((o) => o.from === mv.from && o.to === mv.to && o.die === mv.die)) {
        ok(false, 'a sequence contains an illegal step', mv);
        break;
      }
      applyStep(sim, 'w', mv);
    }
  }
}

// ---- conservation + no mixed points over thousands of self-played games
{
  let games = 0, finished = 0, maxTurns = 0, mixed = 0, badCount = 0, negPip = 0, bars = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const S = newState(seed);
    let turns = 0;
    while (S.phase !== 'over' && turns < 900) {
      const steps = bestSequence(S, S.turn);
      for (const mv of steps) {
        applyStep(S, S.turn, mv);
        if (S.phase === 'over') break;
      }
      // invariants after every turn
      let w = S.off.w + S.bar.w, b = S.off.b + S.bar.b;
      for (let p = 0; p < 24; p++) {
        if (S.pts[p] > 0) w += S.pts[p]; else if (S.pts[p] < 0) b -= S.pts[p];
        if (S.pts[p] > 0) { for (let q = 0; q < 24; q++) if (S.pts[q] < 0 && p === q) mixed++; }
      }
      if (w !== 15 || b !== 15) badCount++;
      if (pipCount(S, 'w') < 0 || pipCount(S, 'b') < 0) negPip++;
      if (S.bar.w > 0 || S.bar.b > 0) bars++;
      if (S.phase === 'over') break;
      endTurn(S);
      turns++;
      if (!S.dice.length) badCount++;
    }
    games++;
    if (S.phase === 'over') finished++;
    maxTurns = Math.max(maxTurns, turns);
  }
  ok(badCount === 0, 'checker counts broke during self-play', badCount);
  ok(mixed === 0, 'a point held checkers of both colours', mixed);
  ok(negPip === 0, 'a pip count went negative', negPip);
  ok(bars > 0, 'no checker was ever hit across 400 games — hitting is dead', bars);
  ok(finished === games, 'a self-played game never finished', { games, finished });
  ok(maxTurns < 900, 'games run absurdly long', maxTurns);
  console.log(`selfplay: ${games} games, all finished, longest ${maxTurns} turns, ${bars} turns with a checker on the bar`);
}

// ---- a won position: the fifteenth checker off ends the game
{
  const S = newState(5);
  S.pts = new Int8Array(24);
  S.pts[0] = 1;
  S.off = { w: 14, b: 0 };
  S.dice = [1];
  ok(applyStep(S, 'w', { from: 0, to: -1, die: 1 }) === true, 'the last checker would not bear off', null);
  ok(S.phase === 'over' && S.winner === 'w', 'bearing off the fifteenth checker did not win', { phase: S.phase, winner: S.winner });
  ok(S.off.w === NEED, 'the off count is wrong', S.off.w);
  const after = applyStep(S, 'w', { from: 0, to: -1, die: 1 });
  ok(after === false, 'a finished game accepted another move', null);
}

// ---- the CPU always returns a legal, non-empty play when one exists
{
  let bad = 0, empty = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const S = newState(seed);
    for (let turn = 0; turn < 6 && S.phase === 'move'; turn++) {
      const have = legalSteps(S, S.turn, S.dice).length;
      const steps = bestSequence(S, S.turn);
      if (have > 0 && steps.length === 0) empty++;
      const sim = cloneState(S);
      for (const mv of steps) {
        const opts = legalSteps(sim, sim.turn, sim.dice);
        if (!opts.some((o) => o.from === mv.from && o.to === mv.to && o.die === mv.die)) bad++;
        applyStep(sim, sim.turn, mv);
      }
      if (S.phase === 'over') break;
      endTurn(S);
    }
  }
  ok(bad === 0, 'the CPU played an illegal step', bad);
  ok(empty === 0, 'the CPU gave up while legal moves existed', empty);
}

if (fails) { console.error(`\nFAILED: ${fails} assertion(s)`); process.exit(1); }
console.log('\nPASS: backgammon core rules');
