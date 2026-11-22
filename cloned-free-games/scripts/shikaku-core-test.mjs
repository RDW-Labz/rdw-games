#!/usr/bin/env node
// Proves the Shikaku port's shipped boards with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/shikaku/index.html.
// Per board: the stored rect list must be a true partition (every cell covered once), every
// rect must hold exactly one clue whose value is its area, every clue must be claimed once,
// the stored division must read as solved, an empty board must not, and the legality test
// must reject a wrong-area box, a two-clue box and an overlapping box.
//
// usage: node shikaku-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/shikaku/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { LEVELS, areaOf, rectBetween, cluesIn, overlaps, rectOk, coveredSet, solved };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LEVELS, areaOf, rectBetween, cluesIn, overlaps, rectOk, coveredSet, solved } = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };

for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  const n = L.n;
  console.log(`board ${i + 1}: ${n}x${n}, ${L.rects.length} rects, ${L.clues.length} clues`);

  // 1) the stored rects are a partition of the board exactly once
  const cov = coveredSet(L.rects);
  ok(cov.size === n * n, `rects cover ${cov.size} of ${n * n} cells`);
  let overlapCount = 0;
  for (let a = 0; a < L.rects.length; a++) for (let b = a + 1; b < L.rects.length; b++) if (overlaps(L.rects[a], L.rects[b])) overlapCount++;
  ok(overlapCount === 0, `${overlapCount} overlapping rect pairs in the stored solution`);
  for (const [r0, c0, r1, c1] of L.rects) ok(r0 <= r1 && c0 <= c1 && r0 >= 0 && c1 < n, 'rect out of bounds / inverted');

  // 2) exactly one clue per rect, and its value is the rect's area
  const claimed = new Map();
  for (const rc of L.rects) {
    const inside = cluesIn(L, rc);
    ok(inside.length === 1, `rect ${JSON.stringify(rc)} holds ${inside.length} clues`);
    if (inside.length === 1) {
      ok(inside[0][2] === areaOf(rc), `rect ${JSON.stringify(rc)} area ${areaOf(rc)} but clue says ${inside[0][2]}`);
      claimed.set(inside[0][0] + ',' + inside[0][1], (claimed.get(inside[0][0] + ',' + inside[0][1]) || 0) + 1);
    }
  }
  // 3) every shipped clue is claimed by exactly one rect (no orphan clues that can never fit)
  for (const [r, c, v] of L.clues) {
    ok(v >= 1 && v <= n * n, `clue ${v} at ${r},${c} cannot be a rectangle area on a ${n}x${n} board`);
    ok((claimed.get(r + ',' + c) || 0) === 1, `clue at ${r},${c} is claimed ${claimed.get(r + ',' + c) || 0} times`);
  }
  ok(L.clues.length === L.rects.length, `${L.clues.length} clues for ${L.rects.length} rects`);

  // 4) the stored division is a win; the empty board is not
  ok(solved(L, L.rects), 'stored division does not read as solved');
  ok(!solved(L, []), 'empty board reads as solved');

  // 5) partial placement is not a win
  ok(!solved(L, L.rects.slice(0, Math.max(1, L.rects.length - 1))), 'board missing one rect reads as solved');

  // 6) legality rejects the three ways a box can be wrong
  const rc = L.rects[0];
  const grow = [rc[0], rc[1], Math.min(n - 1, rc[2] + 1), rc[3]];
  if (areaOf(grow) !== areaOf(rc)) ok(!rectOk(L, grow, []), 'a box with the wrong area was accepted');
  ok(layoutTwoClues(L) === null || !rectOk(L, layoutTwoClues(L), []), 'a box holding two clues was accepted');
  ok(!rectOk(L, rc, [rc]), 'a box overlapping a placed one was accepted');
  ok(rectOk(L, rc, []), 'a legal stored rect was rejected');

  // 7) the opening board carries a 1x1 clue the tap gate can legally claim in one cell
  if (i === 0) ok(L.clues.some(([, , v]) => v === 1), 'board 1 has no 1x1 clue for the tap gate');
}

// a rectangle that contains two clues: take the two nearest clues and box them together
function layoutTwoClues(L) {
  const cs = L.clues;
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
    const rc = rectBetween([cs[a][0], cs[a][1]], [cs[b][0], cs[b][1]]);
    if (cluesIn(L, rc).length === 2) return rc;
  }
  return null;
}

console.log(fails ? `FAILED ${fails}` : 'OK — every shipped board is a legal partition, solvable and correctly policed');
process.exit(fails ? 1 : 0);
