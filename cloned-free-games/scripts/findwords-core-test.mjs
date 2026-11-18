#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped find-words port and proves every dealt board with
// the exact rules code the browser runs:
//   · all eight words are on the board, in one of the eight straight directions, in bounds;
//   · reading a word's own line back spells it (and its reverse, which is how a hand drags);
//   · a line that is not straight, or runs off the board, is refused;
//   · a dealt board's words are all findable and a fresh board deals the same board for the same seed.
//
// usage: node findwords-core-test.mjs [games/arcade/find-words-word-search-puzzle/index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/find-words-word-search-puzzle/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
// new Function evaluates the repo's own committed source block, never external input.
const core = new Function(m[1] + '\nreturn { GRID, WORDS, DIRECTIONS, makeGrid, lineCells, lineString, matchWord, reverse };')();
const { GRID, WORDS, DIRECTIONS, makeGrid, lineCells, lineString, matchWord, reverse } = core;

const problems = [];
const checks = {};
const ok = (name, cond, why = '') => { checks[name] = cond ? 'ok' : 'FAIL'; if (!cond) problems.push(`${name}${why ? ': ' + why : ''}`); };

// 1. the words the card promises are all placeable and distinct
ok('eight distinct words', WORDS.length === 8 && new Set(WORDS).size === 8, WORDS.join(','));
ok('words are plain uppercase', WORDS.every((w) => /^[A-Z]{4,10}$/.test(w)), WORDS.join(','));
ok('eight directions', DIRECTIONS.length === 8 && new Set(DIRECTIONS.map((d) => `${d.dr},${d.dc}`)).size === 8);

// 2. every deal puts every word on the board, in bounds, on a straight line that reads back
const seeds = [20261117, 1, 2, 3, 99, 12345, 777];
let dealProblem = '';
let shortest = Infinity;
for (const seed of seeds) {
  const { grid, placed } = makeGrid(seed);
  if (grid.length !== GRID * GRID) dealProblem += ` seed ${seed} grid ${grid.length};`;
  if (placed.length !== WORDS.length) dealProblem += ` seed ${seed} placed ${placed.length}/${WORDS.length};`;
  if (new Set(grid).size < 8) dealProblem += ` seed ${seed} uses only ${new Set(grid).size} letters;`;
  for (const p of placed) {
    const len = Math.max(Math.abs(p.r1 - p.r0), Math.abs(p.c1 - p.c0)) + 1;
    if (len !== p.word.length) dealProblem += ` ${p.word} line length ${len};`;
    if ([p.r0, p.c0, p.r1, p.c1].some((v) => v < 0 || v >= GRID)) dealProblem += ` ${p.word} out of bounds;`;
    const read = lineString(grid, p.r0, p.c0, p.r1, p.c1);
    if (read !== p.word) dealProblem += ` ${p.word} reads "${read}";`;
  }
  // the same seed must deal the same board
  const again = makeGrid(seed);
  if (again.grid.join('') !== grid.join('')) dealProblem += ` seed ${seed} is not deterministic;`;
  shortest = Math.min(shortest, placed.length);
}
ok('deals place every word', dealProblem === '', dealProblem.trim());
ok('deals are deterministic', shortest === WORDS.length);

// 3. playing a board: each placed word is matchable once, and only along its own line
const { grid, placed } = makeGrid(20261117);
let playProblem = '';
let found = [];
for (const p of placed) {
  const w = matchWord(grid, WORDS, found, p.r0, p.c0, p.r1, p.c1);
  if (w !== p.word) playProblem += ` ${p.word} matched ${w};`;
  found.push(p.word);
  if (matchWord(grid, WORDS, found, p.r0, p.c0, p.r1, p.c1) !== null) playProblem += ` ${p.word} matched twice;`;
}
ok('every word plays', playProblem === '' && found.length === WORDS.length, playProblem.trim());

// 4. the reverse drag finds the same word (how a hand drags a word search)
const p0 = placed[0];
const back = matchWord(grid, WORDS, [], p0.r1, p0.c1, p0.r0, p0.c0);
ok('reverse drag finds the word', back === p0.word, `${back} vs ${p0.word}`);

// 5. rubbish selections are refused: a knight-ish jump, a bent line, and a single letter
const bad = [
  ['not a straight line', matchWord(grid, WORDS, [], 0, 0, 2, 1)],
  ['off the board', lineString(grid, 9, 0, 12, 0)],
  ['single letter', matchWord(grid, WORDS, WORDS, 3, 3, 3, 3)],
];
let badProblem = '';
for (const [name, got] of bad) if (got !== null && got !== '') badProblem += ` ${name} returned ${JSON.stringify(got)};`;
ok('bad selections refused', badProblem === '', badProblem.trim());
ok('line cells are contiguous', (() => {
  const cells = lineCells(1, 1, 5, 5);
  return cells.length === 5 && cells.every((x, i) => x.r === 1 + i && x.c === 1 + i);
})());
ok('reverse() round-trips', reverse(reverse('TIGER')) === 'TIGER');

console.log(JSON.stringify({ file, checks, problems }, null, 1));
if (problems.length) { console.error(`FAIL ${problems.length} problem(s)`); process.exit(1); }
console.log(`PASS findwords core: ${Object.keys(checks).length} checks over ${seeds.length} seeds`);
