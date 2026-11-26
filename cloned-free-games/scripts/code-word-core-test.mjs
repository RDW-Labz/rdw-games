// Core test for the Code Word port: slices the CORE block out of the shipped page and checks the
// scoring rules a guesser lives or dies by — duplicate letters, greens first, amber pools, key
// colours, deterministic daily words, and a word list that is really five letters long.
//
//   node scripts/code-word-core-test.mjs
import { readFileSync } from 'node:fs';

const PAGE = '/home/cluer/kaos/work/site/games/arcade/code-word/index.html';
const html = readFileSync(PAGE, 'utf8');
const m = html.match(/\/\* >>>CORE_START \*\/([\s\S]*?)\/\* >>>CORE_END \*\//);
if (!m) { console.error('FAIL: CORE markers not found'); process.exit(1); }

// The page's own CORE block is first-party source from this repo; evaluating it here is the point.
const api = new Function(m[1] + `
  return { WORDS, feedback, isWin, keyStates, isWord, pickWord, dayNumber, letterCount };
`)();
const { WORDS } = api;

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`PASS  ${msg}`);
  else { console.log(`FAIL  ${msg}${extra ? ' — ' + extra : ''}`); fails++; }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log(`page: ${PAGE}`);
ok(WORDS.length >= 800, `word list baked (${WORDS.length})`);
ok(WORDS.every((w) => w.length === 5 && /^[a-z]+$/.test(w)), 'every answer is five lowercase letters');
ok(new Set(WORDS).size === WORDS.length, 'no duplicate answers');
ok(WORDS.includes('crane') || WORDS.includes('slate'), 'list holds ordinary words', WORDS.slice(0, 5).join(','));

// greens, then ambers drawn from the leftover pool
ok(eq(api.feedback('crane', 'crane'), ['g', 'g', 'g', 'g', 'g']), 'exact match is all green', JSON.stringify(api.feedback('crane', 'crane')));
ok(eq(api.feedback('aaaaa', 'crane'), ['x', 'x', 'g', 'x', 'x']), 'one a, one green, no spare ambers', JSON.stringify(api.feedback('aaaaa', 'crane')));
// duplicate-letter edge cases, the classic scorer bugs
ok(eq(api.feedback('allee', 'eagle'), ['y', 'y', 'x', 'y', 'g']), 'allee vs eagle = y y x y g', JSON.stringify(api.feedback('allee', 'eagle')));
ok(eq(api.feedback('sassy', 'basis'), ['y', 'g', 'g', 'x', 'x']), 'sassy vs basis = y g g x x', JSON.stringify(api.feedback('sassy', 'basis')));
ok(eq(api.feedback('eerie', 'there'), ['y', 'x', 'y', 'x', 'g']), 'eerie vs there = y x y x g', JSON.stringify(api.feedback('eerie', 'there')));
ok(eq(api.feedback('abbey', 'kebab'), ['y', 'y', 'g', 'y', 'x']), 'abbey vs kebab = y y g y x', JSON.stringify(api.feedback('abbey', 'kebab')));

ok(api.isWin(['g', 'g', 'g', 'g', 'g']), 'isWin accepts all green');
ok(!api.isWin(['g', 'g', 'g', 'g', 'y']), 'isWin rejects one amber');

// key colours keep the best state a letter has earned
const ks = api.keyStates('crane', ['slate', 'crimp']);
ok(ks.a === 'g' && ks.r === 'g' && ks.s === 'x' && ks.e === 'g', 'key states keep the best result per letter', JSON.stringify(ks));

ok(api.isWord('crane', new Set(WORDS)) === true && api.isWord('zzzzz', new Set(WORDS)) === false, 'isWord filters by the list');
ok(api.pickWord(7) === api.pickWord(7) && WORDS.includes(api.pickWord(7)), 'pickWord is deterministic and in-list');
ok(api.pickWord(0) !== api.pickWord(1), 'different days pick different words');
ok(api.dayNumber(new Date('2026-11-25T12:00:00Z')) === Math.floor(Date.UTC(2026, 10, 25) / 86400000), 'dayNumber is UTC-day based');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
