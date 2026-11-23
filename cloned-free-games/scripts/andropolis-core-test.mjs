#!/usr/bin/env node
// Core-rule test for the Andropolis port: slices the // >>>CORE block out of the SHIPPED
// index.html and runs it, so the rules proved here are the rules the browser runs.
// usage: node andropolis-core-test.mjs [site-root]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const HTML = readFileSync(resolve(ROOT, 'games/arcade/andropolis/index.html'), 'utf8');
const a = HTML.indexOf('// >>>CORE'), b = HTML.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) throw new Error('no CORE block');
const CORE = HTML.slice(a + '// >>>CORE'.length, b);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) { fails++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
  else console.log('ok   ' + name);
};
const near = (x, y, eps = 0.001) => Math.abs(x - y) <= eps;

const mod = await import('data:text/javascript,' + encodeURIComponent(
  CORE + '\nexport { mkState, build, step, totals, at, powered, roadBeside, KIND, COST, TOOL_KIND, MAXLVL, WIN_POP, START_FUNDS, resLevels, comLevels, indLevels };'
));
const { mkState, build, step, totals, at, powered, roadBeside, KIND, COST, MAXLVL, WIN_POP } = mod;

// ---- board basics
let S = mkState();
ok('board is 9x9', S.cells.length === 81 && S.n === 9);
ok('starts with funds and no buildings', S.funds === 6000 && S.funds === mod.START_FUNDS && S.built === 0);
ok('empty board is not a win', (() => { const t = totals(mkState()); return t.pop === 0 && t.pop < WIN_POP; })());

// ---- build: charges once, re-placing is a no-op, bulldoze costs
S = mkState();
ok('road charges the road price', build(S, 4, 4, 'road') === 'ok' && S.funds === 6000 - COST.road, 'funds=' + S.funds);
const afterFirst = S.funds;
ok('re-placing the same lot is idempotent and free', build(S, 4, 4, 'road') === 'same' && S.funds === afterFirst);
ok('out-of-board is refused', build(S, -1, 0, 'road') === 'empty');
ok('bulldoze clears and charges', build(S, 4, 4, 'clear') === 'ok' && at(S, 4, 4).kind === 0 && S.bulldozed === 1);
S.funds = 10;
ok('no funds -> refused, nothing placed, nothing charged', build(S, 2, 2, 'power') === 'cost' && at(S, 2, 2).kind === 0 && S.funds === 10);

// ---- power coverage
S = mkState();
build(S, 4, 4, 'power');
ok('lot next to the plant is powered', powered(S, 4, 6) === true);
ok('lot 3 away diagonally is powered', powered(S, 7, 7) === true);
ok('lot 4 away is not powered', powered(S, 4, 8) === false && powered(S, 0, 0) === false);
ok('a road beside the lot is detected', (() => { const T = mkState(); build(T, 2, 2, 'road'); return roadBeside(T, 2, 3) === true && roadBeside(T, 6, 6) === false; })());

// ---- growth needs power, demand and (indirectly) jobs
S = mkState();
build(S, 4, 4, 'power');
for (const c of [3, 4, 5]) build(S, 5, c, 'res');
ok('unemployed homes never grow (demandR <= 0)', (() => { const t = totals(S); return t.demandR <= 0; })() && step(S) && resTotal(S) === 0, 'levels=' + resTotal(S));

S = mkState();
build(S, 4, 4, 'power');
for (const c of [3, 4, 5]) build(S, 5, c, 'ind');
for (const c of [3, 4, 5]) build(S, 3, c, 'res');
step(S); step(S);
ok('industry grows jobs on the town\'s outside demand', totals(S).jobs > 0 && S.demandR > 0, 'jobs=' + S.jobs);
let grew = 0;
for (let i = 0; i < 4; i++) { step(S); grew = resTotal(S); }
ok('homes grow once industry creates the demand', grew > 0, 'levels=' + grew);

