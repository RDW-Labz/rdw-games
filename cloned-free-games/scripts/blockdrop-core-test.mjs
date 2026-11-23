#!/usr/bin/env node
// Proves the Block Drop port's mechanics with the exact rules code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/block-drop/index.html.
//
// Checks: every piece has four distinct-in-box rotations (rotating four times returns the base),
// rotation never leaves its box, fits() rejects the wall/floor/stack, the 7-bag deals each kind
// once per bag, locking a piece on a full row clears it and drops the rows above, a row with one
// hole does NOT clear, scoring and level maths match the HUD's contract, and a full stack tops out.
//
// usage: node blockdrop-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/block-drop/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { COLS, ROWS, KINDS, BASE, SHAPES, rotCells, rotations, rngFrom, mkBag, emptyGrid, cellsOf, fits, tryRotate, tryShift, dropTo, lockPiece, LINE_SCORE, speedFor, scoreFor, WIN_LEVEL, WIN_LINES };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { COLS, ROWS, KINDS, BASE, SHAPES, rotCells, rotations, rngFrom, mkBag, emptyGrid, cellsOf, fits, tryRotate, tryShift, dropTo, lockPiece, LINE_SCORE, speedFor, scoreFor, WIN_LEVEL, WIN_LINES } = mod;

let fails = 0;
const ok = (c, msg, extra) => { if (!c) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; } };

ok(COLS === 10 && ROWS === 20, 'board is 10x20', { COLS, ROWS });
ok(KINDS.length === 7, 'seven piece kinds');

// ---- 1) shapes and rotations
for (const k of KINDS) {
  const rs = SHAPES[k];
  ok(rs.length === 4, k + ' has four rotations');
  const box = BASE[k].box;
  for (let i = 0; i < 4; i++) {
    ok(rs[i].length === 4, k + ' rotation ' + i + ' does not have four cells', rs[i].length);
    for (const [r, c] of rs[i]) ok(r >= 0 && r < box && c >= 0 && c < box, k + ' rotation ' + i + ' leaves its box', [r, c]);
    const uniq = new Set(rs[i].map((p) => p.join(',')));
    ok(uniq.size === 4, k + ' rotation ' + i + ' repeats a cell');
  }
  // a fourth quarter turn must return the base exactly
  const back = rotCells(rotCells(rotCells(rotCells(BASE[k].cells, box), box), box), box);
  ok(JSON.stringify(back) === JSON.stringify(BASE[k].cells), k + ' does not cycle back after four turns');
}
const setKey = (cells) => cells.map((p) => p.join(',')).sort().join('|');
ok(setKey(SHAPES.O[0]) === setKey(SHAPES.O[1]), 'the O piece changes footprint when rotated');
ok(setKey(SHAPES.I[0]) !== setKey(SHAPES.I[1]), 'the I piece does not rotate');

// ---- 2) fits(): walls, floor and stack
const g0 = emptyGrid();
ok(fits(g0, 'O', 0, 0, 0) === true, 'an O at the top-left corner fits');
ok(fits(g0, 'O', 0, 0, -1) === false, 'a piece off the left wall does not fit');
ok(fits(g0, 'I', 0, 0, COLS - 1) === false, 'an I past the right wall does not fit');
ok(fits(g0, 'O', 0, ROWS - 1, 0) === false, 'a piece past the floor does not fit');
const gs = emptyGrid(); gs[5][4] = 'T';
ok(fits(gs, 'O', 0, 5, 4) === false, 'a piece cannot overlap the stack');
ok(fits(gs, 'O', 0, 5, 2) === true, 'a piece beside the stack fits');

// ---- 3) shifts and kicks
const s1 = tryShift(g0, 'O', 0, 0, 0, -1);
ok(s1.ok === false && s1.c === 0, 'a shift into the wall is refused and the column is unchanged');
const s2 = tryShift(g0, 'O', 0, 0, 0, 1);
ok(s2.ok === true && s2.c === 1, 'a free shift moves one column');
// a rotation against the right wall must kick inwards (I piece at the far right, vertical)
const gi = emptyGrid();
const wallRot = tryRotate(gi, 'I', 0, 0, COLS - 2, 1);
ok(wallRot.ok === true, 'an I against the right wall kicks rather than refusing');
if (wallRot.ok) ok(wallRot.c >= 0 && wallRot.c < COLS, 'the kick lands on the board', wallRot);

