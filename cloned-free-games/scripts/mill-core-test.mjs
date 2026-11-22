#!/usr/bin/env node
// Proves the Mill (Nine Men's Morris) port's rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/mill/index.html.
//
// Checks the board (24 points, 16 mills, symmetric adjacency, 32 edges), every mill line,
// the mill-protection rule for removals, the placing / moving / flying target rules, the
// terminal verdicts (two men left, boxed in), and that a full cpu-vs-cpu self-play only ever
// makes legal moves and always reaches a terminal state.
//
// usage: node mill-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/mill/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { PTS, MILLS, ADJ, mkState, menOf, piecesOf, openings, millsOf, inAnyMill, canRemove,
  targetsFrom, allMoves, hasMove, placeAt, moveTo, takeAt, verdict, threatAt, aiPick, aiTake,
  cloneState, actionsFor, applyAction, evaluate, search, aiBest };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
};

// ---------- 1) board structure ----------
ok(C.PTS.length === 24, 'board has 24 points', C.PTS.length);
ok(C.MILLS.length === 16, 'board has 16 mills', C.MILLS.length);
ok(new Set(C.PTS.map((p) => p.join(','))).size === 24, 'point coordinates are unique');
let edges = 0, asym = 0;
for (let a = 0; a < 24; a++) for (const b of C.ADJ[a]) {
  if (b <= a) continue;
  edges++;
  if (C.ADJ[b].indexOf(a) < 0) asym++;
}
ok(edges === 32, 'adjacency has 32 undirected edges', edges);
ok(asym === 0, 'adjacency is symmetric', asym);
for (let i = 0; i < 24; i++) ok(C.ADJ[i].length >= 2 && C.ADJ[i].length <= 4, `point ${i} has degree ${C.ADJ[i].length}`);
// every point sits in exactly two mills, every mill is a straight 3-point line
const inMills = new Array(24).fill(0);
for (const mm of C.MILLS) {
  ok(mm.length === 3 && new Set(mm).size === 3, 'mill is three distinct points', mm);
  const [p0, p1, p2] = mm.map((i) => C.PTS[i]);
  const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  ok(cross === 0, `mill ${JSON.stringify(mm)} is not collinear`);
  // and the three points are consecutive lattice steps (0 -> 3 -> 6 or 2 -> 3 -> 4)
  const step = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  ok(step(p0, p1) === step(p1, p2), `mill ${JSON.stringify(mm)} is not evenly spaced`);
  for (const i of mm) inMills[i]++;
}
ok(inMills.every((n) => n === 2), 'every point lies in exactly two mills', inMills);

// ---------- 2) mill detection ----------
for (const mm of C.MILLS) {
  const S = C.mkState();
  S.hand = [6, 9];
  for (const i of mm) S.p[i] = 0;
  const found = C.millsOf(S, 0);
  ok(found.length === 1 && found[0].join(',') === mm.join(','), `mill ${JSON.stringify(mm)} is not detected`, found);
  ok(mm.every((i) => C.inAnyMill(S, 0, i)), `mill ${JSON.stringify(mm)} points are not all marked as milled`);
  // two of the three is not a mill
  const S2 = C.mkState();
  S2.p[mm[0]] = 0; S2.p[mm[1]] = 0;
  ok(C.millsOf(S2, 0).length === 0, `two of ${JSON.stringify(mm)} counted as a mill`);
}

// ---------- 3) removal rules ----------
{
  // foe (1) has one milled man and one loose man: only the loose man may be taken
  const S = C.mkState();
  S.turn = 0; S.hand = [6, 6];
  for (const i of C.MILLS[0]) S.p[i] = 1;
  S.p[23] = 1;
  ok(C.canRemove(S, 0, 23), 'a loose foe man is removable');
  ok(!C.canRemove(S, 0, C.MILLS[0][0]), 'a milled foe man is protected while a loose man stands');
  ok(!C.canRemove(S, 0, 5), 'an empty point is not removable');
  ok(!C.canRemove(S, 1, 23), 'you may not take your own man');
  // every foe man inside a mill: the protection lifts
  const S2 = C.mkState();
  S2.turn = 0; S2.hand = [6, 6];
  for (const i of C.MILLS[0]) S2.p[i] = 1;
  for (const i of C.MILLS[1]) S2.p[i] = 1;
  ok(C.canRemove(S2, 0, C.MILLS[0][0]), 'a milled man is removable when every foe man is milled');
}

