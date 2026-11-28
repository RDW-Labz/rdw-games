#!/usr/bin/env node
// Proves the Naija-Ludo port's shipped rules against the exact code the browser plays: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/naija-ludo/index.html.
//
// The card is the Nigerian two-dice variant, so the rules under test are: two dice a turn; a token
// moves by either die or by their sum; the dice may be split across two tokens; only a 6 lifts a
// token out of the yard; an exact roll is needed to reach home; capture happens off star squares
// and never on one; doubles (and captures) earn another roll; three doubles forfeit the turn.
//
// usage: node naija-ludo-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/naija-ludo/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const names = ['RING', 'TOKENS', 'FINISH', 'SEATS', 'RING_CELLS', 'START', 'ENTRY', 'HOME_CELLS', 'YARD', 'SAFE', 'SAFE_SET',
  'ringIdx', 'cellFor', 'newState', 'cloneState', 'rollDice', 'spends', 'applySpend', 'endTurn', 'finishTurn',
  'threatAt', 'aiSpend', 'playOut', 'playOutIdle'];
const src = m[1] + '\nexport { ' + names.join(', ') + ' };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { RING, TOKENS, FINISH, SEATS, RING_CELLS, START, ENTRY, HOME_CELLS, YARD, SAFE, SAFE_SET,
  ringIdx, cellFor, newState, cloneState, rollDice, spends, applySpend, endTurn, finishTurn, aiSpend, playOut, playOutIdle } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const key = (r, c) => r + ',' + c;
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const qOnRing = (seat, idx) => [...Array(51).keys()].find((q) => ringIdx(seat, q) === idx);

// ---- 1) the board geometry
{
  ok(RING === 52 && RING_CELLS.length === 52, 'ring is 52 squares', RING_CELLS.length);
  const seen = new Set();
  let dupes = 0, gaps = 0, offGrid = 0;
  for (let i = 0; i < RING; i++) {
    const [r, c] = RING_CELLS[i];
    if (seen.has(key(r, c))) dupes++;
    seen.add(key(r, c));
    if (cheb([r, c], RING_CELLS[(i + 1) % RING]) !== 1) gaps++;
    if (r < 0 || r > 14 || c < 0 || c > 14) offGrid++;
  }
  ok(dupes === 0, 'no two ring squares share a cell', dupes);
  ok(gaps === 0, 'every ring square steps to the next by one cell', gaps);
  ok(offGrid === 0, 'every ring square is on the 15x15 board', offGrid);

  const homeKeys = new Set(HOME_CELLS.flat().map(([r, c]) => key(r, c)));
  const inCross = RING_CELLS.every(([r, c]) => (r >= 6 && r <= 8) || (c >= 6 && c <= 8));
  const inCentre = RING_CELLS.filter(([r, c]) => r >= 6 && r <= 8 && c >= 6 && c <= 8).length;
  ok(inCross, 'every ring square lies in the cross');
  ok(inCentre === 0, 'no ring square is inside the 3x3 centre', inCentre);
  ok(RING_CELLS.every(([r, c]) => !homeKeys.has(key(r, c))), 'no ring square is a home-column square');

  let cross = 0;
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) if ((r >= 6 && r <= 8) || (c >= 6 && c <= 8)) cross++;
  const home = HOME_CELLS.flat().length;
  const homeUniq = new Set(HOME_CELLS.flat().map(([r, c]) => key(r, c))).size;
  ok(cross === 81 && home === 20 && homeUniq === 20, 'cross = 52 ring + 20 home + 9 centre', { cross, home, homeUniq });

  ok(new Set(START).size === 4 && new Set(ENTRY).size === 4, 'four distinct starts and entries', { START, ENTRY });
  const offsets = START.map((s, i) => (START[(i + 1) % 4] - s + RING) % RING);
  ok(offsets.every((o) => o === 13), 'starts are 13 squares apart in seat order', offsets);
  ok(START.every((s, i) => (s + 50) % RING === ENTRY[i]), 'each seat reaches its own arm tip after 50 steps', { START, ENTRY });

  HOME_CELLS.forEach((col, s) => {
    ok(col.length === 5, 'seat ' + s + ' home column has five squares', col.length);
    ok(cheb(col[0], RING_CELLS[ENTRY[s]]) === 1, 'seat ' + s + ' home column starts at the arm tip', { col0: col[0] });
    for (let k = 1; k < 5; k++) ok(cheb(col[k - 1], col[k]) === 1, 'seat ' + s + ' home column is contiguous at ' + k);
    const last = col[4];
    let nearCentre = 99;
    for (let r = 6; r <= 8; r++) for (let c = 6; c <= 8; c++) nearCentre = Math.min(nearCentre, cheb(last, [r, c]));
    ok(nearCentre === 1, 'seat ' + s + ' home column ends against the centre', last);
  });

  const blockOf = (s) => (s === 0 ? [9, 14, 9, 14] : s === 1 ? [0, 5, 9, 14] : s === 2 ? [0, 5, 0, 5] : [9, 14, 0, 5]);
  YARD.forEach((pads, s) => {
    const [r0, r1, c0, c1] = blockOf(s);
    ok(pads.length === 4, 'seat ' + s + ' has four yard pads', pads.length);
    ok(pads.every(([r, c]) => r > r0 - 1 && r < r1 + 1 && c > c0 - 1 && c < c1 + 1), 'seat ' + s + ' pads are inside its 6x6 yard', pads);
    ok(pads.every(([r, c]) => !seen.has(key(Math.round(r), Math.round(c)))), 'seat ' + s + ' pads are off the ring');
  });

  ok(SAFE.length === 8 && SAFE.every((i) => i >= 0 && i < RING) && new Set(SAFE).size === 8, 'eight distinct star squares', SAFE);
  ok(SAFE.every((i) => SAFE_SET.has((i + 13) % RING)), 'the star squares are rotationally symmetric', SAFE);
  ok(START.every((s) => SAFE_SET.has(s)), 'every start square is a star square', START);
  ok(cellFor(0, 0) && cellFor(0, 50) && cellFor(0, 51) && cellFor(0, 55), 'progress 0..55 maps to a cell');
  ok(cellFor(0, -1) === null && cellFor(0, FINISH) === null, 'the yard and home have no cell');
}

