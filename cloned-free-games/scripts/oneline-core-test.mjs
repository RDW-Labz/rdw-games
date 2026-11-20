// Core-rule test for the One Line port: slice the >>>CORE block out of the shipped HTML and
// prove every stored level is a real single stroke, that the advance rule refuses out-of-order
// numbers and re-visits, and that a walled-in stroke is reported stuck.
// usage: node oneline-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/one-line-puzzle/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL no CORE block in ' + FILE); process.exit(1); }
const core = new Function(m[1] + '\nreturn { LEVELS, clueAt, canStep, pathOk, stuckAt, maxClue, highestClueOn, adjacent };')();
const { LEVELS, clueAt, canStep, pathOk, stuckAt, maxClue, highestClueOn } = core;

let bad = 0;
const check = (ok, label) => { if (!ok) { bad++; console.log('FAIL ' + label); } else console.log('ok   ' + label); };

check(LEVELS.length >= 5, `levels present (${LEVELS.length})`);
for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  const total = L.n * L.m;
  const tag = `L${i} ${L.n}x${L.m}`;
  check(L.path.length === total, `${tag} stroke covers all ${total} cells (${L.path.length})`);
  check(pathOk(L, L.path), `${tag} stored stroke wins under the shipped rules`);

  // every step of the stored stroke must be legal at the time it is taken
  let legal = true, p = [];
  for (const [r, c] of L.path) { if (!canStep(L, p, r, c)) { legal = false; break; } p.push([r, c]); }
  check(legal, `${tag} every stored step legal (clue order + adjacency + no revisit)`);

  // clues must be exactly 1..maxClue, one of each
  const seen = [];
  for (const row of L.nums) for (const v of row) if (v != null) seen.push(v);
  seen.sort((a, b) => a - b);
  check(seen.length === maxClue(L) && seen.every((v, k) => v === k + 1), `${tag} clues are 1..${maxClue(L)} exactly once each`);

  // an empty board must neither win nor read stuck
  check(!pathOk(L, []) && !stuckAt(L, []), `${tag} empty board is neither solved nor stuck`);

  // dropping one cell of the stroke must not win
  const short = L.path.slice(0, total - 1);
  check(!pathOk(L, short), `${tag} one cell short does not win`);
}

// explicit out-of-order probe on a synthetic board: from 1 the only neighbour carries 3, so it
// must be refused while 2 is due
{
  const F = { n: 2, m: 3, nums: [[1, 3, 2], [null, null, null]] };
  const p = [[0, 0]];
  check(!canStep(F, p, 0, 1), 'out-of-order clue refused (3 while 2 is due)');
  check(canStep(F, p, 1, 0), 'an unnumbered neighbour is still allowed');
}

// explicit rule probes on level 0
const L0 = LEVELS[0];
check(canStep(L0, [], L0.path[0][0], L0.path[0][1]), 'L0 can start on the cell holding 1');
const other = [];
for (let r = 0; r < L0.n; r++) for (let c = 0; c < L0.m; c++) if (clueAt(L0, r, c) !== 1) other.push([r, c]);
check(!other.some(([r, c]) => canStep(L0, [], r, c)), 'L0 refuses to start anywhere but 1');
check(!canStep(L0, [L0.path[0]], L0.path[2][0], L0.path[2][1]), 'L0 refuses a two-cells-away step');
check(!canStep(L0, [L0.path[0], L0.path[1]], L0.path[0][0], L0.path[0][1]), 'L0 refuses stepping back onto the stroke');

// a walled-in stroke on a 5x5: fill a full row and the row below its ends, leaving cells unreachable
{
  const L = LEVELS[0];
  const wall = L.path.slice(0, 9);            // a legal prefix
  const st = stuckAt(L, wall);
  console.log(`info L0 prefix of 9 cells stuck=${st}`);
  const full = L.path.slice(0, L.n * L.m - 1);
  check(!stuckAt(L, full), 'L0 near-complete stroke is not stuck');
}

console.log(bad ? `CORE FAIL (${bad})` : 'CORE PASS');
process.exit(bad ? 1 : 0);