// ---------- 4) placing / moving / flying ----------
{
  const S = C.mkState();
  ok(C.targetsFrom(S, 0, 0).length === 0, 'placing phase offers no moves');
  ok(C.hasMove(S, 0), 'a player with a full hand always has a move');
  ok(C.verdict(S) === null, 'a fresh board is not terminal');

  // moving: four men -> only adjacent empty points
  const S2 = C.mkState();
  S2.hand = [0, 0];
  S2.p[0] = 0; S2.p[1] = 0; S2.p[6] = 0; S2.p[7] = 0;   // a mill on the outer top/left corners
  S2.turn = 0;
  const t0 = C.targetsFrom(S2, 0, 1).sort((a, b) => a - b);
  ok(t0.join(',') === '2,9', 'four men: only adjacent empty points are legal', t0);
  ok(C.targetsFrom(S2, 0, 1).indexOf(17) < 0, 'four men may not fly across the board');
  ok(C.allMoves(S2, 0).length === 4, 'four men have exactly four single steps', C.allMoves(S2, 0).length);

  // flying: exactly three men
  const S3 = C.mkState();
  S3.hand = [0, 0];
  for (const i of [0, 2, 4]) S3.p[i] = 0;
  S3.p[1] = 1; S3.p[3] = 1;
  S3.turn = 0;
  const fly = C.targetsFrom(S3, 0, 0);
  ok(fly.length === 24 - 5, 'three men may fly to every empty point', fly.length);
  ok(fly.indexOf(17) >= 0, 'flying reaches a far point');
}

// ---------- 5) terminal verdicts ----------
{
  // two men left: the side to move has lost
  const S = C.mkState();
  S.hand = [0, 0];
  S.p[0] = 0; S.p[1] = 0; S.p[9] = 1; S.p[10] = 1; S.p[11] = 1; S.p[12] = 1;
  S.turn = 0;
  const v = C.verdict(S);
  ok(v && v.over && v.result === 'lose', 'two men left is a loss for the side to move', v);
  // mirrored: the cpu is the one down to two men, so the same rule reads as a win
  const S1 = C.mkState();
  S1.hand = [0, 0];
  S1.p[0] = 0; S1.p[1] = 0; S1.p[2] = 0; S1.p[3] = 0; S1.p[9] = 1; S1.p[10] = 1;
  S1.turn = 1;
  const v2 = C.verdict(S1);
  ok(v2 && v2.over && v2.result === 'win', 'the cpu down to two men is a win', v2);
  ok(C.verdict(C.mkState()) === null, 'a full board at boot is not terminal');

  // boxed in: four men, every neighbour occupied
  const S2 = C.mkState();
  S2.hand = [0, 0];
  for (const i of [1, 2, 3, 4]) S2.p[i] = 0;
  for (const i of [0, 5, 9, 11]) S2.p[i] = 1;
  for (const i of [6, 7, 8, 10, 12]) S2.p[i] = 1;   // keep counts sane; nobody is at three men
  S2.turn = 0;
  ok(C.allMoves(S2, 0).length === 0, 'a boxed-in player has no legal move', C.allMoves(S2, 0));
  const v3 = C.verdict(S2);
  ok(v3 && v3.over && v3.result === 'lose', 'being boxed in is a loss', v3);
  // ... while a player with three men and a clear board is never boxed in
  const S3 = C.mkState();
  S3.hand = [0, 0];
  for (const i of [0, 1, 2]) S3.p[i] = 0;
  for (const i of [8, 9, 10]) S3.p[i] = 1;
  S3.turn = 0;
  ok(C.verdict(S3) === null, 'flying players are never boxed in', C.verdict(S3));
}

