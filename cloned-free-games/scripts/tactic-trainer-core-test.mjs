#!/usr/bin/env node
// Core test for the Tactic Trainer port. Slices the // >>>CORE block out of the SHIPPED
// HTML (so the drills proven here are the drills the browser runs), then:
//   1. every stored line is legal move by move through the page's own legalMoves()
//   2. mate-in-1: exactly one white move mates, and it is the stored one
//   3. mate-in-2: the key does not mate, and for EVERY legal black reply there is exactly
//      one mating answer (a key that is not forced is a puzzle that can be wrong)
//   4. the stored sample line is one of those forced lines
//   5. rating economics climb on a solve and fall on a miss/hint/reveal, floored
//   6. the session list is a legal subset of the puzzle list, cheapest first
import { readFile } from 'node:fs/promises';

const PORT = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/tactic-trainer/index.html';
const src = await readFile(PORT, 'utf8');
const a = src.indexOf('// >>>CORE');
const b = src.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) { console.error('no CORE block'); process.exit(1); }
const core = src.slice(a, b);
const api = new Function(core + `
return { parseFen, legalMoves, applyMove, isMate, inCheck, matesNow, findMove, PUZZLES, SESSION, SCORE, rateSolve, rateAdjust, sqName };`)();
const { parseFen, legalMoves, applyMove, isMate, inCheck, matesNow, findMove, PUZZLES, SESSION, SCORE, rateSolve, rateAdjust, sqName } = api;

let fails = 0;
const want = (cond, msg) => { if (!cond) { fails++; console.log('FAIL ' + msg); } else console.log('ok   ' + msg); };

// ---- 1..4 per puzzle
for (const [n, p] of PUZZLES.entries()) {
  const tag = `#${n} mate-in-${p.mate} ${p.theme} ${sqName(p.line[0][0])}${sqName(p.line[0][1])}`;
  let st = parseFen(p.fen);
  want(st.turn === 'w', `${tag}: white to move`);
  want(!inCheck(st, 'b'), `${tag}: black is not already in check`);
  want(legalMoves(st, 'w').length > 0, `${tag}: white has a legal move`);
  want(p.theme.length > 2 && p.rating > 1000, `${tag}: has a theme and a rating`);

  // walk the stored line with the page's rules
  let ok = true;
  let i = 0;
  for (const [from, to] of p.line) {
    const mv = findMove(legalMoves(st, st.turn), from, to);
    if (!mv) { ok = false; want(false, `${tag}: stored move ${i} ${sqName(from)}${sqName(to)} is legal`); break; }
    if (i === 0) {
      want(!isMate(applyMove(st, mv), 'b') === (p.mate === 2), `${tag}: first move ${p.mate === 1 ? 'mates' : 'is the quiet key'}`);
    }
    st = applyMove(st, mv);
    i++;
  }
  if (!ok) continue;

  if (p.mate === 1) {
    const start = parseFen(p.fen);
    const mates = legalMoves(start, 'w').filter((m) => isMate(applyMove(start, m), 'b'));
    want(mates.length === 1, `${tag}: exactly one mating move (${mates.length})`);
    want(mates.length === 1 && mates[0].from === p.line[0][0] && mates[0].to === p.line[0][1], `${tag}: the stored move is that mate`);
  } else {
    const start = parseFen(p.fen);
    const key = findMove(legalMoves(start, 'w'), p.line[0][0], p.line[0][1]);
    const after = applyMove(start, key);
    want(!isMate(after, 'b'), `${tag}: the key is not already mate`);
    const mates1 = legalMoves(start, 'w').filter((m) => isMate(applyMove(start, m), 'b'));
    want(mates1.length === 0, `${tag}: no mate-in-1 hiding in the position (${mates1.length})`);
    const replies = legalMoves(after, 'b');
    want(replies.length > 0, `${tag}: black has replies (${replies.length})`);
    let forced = true, worst = null;
    for (const rep of replies) {
      const a2 = applyMove(after, rep);
      const answers = matesNow(a2);
      if (answers.length !== 1) { forced = false; worst = { rep: sqName(rep.from) + sqName(rep.to), n: answers.length }; break; }
    }
    want(forced, `${tag}: every black reply has exactly one mating answer${worst ? ` (${worst.rep} has ${worst.n})` : ''}`);
    // the stored sample must be one of the replies, and its answer the mating move
    const rep = findMove(replies, p.line[1][0], p.line[1][1]);
    want(!!rep, `${tag}: stored reply is legal`);
    if (rep) {
      const a2 = applyMove(after, rep);
      const answers = matesNow(a2);
      want(answers.length === 1 && answers[0].from === p.line[2][0] && answers[0].to === p.line[2][1], `${tag}: stored answer mates that reply`);
    }
    want(isMate(st, 'b'), `${tag}: the stored line ends in mate`);
  }
}

// ---- 5 rating economics
let r = 1500;
const one = rateSolve(r, 1, 0), two = rateSolve(r, 2, 0);
want(one > r && two > one, `a solve pays: ${r} -> ${one} (mate 1) / ${two} (mate 2)`);
want(rateSolve(r, 1, 3) > one + 4, 'a streak pays a bonus');
want(rateAdjust(r, 'miss') < r && rateAdjust(r, 'hint') < r && rateAdjust(r, 'reveal') < r,
  'a miss, a hint and a reveal all cost rating');
want(rateAdjust(SCORE.floor, 'reveal') === SCORE.floor, `the rating is floored at ${SCORE.floor}`);

// ---- 6 session
want(SESSION.length >= 4 && SESSION.length <= 8, `session is ${SESSION.length} puzzles`);
want(SESSION.every((i) => i >= 0 && i < PUZZLES.length), 'every session slot is a real puzzle');
want(new Set(SESSION).size === SESSION.length, 'no puzzle repeats inside a session');
const ratings = SESSION.map((i) => PUZZLES[i].rating);
want(ratings.every((v, i) => i === 0 || v >= ratings[i - 1]), `session climbs in rating (${ratings.join(' → ')})`);
want(SESSION.some((i) => PUZZLES[i].mate === 2), 'the session includes a two-mover');

console.log(`\n${fails ? 'FAIL' : 'PASS'} tactic-trainer core (${PUZZLES.length} puzzles, ${fails} problem${fails === 1 ? '' : 's'})`);
process.exit(fails ? 1 : 0);
