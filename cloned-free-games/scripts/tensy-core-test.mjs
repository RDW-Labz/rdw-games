#!/usr/bin/env node
// Proves the Tensy port's rules with the code the browser actually runs (the // >>>CORE slice of
// games/arcade/tensy/index.html): adjacency, the exact-ten search, the collapse/refill, and that
// every shipped boot board offers a legal first move.
// usage: node tensy-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/tensy/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { N, SUM, targets, mulberry32, neighbours, hasPath, findPath, mkBoard, collapse };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

ok(C.N === 6 && C.SUM === 10, 'a 6x6 board that clears runs of exactly ten', { N: C.N, SUM: C.SUM });
ok(JSON.stringify(C.targets) === '[20,28,36]', 'three targets, rising', C.targets);

// adjacency
ok(C.neighbours(0).length === 2, 'a corner has 2 neighbours', C.neighbours(0));
ok(C.neighbours(3).length === 3, 'a side cell has 3 neighbours', C.neighbours(3));
ok(C.neighbours(14).length === 4, 'a middle cell has 4 neighbours', C.neighbours(14));
ok(C.neighbours(14).every((j) => Math.abs(j - 14) === 1 || Math.abs(j - 14) === 6), 'neighbours are one step away', C.neighbours(14));

// search
const blank = new Array(36).fill(0);
ok(C.hasPath(blank) === false, 'an empty board has no ten');
ok(C.findPath(blank) === null, 'findPath returns null on an empty board');
const nines = new Array(36).fill(9);
ok(C.hasPath(nines) === false, 'a board of nines has no ten (no single 10, no pair under 11)', C.hasPath(nines));
const pair = new Array(36).fill(9);
pair[0] = 4; pair[1] = 6;
ok(C.hasPath(pair) === true, 'a touching 4 and 6 is a ten', pair.slice(0, 3));

const p = C.findPath(pair);
ok(p && p.length === 2 && p.includes(0) && p.includes(1), 'findPath finds the planted pair', p);
if (p) {
  const total = p.reduce((s, i) => s + pair[i], 0);
  ok(total === C.SUM, 'the found path sums to exactly ten', total);
  ok(p.every((v, k) => k === 0 || C.neighbours(p[k - 1]).includes(v)), 'the found path is orthogonally connected', p);
}

// a longer path: 1,2,3,4 in a line on row 0
const line = new Array(36).fill(9);
for (let i = 0; i < 4; i++) line[i] = i + 1;
const lp = C.findPath(line);
ok(lp && lp.reduce((s, i) => s + line[i], 0) === 10, 'a four-cell path can make ten', lp);

// collapse: the cleared cells are gone, every column is full, and the column order is preserved
const b0 = new Array(36).fill(0).map((_, i) => (i % 9) + 1);
const spawns = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
const before = b0.slice();
const after = C.collapse(b0, [0, 1], spawns);
ok(after.length === 36 && after.every((v) => v > 0), 'collapse leaves no holes', after);
ok(before[0] === 1 && after[30] === 4, 'the bottom of column 0 keeps its own lowest tile', { was0: before[0], bottom: after[30], col: [0, 6, 12, 18, 24, 30].map((i) => after[i]) });
ok(after[0] === 7, 'a fresh tile drops in at the top of the cleared column', [0, 6, 12, 18, 24, 30].map((i) => after[i]));
ok(JSON.stringify(b0) === JSON.stringify(before), 'collapse does not mutate its input', null);

// boot boards: full, in range, and always offering a legal first move
for (const seed of [77001, 81052, 85103, 89154]) {
  const b = C.mkBoard(seed);
  ok(b.length === 36, 'seed ' + seed + ' deals 36 cells', b.length);
  ok(b.every((v) => v >= 1 && v <= 9), 'seed ' + seed + ' keeps values 1..9', b.filter((v) => v < 1 || v > 9));
  ok(C.hasPath(b) === true, 'seed ' + seed + ' offers a legal first move', null);
  ok(JSON.stringify(C.mkBoard(seed)) === JSON.stringify(b), 'seed ' + seed + ' deals deterministically', null);
}

if (fails) { console.error(`\nTENSY CORE TEST FAILED (${fails})`); process.exit(1); }
console.log('TENSY CORE TEST PASS');
