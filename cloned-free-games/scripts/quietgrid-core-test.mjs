#!/usr/bin/env node
// Proves the Quiet Grid port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/quiet-grid-logic-puzzles/index.html.
// Per mode and board: the stored solution satisfies the rules (so a win is reachable), the givens
// agree with it, an empty board is neither solved nor flagged, and each rule family actually
// catches its own violation.
//
// usage: node quietgrid-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/quiet-grid-logic-puzzles/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { MODES, idxOf, isGiven, badOf, solvedOf, solValues, givenValues, takuzuBad, sudokuBad, starBad };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { MODES, idxOf, badOf, solvedOf, solValues, givenValues, takuzuBad, sudokuBad, starBad } = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

const put = (vals, w, r, c, v) => { vals[idxOf(r, c, w)] = v; return vals; };

for (const mode of MODES) {
  for (let b = 0; b < mode.boards.length; b++) {
    const P = mode.boards[b];
    const tag = `${mode.id}/${b + 1}`;
    const N = P.w * P.h;
    console.log(`${tag}: ${P.w}x${P.h}${P.regions ? ', ' + new Set(P.regions.split('')).size + ' regions' : ''}`);

    ok(P.sol.length === N, tag + ' solution is not w*h long', P.sol.length);
    ok(P.given.length === N, tag + ' given is not w*h long', P.given.length);

    const sol = solValues(P);
    const giv = givenValues(P);

    // givens must agree with the solution — otherwise the board is unwinnable by construction
    ok(giv.every((v, i) => v < 0 || v === sol[i]), tag + ' a given disagrees with the solution');

    // the stored solution must satisfy the rules (that is what makes a win reachable)
    ok(solvedOf(mode.id, P, sol), tag + ' stored solution does NOT satisfy the rules');
    ok(badOf(mode.id, P, sol).size === 0, tag + ' stored solution trips the bad-cell check');
    // ...and the opening position must be neither solved nor flagged: no instant win, no instant loss
    ok(!solvedOf(mode.id, P, giv), tag + ' opening position already reads as solved');
    ok(badOf(mode.id, P, giv).size === 0, tag + ' opening position has bad cells');
    // a half-filled board must not read as solved
    const half = sol.map((v, i) => (i % 2 ? v : -1));
    ok(!solvedOf(mode.id, P, half), tag + ' half-filled board reads as solved');

    if (mode.id === 'takuzu') {
      // a fourth 1 in a row must be flagged and lose the win
      const row = sol.slice(0, P.w);
      const zeros = row.map((v, i) => [v, i]).filter(([v]) => v === 0).map(([, i]) => i);
      ok(zeros.length >= 1, tag + ' row has no zero to overwrite');
      const p1 = sol.slice(); put(p1, P.w, 0, zeros[0], 1);
      ok(takuzuBad(P, p1).size > 0, tag + ' a fourth 1 in a row was not flagged');
      ok(!solvedOf(mode.id, P, p1), tag + ' a fourth 1 in a row still reads solved');
      // a triple must be flagged (build it by flipping one cell of an alternating row)
      const triple = sol.slice();
      put(triple, P.w, 0, 0, 1); put(triple, P.w, 0, 1, 1); put(triple, P.w, 0, 2, 1);
      ok(takuzuBad(P, triple).size >= 3, tag + ' three 1s in a run were not flagged');
      // one wrong cell that breaks the count must fail the win
      const p2 = sol.slice(); put(p2, P.w, 0, zeros[0], 1);
      ok(!solvedOf(mode.id, P, p2), tag + ' a broken row still reads solved');
    }

    if (mode.id === 'sudoku') {
      // duplicate a digit inside the first row
      const dup = sol.slice();
      const c1 = 0, c2 = 1;
      put(dup, P.w, 0, c2, dup[idxOf(0, c1, P.w)]);
      ok(sudokuBad(P, dup).size >= 2, tag + ' a duplicate in a row was not flagged');
      ok(!solvedOf(mode.id, P, dup), tag + ' a duplicate row still reads solved');
      // duplicate inside a box but in different rows/columns
      const boxDup = sol.slice();
      const c3 = 6, c4 = 8; // rows 0 and 1 share the first 2x3 box
      put(boxDup, P.w, 1, 2, boxDup[idxOf(0, 0, P.w)]);
      ok(sudokuBad(P, boxDup).size >= 2, tag + ' a duplicate in a box was not flagged');
      ok(!solvedOf(mode.id, P, boxDup), tag + ' a box duplicate still reads solved');
    }

    if (mode.id === 'starbattle') {
      // regions must be exactly w cells each, one star in the solution
      const reg = P.regions.split('').map(Number);
      const sizes = new Map();
      for (const k of reg) sizes.set(k, (sizes.get(k) || 0) + 1);
      ok(sizes.size === P.w, tag + ' region count is not w', sizes.size);
      ok([...sizes.values()].every((n) => n === P.w), tag + ' a region is not w cells', [...sizes.values()]);
      // no two solution stars may touch
      ok(starBad(P, sol).size === 0, tag + ' solution stars touch or share a line');
      // an extra star must be flagged
      const extra = sol.slice();
      const free = [...Array(N).keys()].filter((i) => sol[i] !== 1);
      put(extra, P.w, Math.floor(free[0] / P.w), free[0] % P.w, 1);
      ok(sol[free[0]] !== 1, tag + ' extra-star probe hit an existing star');
      ok(starBad(P, extra).size > 0, tag + ' an extra star was not flagged');
      ok(!solvedOf(mode.id, P, extra), tag + ' an extra star still reads solved');
      // one star missing must fail the win
      const starIdx = sol.indexOf(1);
      const less = sol.slice(); less[starIdx] = -1;
      ok(!solvedOf(mode.id, P, less), tag + ' a missing star still reads solved');
    }
  }
}

// 6 gated boards in total
const boards = MODES.reduce((n, m) => n + m.boards.length, 0);
ok(boards >= 6, 'expected at least six shipped boards', boards);
console.log(fails ? `FAILED ${fails}` : `OK — ${boards} boards valid, winnable and correctly policed`);
process.exit(fails ? 1 : 0);
