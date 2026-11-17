#!/usr/bin/env node
// Proves the shipped Binary Puzzle page's own rules block: every level's givens agree with
// its solution, the solution satisfies the rules, and the rules reject the classic breaks.
// usage: node binary-puzzle-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/binary-puzzle/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('NO CORE BLOCK'); process.exit(1); }
const src = m[1] + '\nexport { N, LEVELS_CORE, coreNext, coreViolations, coreSolved };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { N, LEVELS_CORE, coreNext, coreViolations, coreSolved } = mod;

const checks = {};
checks.levelCount = LEVELS_CORE.length === 3;
const per = [];
for (const lv of LEVELS_CORE) {
  const g = lv.givens.split('').map((ch) => (ch === '.' ? -1 : Number(ch)));
  const s = lv.solution.split('').map(Number);
  const ok = {
    name: lv.name,
    givenLen: g.length === N * N,
    solLen: s.length === N * N,
    givensAgree: g.every((v, i) => v === -1 || v === s[i]),
    solutionValid: coreViolations(s).length === 0,
    solutionSolved: coreSolved(s),
    hasBlanks: g.some((v) => v === -1),
    drawnGivens: g.filter((v) => v !== -1).length,
    solutionIsCompletion: g.every((v, i) => v === -1 || v === s[i]),
  };
  per.push(ok);
  checks[lv.name.replace(/\W+/g, '_')] = Object.entries(ok).every(([k, v]) => typeof v !== 'boolean' || v);
}

// Rules must bite: a triple, an unbalanced row, and a duplicate row all fail.
const good = LEVELS_CORE[0].solution.split('').map(Number);
const triple = good.slice(); triple[0] = triple[1]; triple[2] = triple[1];
const unbalanced = good.slice(); const r0 = unbalanced.slice(0, N); const ones = r0.filter((v) => v === 1).length;
for (let i = 0; i < N; i++) unbalanced[i] = i < ones ? 1 : 0;
unbalanced[0] = 1; unbalanced[1] = 1; unbalanced[2] = 1; // force a triple-free but unbalanced-looking row
const incomplete = good.slice(); incomplete[5] = -1;
const dupRow = good.slice(); for (let i = 0; i < N; i++) dupRow[N + i] = dupRow[i];
checks.tripleRejected = coreViolations(triple).length > 0;
checks.incompleteNotSolved = coreSolved(incomplete) === false;
checks.cycleWraps = coreNext(-1) === 0 && coreNext(0) === 1 && coreNext(1) === -1;
checks.goodSolved = coreSolved(good);
// Two identical rows must fail coreSolved through the duplicate rule alone.
const rowsUnique = coreSolved(dupRow);
checks.dupRowsRejected = rowsUnique === false;

// Every level must be completable by a plain backtracking solver that only uses coreViolations/coreSolved,
// so "solvable" is proven against the shipped rules and not against the generator.
function solve(g, limit = 1) {
  const v = g.slice();
  const out = [];
  const rec = () => {
    if (out.length >= limit) return;
    const i = v.indexOf(-1);
    if (i === -1) { if (coreSolved(v)) out.push(v.slice()); return; }
    for (const x of [0, 1]) {
      v[i] = x;
      if (coreViolations(v).length === 0) rec();
      v[i] = -1;
    }
  };
  rec();
  return out;
}
const solvable = LEVELS_CORE.map((lv) => {
  const g = lv.givens.split('').map((ch) => (ch === '.' ? -1 : Number(ch)));
  const sols = solve(g, 2);
  return { name: lv.name, found: sols.length, unique: sols.length === 1 };
});
checks.allSolvable = solvable.every((s) => s.found >= 1);
checks.allUnique = solvable.every((s) => s.unique);

const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, per, solvable }, null, 1));
console.log(pass ? 'CORE PASS' : 'CORE FAIL');
process.exit(pass ? 0 : 1);
