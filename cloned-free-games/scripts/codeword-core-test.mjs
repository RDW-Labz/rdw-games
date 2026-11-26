// Core test for the Code-Word port: slices the CORE block out of the shipped page and proves
// the baked data is a real codeword — every run a word from the shipped list, numbers a correct
// bijection, the givens consistent, the win rule true on the answer and false on rubbish, the
// dead-end checker silent on the answer, and a solver that finds at least one fill (reporting
// how many the givens leave, because the page accepts any real fill).
//
//   node scripts/codeword-core-test.mjs
import { readFileSync } from 'node:fs';

const PAGE = '/home/cluer/kaos/work/site/games/arcade/codeword/index.html';
const html = readFileSync(PAGE, 'utf8');
const m = html.match(/\/\* >>>CORE_START \*\/([\s\S]*?)\/\* >>>CORE_END \*\//);
if (!m) { console.error('FAIL: CORE markers not found in page'); process.exit(1); }
const core = m[1];

// The page's own CORE block is first-party source read from this repo; evaluating it here is the
// point of the test (it exercises exactly the code that ships), so new Function on it is intended.
const api = new Function(core + `
  return { PUZZLES, DICT, numbering, runsOf, wordRuns, runPattern, runPossible, indexWords,
           deadCells, isSolved, assignLetter, cellNumbers, filledCount, solveUnique, wordAt };
`)();

const { PUZZLES, DICT } = api;
const BYLEN = api.indexWords(DICT);
const DICTSET = new Set(DICT);

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`PASS  ${msg}`);
  else { console.log(`FAIL  ${msg}${extra ? ' — ' + extra : ''}`); fails++; }
};

console.log(`page: ${PAGE}`);
console.log(`dictionary: ${DICT.length} words, ${[...BYLEN.entries()].map(([k, v]) => k + ':' + v.length).join(' ')}`);
ok(PUZZLES.length >= 1, `puzzles baked (${PUZZLES.length})`);
ok(DICT.length > 4000, 'word list is substantial');

const solutionMap = (puz) => {
  const map = new Map();
  for (const ch of Object.keys(puz.numbers)) map.set(puz.numbers[ch], ch);
  return map;
};

for (let i = 0; i < PUZZLES.length; i++) {
  const puz = PUZZLES[i];
  const tag = `puzzle ${i + 1}`;
  const runs = api.wordRuns(puz);
  const letters = Object.keys(puz.numbers);
  const cells = puz.solution.join('').split('').filter((ch) => ch !== '.' && ch !== '#').length;

  ok(puz.rows.length === 9 && puz.rows.every((r) => r.length === 9), `${tag}: 9x9 pattern`);
  ok(puz.solution.length === 9 && puz.solution.every((r) => r.length === 9), `${tag}: 9x9 answer`);

  // numbers are a bijection 1..K and match first-appearance numbering of the answer
  const derived = api.numbering(puz.solution);
  const sameNum = Object.keys(derived).length === letters.length
    && letters.every((ch) => derived[ch] === puz.numbers[ch]);
  const vals = Object.values(puz.numbers).sort((a, b) => a - b);
  ok(sameNum, `${tag}: numbering matches first appearance`, `${JSON.stringify(puz.numbers)} vs ${JSON.stringify(derived)}`);
  ok(vals.every((v, k) => v === k + 1), `${tag}: numbers run 1..${letters.length}`);

  // every run of 2+ cells spells a dictionary word, and those words are the ones the baker recorded
  const across = runs.filter((r) => r.dir === 'a').map((r) => api.wordAt(puz.solution, r));
  const down = runs.filter((r) => r.dir === 'd').map((r) => api.wordAt(puz.solution, r));
  const words = [...across, ...down];
  const nonWord = words.filter((w) => !DICTSET.has(w));
  ok(nonWord.length === 0, `${tag}: all ${words.length} runs are dictionary words`, nonWord.join(','));
  ok(words.length === (puz.words || words.length), `${tag}: word count recorded (${words.length})`);
  ok((puz.across || across).join('|') === across.join('|') && (puz.down || down).join('|') === down.join('|'),
    `${tag}: stored word lists match the grid`);

  // givens are honest: each revealed letter is the letter that number really holds
  const givensOk = puz.givens.every(([n, l]) => letters.includes(l) && puz.numbers[l] === n);
  ok(givensOk, `${tag}: givens consistent (${puz.givens.map(([n, l]) => n + '=' + l).join(' ')})`);

  // the win rule accepts the baked answer and rejects a Caesar-shifted one
  const answer = solutionMap(puz);
  ok(api.isSolved(puz, answer, BYLEN), `${tag}: win rule accepts the baked answer`);
  const shifted = new Map([...answer].map(([n, l]) => [n, String.fromCharCode(((l.charCodeAt(0) - 97 + 1) % 26) + 97)]));
  ok(!api.isSolved(puz, shifted, BYLEN), `${tag}: win rule rejects a shifted alphabet`);
  const partial = new Map(answer);
  partial.delete(puz.numbers[letters[0]]);
  ok(!api.isSolved(puz, partial, BYLEN), `${tag}: win rule rejects an incomplete fill`);

  // the dead-end checker is silent on the answer and shouts at a poisoned letter
  ok(api.deadCells(puz, answer, BYLEN).length === 0, `${tag}: checker finds no dead end in the answer`);
  const spare = 'qxzjv'.split('').find((c) => !letters.includes(c));
  const poisoned = new Map(answer);
  const bigNum = Object.entries(puz.numbers).sort((a, b) => b[1] - a[1])[0][1];
  poisoned.set(bigNum, spare);
  const dead = api.deadCells(puz, poisoned, BYLEN);
  ok(dead.length > 0, `${tag}: checker flags a run broken by ${spare}`, String(dead.length));

  // a solver over the shipped list finds at least one fill consistent with the givens
  const t0 = Date.now();
  const res = api.solveUnique(puz, DICT, { limit: 2, budget: 200000 });
  const ms = Date.now() - t0;
  ok(res.solutions >= 1, `${tag}: solver finds a fill (${res.solutions}${res.aborted ? '+' : ''} sol, ${res.nodes} nodes, ${ms}ms)`);
  if (res.first) {
    const solMap = new Map(res.first);
    const obey = puz.givens.every(([n, l]) => solMap.get(n) === l);
    ok(obey, `${tag}: solver fill honours the givens`);
    ok(api.isSolved(puz, solMap, BYLEN), `${tag}: solver fill passes the win rule`);
  }
  console.log(`      letters=${letters.length} cells=${cells} words=${words.length} sols=${res.solutions}${res.aborted ? '+' : ''}`);
}

// swap semantics: typing a letter another number owns swaps the two
{
  const map = new Map([[1, 'a'], [2, 'b']]);
  const swapped = api.assignLetter(map, 2, 'a');
  ok(swapped.get(2) === 'a' && swapped.get(1) === 'b', 'assignLetter swaps when the letter is taken');
  const cleared = api.assignLetter(swapped, 2, null);
  ok(!cleared.has(2) && cleared.get(1) === 'b', 'assignLetter clears one number only');
  const fresh = api.assignLetter(new Map(), 5, 'q');
  ok(fresh.get(5) === 'q', 'assignLetter assigns a free letter');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