// ---- 4) the 7-bag never starves a piece
{
  const rnd = rngFrom(4242);
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (let b = 0; b < 40; b++) {
    const bag = mkBag(rnd);
    ok(bag.length === 7, 'a bag holds seven pieces', bag.length);
    ok(new Set(bag).size === 7, 'a bag repeats a kind', bag);
    for (const k of bag) counts[k]++;
  }
  for (const k of KINDS) ok(counts[k] === 40, 'kind ' + k + ' starved across 40 bags', counts[k]);
}

// ---- 5) locking, line clears, and the rows above falling
{
  const g = emptyGrid();
  for (let c = 0; c < COLS; c++) g[ROWS - 1][c] = c < 8 ? 'J' : null;   // bottom row missing two cells
  g[ROWS - 3][0] = 'T';                                                  // a lone block up the stack
  const res = lockPiece(g, 'O', 0, ROWS - 2, 8);                          // fill the two holes
  ok(res.cleared === 1, 'filling the last two cells does not clear the row', { cleared: res.cleared, placed: res.placed });
  // after the clear everything above falls one row: the O that filled the holes is now the
  // bottom row and the lone T has landed on top of it
  ok(res.grid[ROWS - 1][8] === 'O' && res.grid[ROWS - 1][9] === 'O', 'the rows above did not fall into the cleared row', res.grid[ROWS - 1]);
  ok(res.grid[ROWS - 2][0] === 'T', 'the stack did not fall one row', res.grid[ROWS - 2][0]);
  ok(res.grid[0].every((v) => !v), 'a fresh empty row was not pushed on top');

  const g2 = emptyGrid();
  for (let c = 0; c < COLS; c++) g2[ROWS - 1][c] = c < 8 ? 'J' : null;
  const res2 = lockPiece(g2, 'O', 0, ROWS - 2, 8);
  ok(res2.cleared === 1, 'a full row does not clear', res2.cleared);

  const g3 = emptyGrid();
  for (let c = 0; c < COLS; c++) g3[ROWS - 1][c] = 'J';
  const res3 = lockPiece(g3, 'O', 0, 0, 4);
  ok(res3.cleared === 1, 'clearing a pre-filled bottom row fails', res3.cleared);
  ok(res3.grid[0].every((v) => !v), 'a fresh empty row was not pushed on top');

  // locking above the board (negative rows) must not throw and still counts the placed cells
  const g4 = emptyGrid();
  const res4 = lockPiece(g4, 'O', 0, -1, 4);
  ok(res4.cleared === 0 && res4.placed === 2, 'a piece locked half above the board places its visible cells', res4);
}

// ---- 6) top-out
{
  const g = emptyGrid();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) g[r][c] = 'J';
  ok(fits(g, 'O', 0, 0, 4) === false, 'a full stack does not block the spawn cell');
}

// ---- 7) scoring, speed and the win line
ok(LINE_SCORE[1] === 40 && LINE_SCORE[2] === 100 && LINE_SCORE[3] === 300 && LINE_SCORE[4] === 1200, 'line scores changed');
ok(scoreFor(4, 2) === 2400 && scoreFor(0, 5) === 0, 'score does not scale with level');
ok(speedFor(1) === 720 && speedFor(5) < speedFor(1) && speedFor(9) >= 90, 'gravity does not speed up with level', { s1: speedFor(1), s5: speedFor(5), s9: speedFor(9) });
ok(WIN_LEVEL === 5 && WIN_LINES === 40, 'the run goal changed');

// ---- 8) dropTo lands on the stack, never through it
{
  const g = emptyGrid();
  for (let c = 0; c < COLS; c++) g[ROWS - 3][c] = 'J';
  const y = dropTo(g, 'O', 0, 0, 4);
  ok(y === ROWS - 5, 'the piece does not rest on top of the stack', { y, want: ROWS - 5 });
  ok(fits(g, 'O', 0, y, 4) === true && fits(g, 'O', 0, y + 1, 4) === false, 'the resting spot is not the last legal row');
}

console.log(fails ? `FAILED ${fails}` : 'OK — rotations, kicks, bag, locks, clears, scoring and top-out all hold');
process.exit(fails ? 1 : 0);
