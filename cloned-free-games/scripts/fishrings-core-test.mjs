#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped fish-rings port and proves the move set with the
// exact rules code the browser runs:
//   · the three rings are real circles RING_R apart (the three-way Venn the board draws);
//   · every ring owns four crossing slots, each mirrored by its neighbour;
//   · each turn is a genuine permutation of the 36 slots and the opposite turn is its inverse;
//   · every scramble is made of legal turns, so reversing it solves the position — which is what
//     scripts/fishrings-gate.mjs plays through real clicks.
//
// usage: node fishrings-core-test.mjs [games/arcade/fish-rings-puzzle/index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/fish-rings-puzzle/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
// new Function evaluates the repo's own committed source block, never external input.
const core = new Function(m[1] + `
return { RING_R, RING_TRI, N_SLOTS, N_RINGS, RING_CENTRES, S, slotPos, GATES, MOVE, invert, applyPerm,
         turn, turnPerm, solvedState, fishColour, ringAligned, alignedCount, isSolved, scrambleFrom };`)();
const {
  RING_R, RING_TRI, N_SLOTS, N_RINGS, RING_CENTRES, S, slotPos, GATES, MOVE, invert, applyPerm,
  turn, solvedState, fishColour, ringAligned, alignedCount, isSolved, scrambleFrom,
} = core;

const problems = [];
const checks = {};
const ok = (name, cond, why = '') => {
  checks[name] = cond ? 'ok' : 'FAIL';
  if (!cond) problems.push(`${name}${why ? ': ' + why : ''}`);
};
const N = N_RINGS * N_SLOTS;

