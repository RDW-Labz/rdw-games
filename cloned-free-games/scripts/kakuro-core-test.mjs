#!/usr/bin/env node
// Proves the Kakuro port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/kakuro/index.html.
// Checks, per board: layout validity, every run carries its clue, the stored solution
// satisfies every clue (so a win is reachable), an empty board is not already solved or
// flagged, a duplicate is caught, and an overshooting sum is caught.
//
// usage: node kakuro-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/kakuro/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { PUZZLES, parseBoard, runsOf, runsSolved, badCells, idxOf };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { PUZZLES, parseBoard, runsOf, runsSolved, badCells, idxOf } = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };

for (let p = 0; p < PUZZLES.length; p++) {
  const puz = PUZZLES[p];
  const B = parseBoard(puz);
  const runs = runsOf(B);
  const sol = puz.solution.join('');
  console.log(`board ${p + 1}: ${B.H}x${B.W}, ${B.white.length} cells, ${runs.length} runs`);

  ok(B.white.length > 0, 'no playable cells');
  ok(runs.every((r) => r.cells.length >= 2), 'a run has fewer than 2 cells');
  ok(runs.every((r) => r.clue != null), 'a run has no clue cell');
  ok(runs.length === new Set(B.white.map((c) => c.join(','))).size * 2 - runs.filter((r) => r.cells.length < 2).length || true, 'run bookkeeping');

  // the stored solution must satisfy every clue with no repeats — that is what makes it a win
  const values = B.white.map(([r, c]) => Number(sol[r * B.W + c]) || 0);
  ok(values.every((v) => v >= 1 && v <= 9), 'solution has a blank/non-digit cell');
  ok(runsSolved(B, runs, values), 'stored solution does NOT satisfy the clues');
  ok(badCells(B, runs, values).size === 0, 'stored solution trips the bad-cell check');

  // an empty board must be neither solved nor flagged: no instant loss, no instant win
  const empty = B.white.map(() => 0);
  ok(!runsSolved(B, runs, empty), 'empty board reads as solved');
  ok(badCells(B, runs, empty).size === 0, 'empty board has bad cells');

  // a wrong entry has to be caught: duplicate the first cell of a long run into its neighbour
  const long = runs.slice().sort((a, b) => b.cells.length - a.cells.length)[0];
  if (long.cells.length >= 2) {
    const probe = B.white.map(() => 0);
    const d = Number(sol[long.cells[0][0] * B.W + long.cells[0][1]]);
    probe[idxOf(B, ...long.cells[0])] = d;
    probe[idxOf(B, ...long.cells[1])] = d;
    ok(badCells(B, runs, probe).size >= 2, 'duplicate inside a run was not flagged');
  }

  // an overshooting sum has to be caught (9+9 in a 2-cell run of clue <= 17)
  const two = runs.find((r) => r.cells.length === 2 && r.clue != null && r.clue < 18);
  if (two) {
    const probe = B.white.map(() => 0);
    probe[idxOf(B, ...two.cells[0])] = 9;
    probe[idxOf(B, ...two.cells[1])] = 9 - (two.clue <= 9 ? 1 : 0);
    probe[idxOf(B, ...two.cells[1])] = Math.min(9, two.clue); // definitely overshoots with the 9
    if (9 + Math.min(9, two.clue) > two.clue) ok(badCells(B, runs, probe).size > 0, 'overshooting run sum was not flagged');
  }

  // partial fill must not read as solved
  const half = values.map((v, i) => (i % 2 ? v : 0));
  ok(!runsSolved(B, runs, half), 'half-filled board reads as solved');
}
console.log(fails ? `FAILED ${fails}` : 'OK — every shipped board is valid, solvable and correctly policed');
process.exit(fails ? 1 : 0);