// ---- 2) the opening and the 6-only exit
{
  const S = newState(5);
  ok(S.tok.flat().every((q) => q === -1) && S.tok.length === 4 && S.tok.every((a) => a.length === 4), 'sixteen tokens start in their yards', S.tok);
  ok(S.turn === 0 && S.phase === 'roll', 'seat 0 opens on the roll', { turn: S.turn, phase: S.phase });

  rollDice(S, [6, 3]);
  const s1 = spends(S, 0);
  ok(s1.length === 4 && s1.every((x) => x.from === -1 && x.to === 0 && x.dice.join() === '0'), 'a 6 with a 3 offers four exits on the 6 die', s1);
  ok(spends(S, 0).every((x) => x.sum === false), 'no sum play exists out of the yard');

  const T = newState(6);
  rollDice(T, [3, 5]);
  ok(spends(T, 0).length === 0, 'no die is a 6, so nothing leaves the yard on 3+5', spends(T, 0));

  const U = newState(7);
  rollDice(U, [6, 6]);
  const s3 = spends(U, 0);
  ok(s3.length === 4, 'a double six still offers one exit per token (deduped)', s3.length);
  ok(s3.every((x) => x.to === 0), 'both dice are a 6, so every exit is legal either way');
}

// ---- 3) the two-dice core: either die, or the sum, or a split
{
  const S = newState(10);
  S.tok[0] = [10, -1, -1, -1];
  rollDice(S, [2, 3]);
  const ms = spends(S, 0);
  const tos = ms.map((x) => x.to).sort((a, b) => a - b);
  ok(JSON.stringify(tos) === '[12,13,15]', 'one token at 10 offers 10+2, 10+3 and 10+5', tos);
  const sum = ms.find((x) => x.sum);
  ok(sum && sum.to === 15 && sum.dice.join() === '0,1', 'the sum play spends both dice', sum);

  // spend the 2, and only the 3 is left in hand
  const after = cloneState(S);
  applySpend(after, 0, ms.find((x) => x.dice.join() === '0'));
  ok(after.tok[0][0] === 12 && after.used.join() === 'true,false', 'spending the 2 walks exactly 2', { tok: after.tok[0], used: after.used });
  const rest = spends(after, 0);
  ok(rest.length === 1 && rest[0].to === 15 && rest[0].dice.join() === '1', 'the unspent 3 is the only play left', rest);
  const fin = applySpend(after, 0, rest[0]);
  ok(after.tok[0][0] === 15 && fin.done === true, 'the second die can walk the same token again', { tok: after.tok[0], done: fin && fin.done });

  // the sum is one play, not two: both dice go at once
  const T = newState(11);
  T.tok[0] = [10, -1, -1, -1];
  rollDice(T, [2, 3]);
  const done = applySpend(T, 0, spends(T, 0).find((x) => x.sum));
  ok(T.tok[0][0] === 15 && T.used.join() === 'true,true' && done.done === true, 'the sum spends both dice at once', { tok: T.tok[0], used: T.used });

  // split across two tokens
  const U = newState(12);
  U.tok[0] = [5, 20, -1, -1];
  rollDice(U, [2, 3]);
  const split = spends(U, 0);
  ok(split.length === 6, 'two tokens x (2, 3, sum) is six plays', split.length);
  ok(split.some((x) => x.i === 0 && x.to === 7) && split.some((x) => x.i === 1 && x.to === 22), 'the dice can split across tokens', split.map((x) => [x.i, x.to]));
  const two = cloneState(U);
  applySpend(two, 0, spends(two, 0).find((x) => x.i === 0 && x.dice.join() === '0'));
  const r2 = spends(two, 0);
  ok(r2.length === 2 && r2.some((x) => x.i === 1 && x.to === 23) && r2.every((x) => x.dice.join() === '1'),
    'after one token takes the 2, the 3 can go to either token', r2.map((x) => [x.i, x.to]));
}