// ---------- 6) cpu self-play: legal moves only, always terminates ----------
// `chase` = the chooser under test. Every action is re-validated against the rules before it
// is applied, so an illegal suggestion can never hide behind a legal-looking state.
function selfPlay(chase, games, limit = 400) {
  const out = { term: 0, unfinished: 0, illegal: 0, result: { win: 0, lose: 0, draw: 0 }, longest: 0 };
  for (let g = 0; g < games; g++) {
    const S = C.mkState();
    let plies = 0;
    while (plies < limit) {
      const v = C.verdict(S);
      if (v) { out.term++; out.result[v.result]++; break; }
      const a = chase(S);
      if (!a) { out.unfinished++; break; }
      if (a.type === 'place') {
        if (S.p[a.at] !== -1 || S.hand[S.turn] <= 0) { out.illegal++; break; }
        if (C.placeAt(S, a.at)) {
          const t = C.aiTake(S);
          if (t < 0 || !C.canRemove(S, S.turn, t)) { out.illegal++; break; }
          C.takeAt(S, t);
        }
      } else {
        const okFrom = S.p[a.from] === S.turn && S.p[a.to] === -1 &&
          C.targetsFrom(S, S.turn, a.from).includes(a.to);
        if (!okFrom) { out.illegal++; break; }
        if (C.moveTo(S, a.from, a.to)) {
          const t = C.aiTake(S);
          if (t < 0 || !C.canRemove(S, S.turn, t)) { out.illegal++; break; }
          C.takeAt(S, t);
        }
      }
      S.turn = 1 - S.turn;
      plies++;
    }
    out.longest = Math.max(out.longest, plies);
    if (plies >= limit) out.unfinished++;
  }
  return out;
}

const greedy = selfPlay((S) => C.aiPick(S), 400);
console.log(`greedy self-play: ${greedy.term} terminal, ${greedy.unfinished} unfinished, ${greedy.illegal} illegal, longest ${greedy.longest} plies, results ${JSON.stringify(greedy.result)}`);
ok(greedy.illegal === 0, 'the greedy chooser never proposed an illegal move', greedy.illegal);
ok(greedy.unfinished === 0, 'every greedy self-play game reached a terminal state', greedy.unfinished);
ok(greedy.term === 400, 'all 400 greedy games finished', greedy.term);

const smart = selfPlay((S) => C.aiBest(S, 2), 120);
console.log(`search self-play: ${smart.term} terminal, ${smart.unfinished} unfinished, ${smart.illegal} illegal, longest ${smart.longest} plies, results ${JSON.stringify(smart.result)}`);
ok(smart.illegal === 0, 'the search chooser never proposed an illegal move', smart.illegal);
ok(smart.unfinished === 0, 'every search self-play game reached a terminal state (the quiet-move draw rule holds)', smart.unfinished);

// ---------- 7) both seats can win: play the greedy chooser against the search chooser ----------
{
  function match(p0, p1, games) {
    const r = { p0: 0, p1: 0, draw: 0 };
    for (let g = 0; g < games; g++) {
      const S = C.mkState();
      let plies = 0;
      while (plies < 400) {
        const v = C.verdict(S);
        if (v) { if (v.result === 'draw') r.draw++; else if (v.result === 'win') r.p0++; else r.p1++; break; }
        const a = (S.turn === 0 ? p0 : p1)(S);
        if (!a) break;
        if (a.type === 'place') { if (C.placeAt(S, a.at)) { const t = C.aiTake(S); if (t >= 0) C.takeAt(S, t); } }
        else { if (C.moveTo(S, a.from, a.to)) { const t = C.aiTake(S); if (t >= 0) C.takeAt(S, t); } }
        S.turn = 1 - S.turn;
        plies++;
      }
    }
    return r;
  }
  const g = (S) => C.aiPick(S), s = (S) => C.aiBest(S, 2);
  const seat0 = match(g, s, 40);   // a greedy visitor against the sharp cpu
  const steady = match(g, g, 40);  // a greedy visitor against the steady cpu
  console.log('greedy@0 vs sharp@1 ' + JSON.stringify(seat0) + ' · greedy@0 vs steady@1 ' + JSON.stringify(steady));
  ok(seat0.p1 > 0, 'the sharp cpu can beat a greedy visitor', seat0);
  ok(steady.p0 > 0, 'a visitor who plays for mills can beat the steady cpu', steady);
  ok(smart.result.draw > 0, 'the forty-quiet-move draw is reachable', smart.result);
}

// ---------- 8) determinism ----------
{
  const A = C.aiPick(C.mkState());
  const B = C.aiPick(C.mkState());
  ok(JSON.stringify(A) === JSON.stringify(B), 'the opening cpu choice is deterministic', [A, B]);
  const S = C.mkState();
  C.placeAt(S, 0); S.turn = 1;
  const C1 = C.aiBest(S, 2), C2 = C.aiBest(S, 2);
  ok(JSON.stringify(C1) === JSON.stringify(C2), 'the reply is deterministic too', [C1, C2]);
  ok(C1 && C1.at !== 0, 'the reply is a legal placement', C1);
}

console.log(fails ? `CORE TEST FAILED (${fails} failures)` : 'CORE TEST PASS');
process.exit(fails ? 1 : 0);