// ---- roads double growth; no power means no growth at all
function resTotal(T) { return T.cells.reduce((x, c) => x + (c.kind === KIND.res ? c.lvl : 0), 0); }
const growProbe = (withRoad, withPower) => {
  const T = mkState();
  if (withPower) build(T, 4, 4, 'power');
  if (withRoad) build(T, 6, 3, 'road');
  build(T, 6, 4, 'res');
  for (const c of [3, 4, 5]) build(T, 7, c, 'ind');
  for (let i = 0; i < 4; i++) step(T);
  return resTotal(T);
};
const gRoad = growProbe(true, true), gNoRoad = growProbe(false, true), gNoPower = growProbe(true, false);
ok('road-adjacent home grows at least as fast as the same home without a road', gRoad >= gNoRoad, `road=${gRoad} noroad=${gNoRoad}`);
ok('an unpowered home never grows', gNoPower === 0, 'levels=' + gNoPower);
// ---- budget: upkeep is charged, revenue arrives with people
S = mkState();
build(S, 4, 4, 'power');
const f0 = S.funds;
step(S);
ok('a plant alone costs upkeep (no revenue yet)', S.funds < f0, `${f0} -> ${S.funds}`);
S = mkState();
build(S, 2, 2, 'power'); build(S, 2, 6, 'power');
for (let c = 0; c < 9; c++) build(S, 3, c, 'road');
for (let r = 0; r <= 1; r++) for (let c = 0; c <= 2; c++) build(S, r, c, 'ind');
for (let r = 0; r <= 1; r++) for (let c = 6; c <= 8; c++) build(S, r, c, 'com');
for (let r = 4; r <= 5; r++) for (const c of [0, 1, 2, 3, 4, 6, 7, 8]) build(S, r, c, 'res');
const fundsBefore = S.funds;
for (let i = 0; i < 4; i++) step(S);
ok('a zoned, powered city earns revenue (funds rise after a few years)', S.pop > 0 && S.funds > fundsBefore, 'pop=' + S.pop + ' funds=' + fundsBefore + '->' + S.funds);

// ---- terminal states
S = mkState(); build(S, 0, 0, 'power'); S.funds = 5; step(S);
ok('treasury below zero loses', S.over === true && S.result === 'lose', 'funds=' + S.funds);
S = mkState();
for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) build(S, r, c, 'res');
build(S, 0, 0, 'power');
for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) at(S, r, c).lvl = 3;   // 9 homes x 3 levels x 4 = 108
totals(S);
ok('100 people wins', S.pop >= WIN_POP, 'pop=' + S.pop);
step(S);
ok('the winning tick sets over/win', S.over === true && S.result === 'win');
ok('a finished city refuses more building', build(S, 5, 5, 'road') === 'end');

// ---- full simulated play: a properly powered grid reaches the win through the rules alone
S = mkState();
build(S, 2, 2, 'power'); build(S, 2, 6, 'power');
for (let c = 0; c < 9; c++) build(S, 3, c, 'road');
for (let r = 0; r <= 1; r++) for (let c = 0; c <= 2; c++) build(S, r, c, 'ind');
for (let r = 0; r <= 1; r++) for (let c = 6; c <= 8; c++) build(S, r, c, 'com');
for (let r = 4; r <= 5; r++) for (const c of [0, 1, 2, 3, 4, 6, 7, 8]) build(S, r, c, 'res');
let guard = 0;
while (!S.over && guard++ < 40) step(S);
ok('a straightforward city reaches a terminal state', S.over === true, `t=${S.tick} pop=${S.pop} funds=${S.funds}`);
ok('the straightforward city wins', S.result === 'win', `result=${S.result} pop=${S.pop} funds=${S.funds}`);
ok('the win does not run the treasury dry', S.funds >= 0);
ok('max level is respected', S.cells.every((c) => c.lvl <= MAXLVL));

console.log(fails ? `\n${fails} FAILED` : '\nALL CORE CHECKS PASS');
process.exit(fails ? 1 : 0);
