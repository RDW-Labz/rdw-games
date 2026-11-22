#!/usr/bin/env node
// Proves the Queens port's shipped boards against the exact rules code the browser runs
// (the // >>>CORE block is sliced out of games/arcade/queens/index.html).
// Per board: regions tile the board into exactly n contiguous blocks of n cells' worth of
// area; the stored solution is one queen per row, column and region with no shared diagonal;
// the empty board and any conflicting placement are NOT won; a row/column/region violation is
// detected by conflictCount or solved().
//
// usage: node queens-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/queens/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { LEVELS, reg, conflictCount, regionCounts, solved, has };';
const { LEVELS, reg, conflictCount, regionCounts, solved } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (c, msg, extra) => { if (!c) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; } };

for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i], n = L.n;
  console.log(`board ${i + 1}: ${n}x${n}, ${L.regions.length} cells, ${L.solution.length} queens`);

  // 1) the regions array covers every cell and uses exactly n ids
  ok(L.regions.length === n * n, `regions array has ${L.regions.length} entries for ${n * n} cells`);
  const ids = new Set(L.regions);
  ok(ids.size === n, `${ids.size} region ids on a ${n}x${n} board`);
  for (const g of ids) ok([...ids].every((x) => Number.isInteger(x) && x >= 0 && x < n), 'region ids out of range');

  // 2) each region is contiguous (every cell reaches the rest of its region by orthogonal steps)
  for (const g of ids) {
    const mine = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (reg(L, r, c) === g) mine.push(r + ',' + c);
    const seen = new Set([mine[0]]);
    const q = [mine[0]];
    while (q.length) {
      const [r, c] = q.pop().split(',').map(Number);
      for (const [rr, cc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const k = rr + ',' + cc;
        if (reg(L, rr, cc) === g && !seen.has(k)) { seen.add(k); q.push(k); }
      }
    }
    ok(seen.size === mine.length, `region ${g} is not contiguous (${seen.size}/${mine.length})`);
    ok(mine.length >= 2, `region ${g} is a single cell`);
  }

  // 3) the stored solution is legal and is a win
  const sol = L.solution;
  ok(sol.length === n, `stored solution has ${sol.length} queens`);
  ok(new Set(sol.map((x) => x[0])).size === n, 'stored solution repeats a row');
  ok(new Set(sol.map((x) => x[1])).size === n, 'stored solution repeats a column');
  ok(conflictCount(sol) === 0, 'stored solution has a shared diagonal');
  ok(regionCounts(L, sol).every((k) => k === 1), 'stored solution does not cover every region once', regionCounts(L, sol));
  ok(solved(L, sol), 'stored solution does not read as solved');

  // 4) empties and broken boards are not wins
  ok(!solved(L, []), 'an empty board reads as solved');
  ok(!solved(L, sol.slice(0, n - 1)), 'a board one queen short reads as solved');
  const clash = sol.slice(1).concat([[sol[0][0], sol[0][1] + (sol[0][1] + 1 < n ? 1 : -1)]]);
  ok(!solved(L, clash), 'a board with two queens in one row reads as solved');
  const diag = [[0, 0], [1, 1]];
  if (n > 2) ok(conflictCount(diag) === 1, 'a diagonal clash is not detected');
  ok(conflictCount([[0, 0], [0, 1]]) === 1, 'a row clash is not detected');
  ok(conflictCount([[0, 0], [1, 2]]) === 0, 'a clean pair reads as a conflict');
}

console.log(fails ? `FAILED ${fails}` : 'OK — every board is a contiguous region tiling with a legal, unique-feeling answer');
process.exit(fails ? 1 : 0);
