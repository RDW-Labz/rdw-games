#!/usr/bin/env node
// Proves the Sudaku port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/sudaku-pattern-driven-sudoku/index.html.
// Per board: the stored solution is a legal sudoku, the givens agree with it, an empty board is
// neither solved nor flagged, All-diff never removes the solution digit, One-of never places a
// digit that contradicts the solution, Ripple finishes the board from the givens (so the win is
// reachable by the port's own patterns), and a duplicated digit is flagged.
//
// usage: node sudaku-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/sudaku-pattern-driven-sudoku/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { MODES, unitsOf, candsFrom, allDiff, oneOf, ripple, badCells, isSolved, givenValues, solValues, glyphOf };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { MODES, candsFrom, allDiff, oneOf, ripple, badCells, isSolved, givenValues, solValues, unitsOf } = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };

for (const MODE of MODES) {
  const { n, box } = MODE;
  console.log(`\nmode ${MODE.id}: ${MODE.boards.length} board(s), ${n}x${n}, ${box}x${box} boxes`);
  for (let b = 0; b < MODE.boards.length; b++) {
    const P = MODE.boards[b];
    const sol = solValues(P);
    const givens = givenValues(P);
    const total = n * n;
    console.log(`  board ${b + 1}: ${givens.filter(Boolean).length} givens`);

    ok(sol.length === total && givens.length === total, 'wrong string length');
    ok(sol.every((v) => v >= 1 && v <= n), 'solution has a blank or out-of-range cell');
    ok(isSolved(sol, n, box), 'stored solution does NOT satisfy the units');
    ok(badCells(sol, n, box).size === 0, 'stored solution trips the bad-cell check');
    ok(givens.every((v, i) => v === 0 || v === sol[i]), 'a given disagrees with the solution');
    ok(givens.some(Boolean), 'board has no givens');

    // an empty board must be neither solved nor flagged: no instant win, no instant loss
    const empty = new Array(total).fill(0);
    ok(!isSolved(empty, n, box), 'empty board reads as solved');
    ok(badCells(empty, n, box).size === 0, 'empty board has bad cells');

    // candidates implied by the givens must always carry the solution digit
    const C0 = candsFrom(givens, n, box);
    ok(givens.every((v, i) => v || (C0[i] & (1 << (sol[i] - 1)))), 'a given eliminated the solution digit');

    // All-diff must never strip the solution digit from any cell. On a fresh board the pencil
    // marks already respect the givens, so write a digit the way play does (no propagation) and
    // require the pattern to find the work it creates.
    const C1 = C0.slice();
    const probeV = givens.slice();
    const probeCell = givens.findIndex((v, i) => !v);
    probeV[probeCell] = sol[probeCell];
    const ad = allDiff(probeV, C1, n, box);
    ok(ad.elims > 0, 'all-diff found nothing to eliminate after a digit was typed');
    ok(probeV.every((v, i) => v || (C1[i] & (1 << (sol[i] - 1)))), 'all-diff removed a solution digit');

    // One-of may only place digits the solution agrees with
    const V1 = givens.slice(), C2 = C1.slice();
    const oo = oneOf(V1, C2, n, box);
    ok(oo.places.every((p) => p.d === sol[p.i]), 'one-of placed a digit that contradicts the solution');

    // Ripple from the givens must finish the board — the patterns alone are a winning path
    const V2 = givens.slice(), C3 = candsFrom(givens, n, box);
    const r = ripple(V2, C3, n, box);
    ok(V2.every((v, i) => v === sol[i]), `ripple did not reach the solution (${V2.filter((v, i) => v && v !== sol[i]).length} wrong, ${V2.filter((v) => !v).length} empty)`);
    ok(r.places.length > 0, 'ripple placed nothing');
    ok(isSolved(V2, n, box), 'rippled board does not pass the win check');
    console.log(`    ripple: ${r.places.length} placed, ${r.elims} eliminated -> solved`);

    // a duplicate in a unit has to be flagged
    const dup = givens.slice();
    const u = unitsOf(n, box)[0];
    dup[u[0]] = 1; dup[u[1]] = 1;
    ok(badCells(dup, n, box).size >= 2, 'a duplicated digit was not flagged');

    // one missing cell breaks the win
    const nearly = sol.slice();
    nearly[total - 1] = 0;
    ok(!isSolved(nearly, n, box), 'a board with one empty cell reads as solved');
  }
}

console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS all boards');
process.exit(fails ? 1 : 0);