// ---- 4) exact finish, overshoot refused, must-move
{
  const S = newState(20);
  S.tok[0] = [52, 55, -1, -1];
  rollDice(S, [1, 3]);
  const ms = spends(S, 0);
  ok(ms.some((x) => x.i === 0 && x.to === 53) && ms.some((x) => x.i === 0 && x.to === 55), 'from 52 both dice land in the home column', ms.map((x) => [x.i, x.to]));
  ok(ms.some((x) => x.i === 0 && x.sum && x.to === FINISH), 'from 52 the sum 1+3 is exactly home, so it is offered', ms.map((x) => [x.i, x.to, x.sum]));
  ok(ms.some((x) => x.i === 1 && x.to === FINISH), 'from 55 the exact die finishes a token', ms.map((x) => [x.i, x.to]));

  const OS = newState(23);
  OS.tok[0] = [52, -1, -1, -1];
  rollDice(OS, [2, 3]);
  ok(!spends(OS, 0).some((x) => x.sum), 'a sum that overshoots home is not offered', spends(OS, 0).map((x) => [x.to, x.sum]));

  const T = newState(21);
  T.tok[0] = [55, -1, -1, -1];
  rollDice(T, [2, 4]);
  ok(spends(T, 0).length === 0, 'from 55 with 2 and 4 nothing is legal (every play overshoots)', spends(T, 0));

  // a die that cannot be used is forfeited: the turn does not hang on it
  const U = newState(22);
  U.tok[0] = [55, -1, -1, -1];
  rollDice(U, [1, 4]);
  const only = spends(U, 0);
  ok(only.length === 1 && only[0].to === FINISH, 'from 55 with 1 and 4 only the 1 is playable', only.map((x) => [x.to, x.dice]));
  const first = applySpend(U, 0, only[0]);
  ok(first && first.done === true && U.used.join() === 'true,true', 'an unusable second die is marked spent so the turn ends', { used: U.used, done: first && first.done });
  ok(U.phase === 'move' && U.tok[0][0] === FINISH, 'finishing a token does not end the game on its own');
}

