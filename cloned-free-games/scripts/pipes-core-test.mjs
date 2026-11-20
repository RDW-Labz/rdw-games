#!/usr/bin/env node
// Core test for the Pipes port: slices the // >>>CORE block out of the shipped HTML and runs
// it in node, so the level set is proven against the exact code the browser executes.
// usage: node scripts/pipes-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = resolve(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/pipes-water-flow-puzzle/index.html');
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + FILE); process.exit(1); }
const src = m[1] + `
export { LEVELS, mkState, seedRot, turn, wetMap, wetOutlets, isWon, planTaps, neededTaps, eff, at, idx };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LEVELS, mkState, seedRot, turn, wetMap, wetOutlets, isWon, planTaps, neededTaps, at, idx } = mod;

const checks = {};
const detail = [];
const applyPlan = (st) => {
  const plan = planTaps(st);
  for (let i = 0; i < plan.length; i++) {
    const x = st.cs[i];
    for (let k = 0; k < plan[i]; k++) turn(st, x.r, x.c);
  }
  return st;
};

for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  const solved = applyPlan(seedRot(mkState(L), L.seed));
  const start = seedRot(mkState(L), L.seed);
  const need = neededTaps(start);
  const budget = need + (L.budgetSlack || 8);
  const startWet = wetOutlets(start);
  // every drain must be fed once the plan is applied
  const solvedWet = wetOutlets(solved);
  // the spout itself carries water
  const s0 = at(solved, solved.source[0], solved.source[1]);
  const sourceWet = wetMap(solved)[idx(solved, s0.r, s0.c)];
  // and one wrong quarter-turn on the spout's own outlet path must cost the win
  const broken = applyPlan(seedRot(mkState(L), L.seed));
  let brokeCount = 0;
  for (const x of broken.cs) {
    if (x.wall) continue;
    turn(broken, x.r, x.c);
    if (!isWon(broken)) brokeCount++;
    turn(broken, x.r, x.c); turn(broken, x.r, x.c); turn(broken, x.r, x.c);
  }
  const key = 'lvl' + (i + 1);
  checks[key + 'Solvable'] = isWon(solved) && solvedWet === L.outlets.length;
  checks[key + 'StartsUnsolved'] = !isWon(start) && startWet < L.outlets.length;
  checks[key + 'Deterministic'] = JSON.stringify(seedRot(mkState(L), L.seed).cs.map((c) => c.rot)) ===
    JSON.stringify(seedRot(mkState(L), L.seed).cs.map((c) => c.rot));
  checks[key + 'Budget'] = need > 0 && budget > need;
  checks[key + 'HasFirstMove'] = start.cs.some((x) => !x.wall) && need >= start.cs.filter((x) => !x.wall).length;
  checks[key + 'SpoutWet'] = sourceWet === true;
  checks[key + 'WrongTurnCosts'] = brokeCount >= Math.max(1, Math.floor(broken.cs.filter((x) => !x.wall).length / 2));
  detail.push({
    key, name: L.name, size: `${start.w}x${start.h}`, open: start.cs.filter((x) => !x.wall).length,
    needed: need, budget, startWet, outlets: L.outlets.length, wrongTurnsThatBreak: brokeCount,
  });
}

const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ file: FILE, checks, failures: bad, levels: detail }, null, 1));
console.log(bad.length ? 'CORE FAIL' : 'CORE PASS');
process.exit(bad.length ? 1 : 0);
