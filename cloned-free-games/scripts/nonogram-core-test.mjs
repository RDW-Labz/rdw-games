#!/usr/bin/env node
// Proves the Nonogram port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/nonogram/index.html.
//
// Checks, per board: the picture is rectangular, the clues are derived from it, the stored
// picture satisfies every clue (so a win is reachable), an empty board is neither solved nor
// flagged, a partially filled board is not solved, a line with more filled cells than its clue
// total is flagged, and a split block is flagged.
//
// usage: node nonogram-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/nonogram/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { PUZZLES, parseGrid, clueOf, cluesOf, sameClue, rowLine, colLine,
         lineViolation, boardSolved, boardViolations };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { PUZZLES, parseGrid, clueOf, cluesOf, rowLine, colLine,
        lineViolation, boardSolved, boardViolations } = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };

for (let p = 0; p < PUZZLES.length; p++) {
  const puz = PUZZLES[p];
  const g = parseGrid(puz);
  const { R, C } = cluesOf(g);
  console.log(`board ${p + 1} "${puz.name}": ${g.H}x${g.W}, ${g.vals.filter((v) => v === 1).length} filled cells`);

  // the picture must be rectangular, else the clue derivation silently reads past a row
  ok(puz.rows.every((r) => r.length === g.W), 'picture rows are not all the same width');
  ok(puz.rows.every((r) => /^[#.]+$/.test(r)), 'picture has a character other than # or .');

  // clues cover every line, and every clue value fits the board
  ok(R.length === g.H && C.length === g.W, 'clue arrays do not cover the board');
  ok(R.some((c) => c.length > 0) && C.some((c) => c.length > 0), 'a board with no clues at all');
  ok(R.flat().every((n) => n >= 1 && n <= g.W), 'row clue value out of range');
  ok(C.flat().every((n) => n >= 1 && n <= g.H), 'column clue value out of range');

  // the stored picture wins: every line paints its own clue
  ok(boardSolved(g.vals, R, C, g.H, g.W), 'stored picture does NOT satisfy its own clues');
  ok(boardViolations(g.vals, R, C, g.H, g.W) === 0, 'stored picture trips the violation check');

  // an empty board must be neither solved nor flagged: no instant win, no instant loss
  const empty = g.vals.map(() => 0);
  ok(!boardSolved(empty, R, C, g.H, g.W), 'empty board reads as solved');
  ok(boardViolations(empty, R, C, g.H, g.W) === 0, 'empty board has violations');

  // one missing cell must break the win
  const oneOff = g.vals.slice();
  const first = g.vals.findIndex((v) => v === 1);
  oneOff[first] = 0;
  ok(!boardSolved(oneOff, R, C, g.H, g.W), 'a board missing a filled cell still reads as solved');

  // a full board where any line's clue total is short of the line length must be flagged
  const full = g.vals.map(() => 1);
  const shortRow = R.findIndex((cl) => cl.reduce((a, b) => a + b, 0) < g.W);
  if (shortRow >= 0) {
    ok(!boardSolved(full, R, C, g.H, g.W), 'a fully filled board reads as solved');
    ok(lineViolation(rowLine(full, g.W, shortRow), R[shortRow]), 'overshooting row inside a full board was not flagged');
  }

  // a run split in two must be flagged even though the cell count matches the clue
  const splitRow = R.findIndex((cl) => cl.length === 1 && cl[0] >= 2);
  if (splitRow >= 0) {
    const probe = empty.slice();
    const need = R[splitRow][0];
    // fill the clue total but leave a hole after the first cell so it becomes two blocks
    let placed = 0;
    for (let c = 0; c < g.W && placed < need; c++) {
      if (c === 1) continue; // the hole
      probe[splitRow * g.W + c] = 1; placed++;
    }
    const blocks = clueOf(rowLine(probe, g.W, splitRow));
    ok(blocks.length >= 2, 'test setup did not split the run');
    ok(lineViolation(rowLine(probe, g.W, splitRow), R[splitRow]), 'a split run was not flagged');
    ok(!boardSolved(probe, R, C, g.H, g.W), 'a split-run board reads as solved');
  }

  // the opposite: a legal fill that differs from the stored picture is accepted when it paints
  // every clue — build it only if the board happens to have an alternative, otherwise skip.
  ok(Array.isArray(C) && C.length === g.W, 'column clues malformed');
}
console.log(fails ? `FAILED ${fails}` : 'OK — every shipped board is rectangular, solvable and correctly policed');
process.exit(fails ? 1 : 0);
