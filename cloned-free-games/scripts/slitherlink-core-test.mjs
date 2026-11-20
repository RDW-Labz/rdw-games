#!/usr/bin/env node
// Proves the Slitherlink port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/slitherlink/index.html.
//
// Per board: the stored loop is a single closed cycle, every clue equals the number of lines the
// loop draws around that cell (so a win is reachable by construction), no clue exceeds 3, the
// opening position is neither solved nor flagged, a half-drawn loop is not a win, and drawing an
// edge the port calls a definitive violation really is flagged.
//
// usage: node slitherlink-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/slitherlink/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { BOARDS, hN, vN, edgeN, edgeIndex, getVal, setVal, cellEdges, clueAt, emptyState, loopState,
  copyState, lineCount, crossCount, cellCount, clueOk, degrees, overDots, loopOk, solvedOf, badDraws,
  flaggedEdges, solutionEdges };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};
const tagOf = (i) => `board ${i + 1} (${C.BOARDS[i].w}x${C.BOARDS[i].h})`;

ok(C.BOARDS.length >= 3, 'expected at least three shipped boards', C.BOARDS.length);

for (let i = 0; i < C.BOARDS.length; i++) {
  const B = C.BOARDS[i], tag = tagOf(i);
  console.log(tag + ': clues ' + B.clues);

  ok(B.loop.length === C.edgeN(B), tag + ' loop string is not edgeN long', [B.loop.length, C.edgeN(B)]);
  ok(B.clues.length === B.w * B.h, tag + ' clue string is not w*h long', B.clues.length);

  // no illegal clue (a 4 would mean a cell walled in on every side)
  let maxClue = 0;
  for (let r = 0; r < B.h; r++) for (let c = 0; c < B.w; c++) {
    const d = C.clueAt(B, r, c);
    if (d > 3) ok(false, tag + ` clue at ${r},${c} is ${d} — Slitherlink numbers stop at 3`);
    maxClue = Math.max(maxClue, d);
  }
  ok(maxClue >= 1, tag + ' has no numbered clue at all');

  const sol = C.loopState(B);
  const empty = C.emptyState(B);

  // the stored loop must be the win position
  ok(C.solvedOf(B, sol), tag + ' stored loop does NOT satisfy the rules');
  ok(C.loopOk(B, sol), tag + ' stored lines are not one closed loop');
  ok(C.clueOk(B, sol), tag + ' stored loop disagrees with its clues');
  ok(C.overDots(B, sol) === 0, tag + ' stored loop has a dot of degree > 2', C.overDots(B, sol));
  ok(C.flaggedEdges(B, sol).length === 0, tag + ' stored loop trips the violation check');

  // ...and each clue must equal the loop's count around that cell (clues were derived from the loop)
  for (let r = 0; r < B.h; r++) for (let c = 0; c < B.w; c++) {
    const d = C.clueAt(B, r, c);
    if (d < 0) continue;
    if (C.cellCount(B, sol, r, c) !== d) ok(false, tag + ` clue ${d} at ${r},${c} but the loop draws ${C.cellCount(B, sol, r, c)}`);
  }

  // opening position: no instant win, no instant flag
  ok(!C.solvedOf(B, empty), tag + ' opening position already reads as solved');
  ok(C.flaggedEdges(B, empty).length === 0, tag + ' opening position has flagged edges');
  ok(C.badDraws(B, empty).length > 0, tag + ' no definitively-bad edge exists to charge an error on');

  // an empty board draws no lines, so every non-zero clue is unsatisfied
  ok(!C.clueOk(B, empty), tag + ' empty board satisfies its clues');

  // half the loop: still drawn, still legal, but not the win
  const half = C.copyState(C.emptyState(B));
  C.solutionEdges(B).forEach(([k, y, x], n) => { if (n % 2 === 0) C.setVal(B, half, k, y, x, 1); });
  ok(!C.solvedOf(B, half), tag + ' half a loop reads as solved');

  // removing one edge of the loop breaks the win — the loop is not optional
  const less = C.loopState(B);
  const [k0, y0, x0] = C.solutionEdges(B)[0];
  C.setVal(B, less, k0, y0, x0, 0);
  ok(!C.solvedOf(B, less), tag + ' a missing loop edge still reads solved');

  // the port's own violation list, applied, must flag
  const bad = C.badDraws(B, empty)[0];
  const badState = C.emptyState(B);
  C.setVal(B, badState, bad[0], bad[1], bad[2], 1);
  ok(C.flaggedEdges(B, badState).length > 0, tag + ' an edge the port calls bad is not flagged once drawn');
  ok(!C.solvedOf(B, badState), tag + ' a bad edge still reads solved');

  // a cross is not a line: the same loop with every edge crossed instead of drawn is not a win
  const crosses = C.loopState(B);
  crosses.hv = crosses.hv.map(() => 2); crosses.vv = crosses.vv.map(() => 2);
  ok(!C.solvedOf(B, crosses), tag + ' all-crossed board reads as solved');
  ok(C.lineCount(B, crosses) === 0, tag + ' crossed edges count as lines');
}

console.log(fails ? `FAILED ${fails}` : `OK — ${C.BOARDS.length} boards valid, solvable and correctly policed`);
process.exit(fails ? 1 : 0);
