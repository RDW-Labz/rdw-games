#!/usr/bin/env node
// Proves the Water Sort port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/water-sort/index.html.
//
// Checks pour legality and clamping, the win condition, that every shipped level is
// solvable (replaying the solver's own line through pour() reaches a win), that the
// deals are deterministic and carry exactly CAP of every colour, and that the move
// budget always leaves room for the optimal line.
//
// usage: node water-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/water-sort/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { CAP, LEVELS, mulberry32, mkLevel, topColour, topRun, uniform, pourOK, pour, won,
  solvedCount, stateKey, movesOf, solve, budgetFor, makeLevel };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---------- 1) pour legality ----------
const S1 = [[0, 0, 1, 1], [1, 2], [1], [], [2, 2, 2, 2]];
ok(C.pourOK(S1, 0, 1) === false, 'a mismatched top colour is refused', { a0: C.topColour(S1[0]), b1: C.topColour(S1[1]) });
ok(C.pourOK(S1, 0, 2) === true, 'a matching top colour is accepted');
ok(C.pourOK(S1, 0, 0) === false, 'a tube cannot pour into itself');
ok(C.pourOK(S1, 3, 0) === false, 'an empty source pours nothing');
ok(C.pourOK(S1, 0, 4) === false, 'a full destination is refused');
ok(C.pourOK(S1, 0, 3) === true, 'an empty destination is accepted');
ok(C.pourOK(S1, 4, 3) === true, 'a finished single-colour tube may still move (rules stay simple)');

// ---------- 2) pour clamping ----------
const S2 = [[0, 1, 1, 1], [1]];
const moved = C.pour(S2, 0, 1);
ok(moved === 3, 'pouring onto a matching top moved the whole run of 3', moved);
ok(JSON.stringify(S2[0]) === '[0]', 'the source kept its remaining colour', S2[0]);
ok(JSON.stringify(S2[1]) === '[1,1,1,1]', 'the destination filled to capacity', S2[1]);

const S3 = [[2, 2, 2], []];
const moved3 = C.pour(S3, 0, 1);
ok(moved3 === 3 && JSON.stringify(S3[1]) === '[2,2,2]', 'a whole run moves into an empty tube', { moved3, b: S3[1] });

const S4 = [[0, 0, 0, 0], [0, 0]];
ok(C.pour(S4, 0, 1) === 2, 'the pour is clamped to the destination space', C.pour([[...S4[0]], [...S4[1]]], 0, 1));
ok(C.topRun([1, 1, 0, 0]) === 2, 'topRun counts only the top colour', C.topRun([1, 1, 0, 0]));
ok(C.topRun([]) === 0, 'topRun of an empty tube is 0');

// ---------- 3) win / solved ----------
ok(C.won([[0, 0, 0, 0], [1, 1, 1, 1], []]) === true, 'sorted tubes with empties is a win');
ok(C.won([[], [], []]) === false, 'an empty board is not a win');
ok(C.won([[0, 0, 0, 0], [1, 1, 1]]) === false, 'a partial tube is not a win');
ok(C.solvedCount([[0, 0, 0, 0], [1, 1, 1, 1], [2, 2]]) === 2, 'solvedCount counts only full single-colour tubes');

// ---------- 4) deals ----------
for (let i = 0; i < C.LEVELS.length; i++) {
  const spec = C.LEVELS[i];
  const t0 = Date.now();
  const made = C.makeLevel(i);
  const ms = Date.now() - t0;
  ok(made.tubes.length === spec.colors + spec.extra, `level ${i + 1} has ${spec.colors}+${spec.extra} tubes`, made.tubes.length);
  const counts = {};
  for (const t of made.tubes) { ok(t.length <= C.CAP, `level ${i + 1} tube respects capacity`, t); for (const c of t) counts[c] = (counts[c] || 0) + 1; }
  for (let c = 0; c < spec.colors; c++) ok(counts[c] === C.CAP, `level ${i + 1} carries exactly ${C.CAP} units of colour ${c}`, counts[c]);
  ok(Object.keys(counts).length === spec.colors, `level ${i + 1} uses only its own colours`, Object.keys(counts));
  ok(made.opt >= spec.min, `level ${i + 1} takes at least ${spec.min} moves (opt ${made.opt})`, made.opt);
  ok(made.sol !== null, `level ${i + 1} is solvable`, { seed: made.seed });
  ok(ms < 4000, `level ${i + 1} generates in under 4s (${ms}ms)`, ms);

  // replay the solver's own line through the shipped rules
  if (made.sol) {
    const S = made.tubes.map((t) => t.slice());
    let bad = 0, steps = 0;
    for (const [a, b] of made.sol) { if (!C.pourOK(S, a, b)) { bad++; break; } C.pour(S, a, b); steps++; }
    ok(bad === 0, `level ${i + 1}: every solver move is legal under pourOK`, { bad, steps });
    ok(C.won(S), `level ${i + 1}: replaying the solved line wins`, { steps });
    ok(steps === made.opt, `level ${i + 1}: the line is exactly opt moves long`, { steps, opt: made.opt });
  }
  // determinism
  const again = C.makeLevel(i);
  ok(JSON.stringify(again.tubes) === JSON.stringify(made.tubes), `level ${i + 1} regenerates byte-identical`);
  // budget
  ok(C.budgetFor(made.opt) > made.opt, `level ${i + 1}: the move budget beats the optimal line`, C.budgetFor(made.opt));
  console.error(`  level ${i + 1}: ${spec.colors} colours, opt ${made.opt}, budget ${C.budgetFor(made.opt)}, seed ${made.seed}, ${ms}ms`);
}

// ---------- 5) solver sanity on a hand board ----------
const hand = [[0, 1, 1, 0], [1, 0, 0, 1], [], []];
const sol = C.solve(hand, 20000);
ok(sol !== null, 'a hand-made two-colour board is solvable', sol && sol.length);
if (sol) {
  const S = hand.map((t) => t.slice());
  for (const [a, b] of sol) C.pour(S, a, b);
  ok(C.won(S), 'the hand board solution actually wins');
}

// stateKey treats interchangeable tubes as identical
ok(C.stateKey([[0, 1], [2], []]) === C.stateKey([[2], [], [0, 1]]), 'stateKey ignores tube order');

if (fails) { console.error(`\nWATER CORE TEST FAILED (${fails})`); process.exit(1); }
console.log('WATER CORE TEST PASS');