// ---- 5) capture and the star squares
{
  // seat 0 from 4 by the sum 2+3 lands on ring 30; seat 1 reaches ring 30 at progress 48
  const idx = ringIdx(0, 9);
  ok(idx === 30 && !SAFE_SET.has(idx), 'the capture fixture square is an ordinary square', idx);
  const S = newState(30);
  S.tok[0] = [4, -1, -1, -1];
  S.tok[1] = [qOnRing(1, idx), -1, -1, -1];
  rollDice(S, [2, 3]);
  const res = applySpend(S, 0, spends(S, 0).find((x) => x.sum));
  ok(res && res.captured === 1 && S.tok[1][0] === -1, 'landing on a rival off a star sends it home to its yard', { res, tok1: S.tok[1] });
  ok(S.captures === 1 && S.bonus === true, 'a capture earns another roll');

  // the same collision on a star square is a stand-off: seat 0 from 3 by 3+2 lands on ring 29
  const starIdx = ringIdx(0, 8);
  ok(starIdx === 29 && SAFE_SET.has(starIdx), 'the star fixture square is a star', starIdx);
  const T = newState(31);
  const q1 = qOnRing(1, starIdx);
  T.tok[0] = [3, -1, -1, -1];
  T.tok[1] = [q1, -1, -1, -1];
  rollDice(T, [3, 2]);
  const safe = applySpend(T, 0, spends(T, 0).find((x) => x.sum));
  ok(safe && safe.captured === 0 && T.tok[1][0] === q1, 'a star square protects the rival standing on it', { safe, tok1: T.tok[1] });
  ok(T.bonus === false, 'landing on a protected rival earns no re-roll');

  // own tokens stack, and neither is sent home by its own move
  const U = newState(32);
  U.tok[0] = [3, 3, -1, -1];
  rollDice(U, [1, 1]);
  const mv = applySpend(U, 0, spends(U, 0)[0]);
  ok(mv && U.tok[0].filter((q) => q === 4).length <= 1, 'one of two stacked tokens moves alone', U.tok[0]);
}

// ---- 6) doubles, bonus turns, forfeits, and the win
{
  const S = newState(40);
  rollDice(S, [4, 4]);
  ok(S.bonus === true && S.doubles === 1, 'doubles earn another roll', { bonus: S.bonus, doubles: S.doubles });
  rollDice(S, [4, 5]);
  ok(S.bonus === false && S.doubles === 0, 'a non-double clears the doubles run', { bonus: S.bonus, doubles: S.doubles });
  for (let i = 0; i < 3; i++) { S.doubles = i; rollDice(S, [6, 6]); }
  ok(S.doubles === 3, 'three doubles are counted for the forfeit', S.doubles);

  const T = newState(41);
  T.tok[0] = [4, -1, -1, -1];
  rollDice(T, [2, 3]);
  const sp = spends(T, 0).find((x) => x.sum);
  const r = applySpend(T, 0, sp);
  ok(r.done && T.bonus === false, 'an ordinary turn has no bonus', { done: r.done, bonus: T.bonus });
  finishTurn(T);
  ok(T.turn === 1 && T.phase === 'roll' && T.dice.join() === '0,0', 'an ordinary turn passes the seat and clears the dice', T);

  const U = newState(42);
  U.tok[0] = [4, -1, -1, -1];
  rollDice(U, [1, 1]);
  ok(U.bonus === true, 'double one is doubles');
  applySpend(U, 0, spends(U, 0)[0]);
  const second = applySpend(U, 0, spends(U, 0)[0]);
  finishTurn(U);
  ok(second && second.done && U.turn === 0 && U.phase === 'roll', 'a bonus turn keeps the seat and asks for another roll', { turn: U.turn, phase: U.phase });

  const V = newState(43);
  V.tok[0] = [FINISH, FINISH, FINISH, 55];
  rollDice(V, [1, 5]);
  const win = applySpend(V, 0, spends(V, 0).find((x) => x.to === FINISH));
  ok(win && V.phase === 'over' && V.winner === 0 && V.tok[0].every((q) => q === FINISH), 'all four home ends the game with a winner', { phase: V.phase, winner: V.winner });
}

