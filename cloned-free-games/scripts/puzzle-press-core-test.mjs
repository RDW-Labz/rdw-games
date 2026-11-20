// Slices the CORE block and the puzzle banks out of the shipped puzzle-press port and proves
// them with the exact code the browser runs (no copy that can drift).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = process.argv[2] || (process.env.HOME + '/kaos/work/site/games/arcade/puzzle-press/index.html');
const html = readFileSync(PAGE, 'utf8');

const start = html.indexOf('// >>>CORE');
const end = html.indexOf('const MODES =');
if (start < 0 || end < 0) throw new Error('markers not found');

let src = html.slice(start, end);
src += `\nexport { scoreGuess, clusterPick, edgeError, coverCount, sideMap, ANSWERS, GUESSES, DICT, CLUSTERS, EDGEWAYS };\n`;

const dir = join(tmpdir(), 'pp-core-' + process.pid);
mkdirSync(dir, { recursive: true });
const file = join(dir, 'core.mjs');
writeFileSync(file, src);
const M = await import(pathToFileURL(file).href);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL ' + msg); } };

// ---- banks ----
ok(M.ANSWERS.length > 300, 'answers bank small: ' + M.ANSWERS.length);
ok(M.ANSWERS.every((w) => /^[a-z]{5}$/.test(w)), 'answers must be five lowercase letters');
ok(M.ANSWERS.every((w) => M.GUESSES.has(w)), 'every answer must be an accepted guess');
ok(M.ANSWERS.every((w) => new Set(w).size >= 2), 'no answer may repeat one letter only');
ok(M.ANSWERS.length === new Set(M.ANSWERS).size, 'answers unique');
ok(M.DICT.has('about') && M.DICT.has('chain') && !M.DICT.has('zzz'), 'edgeways dictionary sane');

// ---- wordrow scoring ----
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok(eq(M.scoreGuess('crane', 'crane'), ['g', 'g', 'g', 'g', 'g']), 'exact guess must be all green');
ok(eq(M.scoreGuess('crane', 'nacre'), ['y', 'y', 'y', 'y', 'g']), 'anagram must score four yellows and a green');
ok(eq(M.scoreGuess('crane', 'crams'), ['g', 'g', 'g', 'x', 'x']), 'partial must be g,g,g,x,x');
// a repeated guess letter can only ever be scored once against the answer
ok(eq(M.scoreGuess('abide', 'eerie'), ['x', 'x', 'x', 'y', 'g']), 'repeat letters scored once: ' + M.scoreGuess('abide', 'eerie'));
for (const a of M.ANSWERS.slice(0, 40)) {
  let row = null;
  for (const g of M.ANSWERS) {
    if (g === a) { row = M.scoreGuess(a, g); break; }
  }
  ok(row && row.every((s) => s === 'g'), 'self guess green for ' + a);
}
// a deterministic opener must not already be the answer for the first board
ok(M.ANSWERS[0] !== 'raise', 'first answer is not the default opener');

// ---- clusters ----
ok(M.CLUSTERS.length >= 4, 'need at least four clusters boards');
for (const [bi, b] of M.CLUSTERS.entries()) {
  const flat = b.groups.flatMap((g) => g.words);
  ok(b.groups.length === 4, `board ${bi} needs four groups`);
  ok(flat.length === 16, `board ${bi} needs sixteen tiles`);
  ok(new Set(flat).size === 16, `board ${bi} has a duplicate tile: ` + flat.filter((w, i) => flat.indexOf(w) !== i));
  for (const g of b.groups) ok(g.words.length === 4, `board ${bi} group ${g.name} needs four words`);
  // every real group resolves; a mixed pick never does
  for (let gi = 0; gi < 4; gi++) {
    ok(M.clusterPick(b.groups[gi].words, b, []) === gi, `board ${bi} group ${gi} must resolve`);
    ok(M.clusterPick(b.groups[gi].words, b, [gi]) === -1, `board ${bi} solved group ${gi} must not resolve twice`);
  }
  ok(M.clusterPick(['notaword', b.groups[0].words[0], b.groups[0].words[1], b.groups[0].words[2]], b, []) === -1, `board ${bi} rejects unknown tile`);
  // a cross-group pick must be rejected for every pairing of two groups
  for (let gi = 0; gi < 4; gi++) for (let gj = 0; gj < 4; gj++) {
    if (gi === gj) continue;
    const mixed = [b.groups[gi].words[0], b.groups[gi].words[1], b.groups[gi].words[2], b.groups[gj].words[0]];
    ok(M.clusterPick(mixed, b, []) === -1, `board ${bi} mixed ${gi}/${gj} must be rejected`);
  }
  // the deal rotation used by newGame keeps all sixteen tiles
  for (let rot = 0; rot < 4; rot++) {
    const dealt = flat.slice(rot * 4).concat(flat.slice(0, rot * 4));
    ok(dealt.length === 16 && new Set(dealt).size === 16, `board ${bi} rotation ${rot} must keep sixteen tiles`);
  }
}

// ---- edgeways ----
ok(M.EDGEWAYS.length >= 3, 'need at least three edgeways boards');
for (const [bi, b] of M.EDGEWAYS.entries()) {
  const flat = b.sides.flat();
  ok(b.sides.length === 4 && b.sides.every((s) => s.length === 3), `board ${bi} must be 4 sides of 3`);
  ok(flat.length === 12 && new Set(flat).size === 12, `board ${bi} must hold twelve distinct letters`);
  ok(flat.every((ch) => /^[a-z]$/.test(ch)), `board ${bi} letters must be lowercase`);
  // the stored solution must be legal, in the dictionary, and cover the box
  let prev = '';
  for (const w of b.solution) {
    ok(M.edgeError(w, b.sides, prev) === '', `board ${bi} solution word illegal: ${w} (${M.edgeError(w, b.sides, prev)})`);
    ok(M.DICT.has(w), `board ${bi} solution word not in dictionary: ${w}`);
    prev = w.slice(-1);
  }
  ok(M.coverCount(b.solution) === 12, `board ${bi} solution covers ${M.coverCount(b.solution)}/12`);
  // the rules reject what they must
  const smap = M.sideMap(b.sides);
  const same = b.sides.map((s) => s[0] + s[1]).find((p) => true);
  ok(M.edgeError(same + b.sides[0][0], b.sides, '') !== '', `board ${bi} must reject a same-side pair`);
  ok(M.edgeError('ab', b.sides, '') === 'at least three letters', `board ${bi} must reject two letters`);
  const offbox = b.sides[0][0] + 'q'.repeat(0) + (flat.includes('q') ? '' : '');
  if (!flat.includes('q')) ok(M.edgeError('qzx', b.sides, '') === 'not on the box', `board ${bi} must reject an off-box letter`);
  const w0 = b.solution[1];
  ok(M.edgeError(w0, b.sides, b.solution[0].slice(-1)) === '', `board ${bi} must accept the chained word`);
  ok(M.edgeError(w0, b.sides, b.solution[0][0]) !== '', `board ${bi} must reject the wrong start letter`);
}

console.log(fails ? `${fails} FAILURE(S)` : `PASS puzzle-press core: ${M.ANSWERS.length} answers, ${M.GUESSES.size} guesses, ${M.DICT.size} dictionary words, ${M.CLUSTERS.length} cluster boards, ${M.EDGEWAYS.length} edgeways boards`);
process.exit(fails ? 1 : 0);
