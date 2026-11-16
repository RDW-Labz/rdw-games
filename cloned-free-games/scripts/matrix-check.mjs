#!/usr/bin/env node
// Prove the shipped Matrix Puzzle levels against the exact rules the browser runs.
//
// The port keeps its pure rules between `// >>>CORE` and `// <<<CORE`. This script slices
// that block out of the deployed HTML file, evaluates it in node, and asserts for every
// level that (a) the stored solution satisfies every clue and (b) it is the *only*
// assignment that does — so nothing ships that is unsolvable or ambiguous.
//
//   node scripts/matrix-check.mjs [path/to/matrix-puzzle.html]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || resolve(here, '../../kaos/work/site/games/arcade/matrix-puzzle.html');
const html = readFileSync(file, 'utf8');

const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) {
  console.error('FAIL: no // >>>CORE … // <<<CORE block in ' + file);
  process.exit(1);
}
const src = m[1] +
  '\nreturn { LEVELS, clueHolds, clueStatus, brokenCount, isSolved, countSolutions, itemKey };';
// new Function is deliberate: the input is this repo's own shipped CORE block, read from
// disk at build-check time — never remote or user-supplied text.
const CORE = new Function(src)();

let bad = 0;
const fail = (id, msg) => { bad++; console.error(`FAIL level ${id}: ${msg}`); };

for (const level of CORE.LEVELS) {
  const total = level.cats.reduce((n, c) => n + c.items.length, 0);
  if (total !== level.cats.length * level.floors) fail(level.id, `${total} items for ${level.cats.length}x${level.floors}`);

  if (level.solution.length !== level.floors) fail(level.id, `solution has ${level.solution.length} floors, wants ${level.floors}`);
  const pos = {};
  level.solution.forEach((row, r) => {
    if (new Set(row).size !== row.length) fail(level.id, `floor ${r + 1} repeats an item`);
    row.forEach((item, c) => {
      if (!level.cats[c] || !level.cats[c].items.includes(item)) fail(level.id, `floor ${r + 1} has ${item} in the wrong column`);
      pos[CORE.itemKey(c, item)] = r;
    });
  });
  if (Object.keys(pos).length !== total) fail(level.id, 'solution does not place every item exactly once');

  const statuses = level.clues.map((cl) => CORE.clueStatus(cl, pos));
  const broken = statuses.filter((s) => s === 'bad').length;
  if (broken) fail(level.id, `${broken} clue(s) contradicted by the stored solution`);
  if (statuses.includes('pending')) fail(level.id, 'a clue names an item that is not in the level');

  if (!CORE.isSolved(level, pos)) fail(level.id, 'isSolved() rejects the stored solution');

  const n = CORE.countSolutions(level, 2);
  if (n !== 1) fail(level.id, `has ${n === 0 ? 'no' : n} solution(s) — needs exactly 1`);

  console.log(`ok   level ${level.id}: ${level.floors} floors, ${level.clues.length} clues, unique solution`);
}

if (bad) {
  console.error(`\n${bad} problem(s) — do not publish this port.`);
  process.exit(1);
}
console.log('\nall levels verified against the shipped CORE block');