// ---- 7) the ladder: hundreds of games, an idle visitor, and a seat-0 spread
{
  let stuck = 0, bad = 0, tokBad = 0, overshoot = 0, unspent = 0;
  const winners = [0, 0, 0, 0];
  let rollsTotal = 0;
  const N = 300;
  for (let seed = 1; seed <= N; seed++) {
    const S = playOut(seed);
    if (S.phase !== 'over') { stuck++; continue; }
    winners[S.winner] += 1;
    rollsTotal += S.rolls;
    if (S.tok[S.winner].filter((q) => q === FINISH).length !== 4) bad++;
    for (let s = 0; s < 4; s++) for (let i = 0; i < 4; i++) {
      const q = S.tok[s][i];
      if (!Number.isInteger(q) || q < -1 || q > FINISH) tokBad++;
    }
  }
  ok(stuck === 0, 'every one of ' + N + ' games reached a verdict', { stuck });
  ok(bad === 0, 'every winner really has four tokens home', bad);
  ok(tokBad === 0, 'no token ever left the legal progress range', tokBad);
  ok(winners.every((w) => w > 0), 'all four seats win some games at this level', winners);

  // a whole game replayed from the same seed is identical
  ok(JSON.stringify(playOut(37).tok) === JSON.stringify(playOut(37).tok), 'a seed replays exactly');

  // no game ever leaves a die unspent while a legal play existed, and no move overshoots
  for (let seed = 100; seed < 140; seed++) {
    const S = newState(seed);
    let guard = 0;
    while (S.phase !== 'over' && guard++ < 3000) {
      const seat = S.turn;
      rollDice(S, 0);
      if (S.doubles >= 3) { S.doubles = 0; endTurn(S); continue; }
      if (!spends(S, seat).length) { finishTurn(S); continue; }
      let n = 0;
      while (S.phase !== 'over' && n++ < 8) {
        const sp = aiSpend(S, seat);
        if (!sp) break;
        if (sp.to > FINISH) overshoot++;
        const before = spends(S, seat).length;
        const r = applySpend(S, seat, sp);
        if (!r) break;
        if (r.done && S.phase !== 'over' && !(S.used[0] && S.used[1])) unspent++;
        if (before === 0) break;
      }
      if (S.phase === 'over') break;
      finishTurn(S);
    }
  }
  ok(overshoot === 0, 'no pilot move ever overshoots home', overshoot);
  ok(unspent === 0, 'a turn never ends with a usable die still in hand', unspent);

  // an idle visitor never wins
  let idleWins = 0, idleStuck = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const S = playOutIdle(seed);
    if (S.phase !== 'over') { idleStuck++; continue; }
    if (S.winner === 0) idleWins++;
  }
  ok(idleWins === 0, 'a visitor who never spends a die never wins 200 idle games', idleWins);
  ok(idleStuck === 0, 'idle games still terminate', idleStuck);

  // seat 0 flown by the pilot: neither a guaranteed win nor a guaranteed loss
  let w0 = 0;
  for (let seed = 500; seed < 560; seed++) if (playOut(seed).winner === 0) w0++;
  ok(w0 >= 6, 'the pilot wins a fair share of seat 0 games', w0 + '/60');
  ok(w0 < 60, 'the pilot does not win every seat 0 game', w0 + '/60');
  console.error('  ladder: ' + N + ' games -> winners ' + JSON.stringify(winners) + ', avg rolls ' + (rollsTotal / N).toFixed(1) +
    ', seat0 pilot ' + w0 + '/60, idle wins 0/200');
}

if (fails) { console.error('\nFAILED ' + fails + ' assertion(s)'); process.exit(1); }
console.log(JSON.stringify({ ok: true, fails: 0, file }));
