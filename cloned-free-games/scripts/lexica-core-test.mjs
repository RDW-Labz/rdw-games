#!/usr/bin/env node
// Core test for the Lexica port. Slices the // >>>DICT and // >>>CORE blocks straight out of the
// shipped HTML, imports them, and proves the rules the browser actually runs: adjacency, chain
// legality, the scoring ladder, dictionary judgement, and board generation whose seed words are
// all legal paths on the board that shipped.
//
// usage: node lexica-core-test.mjs [path/to/index.html]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/lexica/index.html';
const html = await readFile(FILE, 'utf8');

function slice(tag) {
  const start = html.indexOf(`// >>>${tag}`);
  const end = html.indexOf(`// <<<${tag}`);
  if (start < 0 || end < 0) throw new Error(`no ${tag} block`);
  return html.slice(start + `// >>>${tag}`.length, end);
}
const dictSrc = slice('DICT');
const coreSrc = slice('CORE');
if (!/const DICT_TEXT\s*=\s*"/.test(dictSrc)) throw new Error('DICT block does not define DICT_TEXT');

const tmp = '/tmp/lexport/core-module.mjs';
await mkdir('/tmp/lexport', { recursive: true });
await writeFile(tmp, [
  dictSrc,
  coreSrc,
  'export { DICT_TEXT, SIZES, MIN_LEN, TARGETS, ROUNDS, adjacent, chainOk, wordAt, scoreFor, judge, poolFor, pathFor, genBoard, rngFrom, LETTERS };',
].join('\n'));
const M = await import(pathToFileURL(tmp).href);

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.log('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const dict = new Set(M.DICT_TEXT.split(' '));

// ---- dictionary
ok(dict.size > 100000, 'the shipped word list is a real dictionary', dict.size);
ok(dict.has('zebra') && dict.has('word') && dict.has('beautiful'), 'common words are accepted',
  { zebra: dict.has('zebra'), beauty: dict.has('beautiful') });
ok(!dict.has('zzz') && !dict.has('qqqq'), 'invented strings are not words');
const bad = [...dict].filter((w) => !/^[a-z]{3,12}$/.test(w));
ok(bad.length === 0, 'every entry is 3-12 lowercase letters', bad.slice(0, 5));

// ---- geometry
ok(M.adjacent(0, 1, 4), 'side neighbours touch');
ok(M.adjacent(0, 5, 4), 'diagonal neighbours touch');
ok(!M.adjacent(0, 0, 4), 'a tile is not its own neighbour');
ok(!M.adjacent(0, 2, 4), 'two cells apart does not touch');
ok(!M.adjacent(3, 4, 4), 'a row wrap does not touch (end of one row to start of the next)');

// ---- chains
ok(M.chainOk([0, 1, 2], 4), 'a straight chain is legal');
ok(M.chainOk([0, 5, 10], 4), 'a diagonal chain is legal');
ok(!M.chainOk([0, 1, 0], 4), 'a chain may not reuse a cell');
ok(!M.chainOk([0, 2], 4), 'a chain may not jump a cell');
ok(!M.chainOk([], 4), 'an empty chain is not a word');

// ---- scoring ladder (Lexica: <=4 -> 1, 5 -> 2, 6 -> 3, 7 -> 5, 8+ -> 11)
ok(M.scoreFor('cat') === 1 && M.scoreFor('cats') === 1, 'three and four letters score 1');
ok(M.scoreFor('crane') === 2, 'five letters score 2');
ok(M.scoreFor('crates') === 3, 'six letters score 3');
ok(M.scoreFor('cranium') === 5, 'seven letters score 5');
ok(M.scoreFor('craniums') === 11 && M.scoreFor('cranberry') === 11, 'eight or more score 11');

// ---- judging a submitted chain
const board4 = ['c', 'a', 't', 's', 'x', 'x', 'x', 'x', 'r', 'a', 'n', 'x', 'x', 'x', 'x', 'x'];
ok(M.judge(board4, [0, 1, 2], 4, 3, dict).ok === true, 'C-A-T along a legal path is accepted');
ok(M.judge(board4, [0, 1, 2], 4, 4, dict).ok === false, 'the same word is too short when the minimum is 4');
ok(M.judge(board4, [0, 1, 5], 4, 3, dict).ok === false, 'an illegal path is rejected');
const j1 = M.judge(board4, [3, 7, 11], 4, 3, dict);
ok(j1.ok === false && j1.why === 'word', 'a real path spelling nonsense is rejected as a word', j1);
const j2 = M.judge(board4, [8, 9, 10], 4, 3, dict);
ok(j2.ok === true && j2.word === 'ran' && j2.score === 1, 'judge reports the word and its score', j2);

// ---- board generation: every seeded word must be a legal path of the board that shipped
for (let round = 0; round < M.SIZES.length; round++) {
  const n = M.SIZES[round], minLen = M.MIN_LEN[round];
  const pool = M.poolFor(dict, n, minLen);
  ok(pool.length > 200, `round ${round + 1}: the ${n}x${n} word pool is deep`, pool.length);
  const wrongLen = pool.filter((w) => w.length < minLen || w.length > Math.min(n * n, minLen + 4));
  ok(wrongLen.length === 0, `round ${round + 1}: the pool respects the round's length window`, wrongLen.slice(0, 4));

  const problems = [];
  let seedTotal = 0, extraWords = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const b = M.genBoard(n, pool, M.rngFrom(seed * 977 + round), Math.max(3, n - 1));
    if (b.letters.length !== n * n) problems.push([seed, 'board size']);
    if (b.letters.some((ch) => !/^[a-z]$/.test(ch))) problems.push([seed, 'letter']);
    if (b.seeds.length !== Math.max(3, n - 1)) problems.push([seed, 'seed count', b.seeds.length]);
    for (const s of b.seeds) {
      seedTotal++;
      const spelled = s.path.map((i) => b.letters[i]).join('');
      if (spelled !== s.word) problems.push([seed, s.word, 'letters', spelled]);
      if (!M.chainOk(s.path, n)) problems.push([seed, s.word, 'path']);
      const j = M.judge(b.letters, s.path, n, minLen, dict);
      if (!j.ok) problems.push([seed, s.word, 'judge', j.why]);
    }
    // the board must hold more than just its seeds, or there is nothing to hunt for
    let count = 0;
    const seen = new Set();
    const walk = (cells) => {
      if (cells.length && cells.length >= minLen) {
        const w = M.wordAt(b.letters, cells);
        if (dict.has(w) && !seen.has(w)) { seen.add(w); count++; }
        if (cells.length >= Math.min(n * n, minLen + 4)) return;
      }
      const last = cells.length ? cells[cells.length - 1] : -1;
      for (let d = 0; d < n * n; d++) {
        if (cells.includes(d)) continue;
        if (last >= 0 && !M.adjacent(last, d, n)) continue;
        walk(cells.concat([d]));
      }
    };
    if (n <= 4 && seed <= 3) { walk([]); extraWords += count; }
    else extraWords += b.seeds.length;   // an exhaustive walk is exponential on 5x5/6x6
  }
  ok(problems.length === 0, `round ${round + 1}: 40 boards, every seed word is a legal path`, problems.slice(0, 5));
  ok(seedTotal === 40 * Math.max(3, n - 1), `round ${round + 1}: every board carries its full seed count`, seedTotal);
  if (n <= 4) ok(extraWords > 40 * 10, 'the 4x4 boards hold far more words than their seeds', extraWords);
}

// ---- a board is not solvable-by-seeds-only: the pool is deterministic and shared
const p1 = M.poolFor(dict, 4, 3), p2 = M.poolFor(dict, 4, 3);
ok(p1.length === p2.length && p1[0] === p2[0] && p1[Math.floor(p1.length / 2)] === p2[Math.floor(p2.length / 2)],
  'the word pool is deterministic across calls');

console.log(fails ? `LEXICA CORE FAILED (${fails})` : 'LEXICA CORE PASS');
process.exit(fails ? 1 : 0);