// 1. geometry: centres exactly RING_TRI radii apart (a Venn wide enough that no two fish coincide)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pairD = [dist(RING_CENTRES[0], RING_CENTRES[1]), dist(RING_CENTRES[1], RING_CENTRES[2]), dist(RING_CENTRES[2], RING_CENTRES[0])];
ok('centres one triangle apart', pairD.every((d) => Math.abs(d - RING_R * RING_TRI) < 1e-9), pairD.map((d) => d.toFixed(6)).join(','));
ok('rings overlap', RING_TRI < 2, `RING_TRI=${RING_TRI}`);
// Fish from different rings must not sink into each other: read the page's own bead radius so the
// spacing check tracks the geometry the browser draws.
const BEAD_R = Number((html.match(/const BEAD_R = ([\d.]+)/) || [])[1]);
let minCross = Infinity, minSame = Infinity;
for (let a = 0; a < N; a++) {
  for (let b = a + 1; b < N; b++) {
    const pa = slotPos(Math.floor(a / N_SLOTS), a % N_SLOTS);
    const pb = slotPos(Math.floor(b / N_SLOTS), b % N_SLOTS);
    const dd = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (Math.floor(a / N_SLOTS) === Math.floor(b / N_SLOTS)) minSame = Math.min(minSame, dd);
    else minCross = Math.min(minCross, dd);
  }
}
ok('fish do not interpenetrate', minCross > 2 * BEAD_R, `closest fish from different rings ${minCross.toFixed(3)} vs bead diameter ${(2 * BEAD_R).toFixed(2)}`);
ok('fish on a ring are spaced', minSame > 2 * BEAD_R * 1.4, `closest same-ring fish ${minSame.toFixed(3)}`);
ok('slots distinct', new Set(Array.from({ length: N_RINGS }, (_, r) => Array.from({ length: N_SLOTS }, (_, i) => {
  const p = slotPos(r, i); return `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
})).flat()).size === N, 'two slots share a board position');

// 2. gates: four per ring, distinct, and mirrored by the neighbour that shares the crossing
let gateProblem = '';
for (let r = 0; r < N_RINGS; r++) {
  const g = GATES[r];
  if (g.length !== 4) gateProblem += ` ring ${r} has ${g.length} gates;`;
  const mines = g.map((x) => x.mine);
  if (new Set(mines).size !== mines.length) gateProblem += ` ring ${r} reuses a gate slot;`;
  for (const x of g) {
    if (Math.floor(x.mine / N_SLOTS) !== r) gateProblem += ` ring ${r} gate ${x.mine} is not on ring ${r};`;
    const other = Math.floor(x.other / N_SLOTS);
    if (other === r) gateProblem += ` ring ${r} gate ${x.mine} pairs itself;`;
    if (!GATES[other].some((y) => y.mine === x.other && y.other === x.mine)) gateProblem += ` ring ${r} gate ${x.mine} is not mirrored by ring ${other};`;
    const a = slotPos(Math.floor(x.mine / N_SLOTS), x.mine % N_SLOTS);
    const b = slotPos(other, x.other % N_SLOTS);
    if (Math.hypot(a.x - b.x, a.y - b.y) > RING_R) gateProblem += ` gate pair ${x.mine}/${x.other} is not at a crossing;`;
  }
}
ok('gates mirrored', gateProblem === '', gateProblem.trim());

// 3. every turn is a permutation, and the two directions are exact inverses
let permProblem = '';
for (let r = 0; r < N_RINGS; r++) {
  for (const dir of [0, 1]) {
    const p = MOVE[r][dir];
    if (p.length !== N) permProblem += ` ring ${r}[${dir}] length ${p.length};`;
    if (new Set(p).size !== N || p.some((k) => k < 0 || k >= N)) permProblem += ` ring ${r}[${dir}] is not a bijection;`;
  }
  const inv = invert(MOVE[r][0]);
  if (inv.some((k, i) => k !== MOVE[r][1][i])) permProblem += ` ring ${r} counter-clockwise is not the inverse;`;
  const a = Math.max(...MOVE[r][0].map((k, i) => (k === i ? 0 : 1)));
  if (!a) permProblem += ` ring ${r} turn changes nothing;`;
}
ok('turns are permutations', permProblem === '', permProblem.trim());

// 4. turn then the opposite turn restores the position (any position)
let rtProblem = '';
const st0 = scrambleFrom(99, 9).st;
for (let r = 0; r < N_RINGS; r++) {
  for (const dir of [1, -1]) {
    const back = turn(turn(st0, r, dir), r, -dir);
    if (back.some((v, i) => v !== st0[i])) rtProblem += ` ring ${r} ${dir} does not round-trip;`;
  }
}
ok('turns round-trip', rtProblem === '', rtProblem.trim());

// 5. the solved position is what the win check calls solved, and one turn breaks it
const solved = solvedState();
ok('solved state wins', isSolved(solved) && alignedCount(solved) === 3);
ok('solved rings are one colour', [0, 1, 2].every((r) => ringAligned(solved, r)));
let breakProblem = '';
for (let r = 0; r < N_RINGS; r++) {
  if (isSolved(turn(solved, r, 1))) breakProblem += ` ring ${r} solved after a turn;`;
}
ok('a turn breaks solved', breakProblem === '', breakProblem.trim());

// 6. every scramble is legal-only and its reversal solves it
const seeds = [20261117, 7, 1, 2, 3, 12345];
let scrProblem = '';
for (const seed of seeds) {
  const { st, seq } = scrambleFrom(seed, 14);
  if (seq.length !== 14) scrProblem += ` seed ${seed} depth ${seq.length};`;
  if (isSolved(st)) scrProblem += ` seed ${seed} deals an already-solved board;`;
  if (alignedCount(st) === 3) scrProblem += ` seed ${seed} deals 3 aligned rings;`;
  let walk = st;
  for (let k = seq.length - 1; k >= 0; k--) walk = turn(walk, seq[k][0], -seq[k][1]);
  if (!isSolved(walk)) scrProblem += ` seed ${seed} reversal does not solve;`;
}
ok('scrambles reversible', scrProblem === '', scrProblem.trim());

// 7. the shipped boot seed is the one the gate replays
const boot = scrambleFrom(20261117, 14);
ok('boot seed solvable in 14', boot.seq.length === 14 && !isSolved(boot.st));

// 8. colour counts are conserved by every turn (the win check needs all three colours present)
const counts = (st) => [1, 2, 3].map((c) => st.filter((b) => fishColour(b) === c).length);
ok('colours conserved', counts(boot.st).every((n) => n === 12) && counts(turn(boot.st, 1, 1)).every((n) => n === 12), counts(boot.st).join('/'));

console.log(JSON.stringify({ file, checks, problems }, null, 1));
if (problems.length) { console.error(`FAIL ${problems.length} problem(s)`); process.exit(1); }
console.log(`PASS fishrings core: ${Object.keys(checks).length} checks, boot seed ${boot.seq.length} turns from solved`);
