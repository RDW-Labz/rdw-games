#!/usr/bin/env node
// Proves the Dots and Boxes port's rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/dots-n-boxes/index.html.
// Checks the side-count/capture/turn rules, the double-cross, a full deterministic playout
// (every box owned, scores sum to the box count), and the CPU heuristic's legality.
//
// usage: node dots-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/Projects/rdw-games/shelf/games/arcade/dots-n-boxes/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m || !m[1].trim()) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { mkState, allEdges, isDrawn, boxesOf, sidesOf, freeEdges, drawEdge, winnerOf, cpuMove, rngOf };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { mkState, allEdges, isDrawn, boxesOf, sidesOf, freeEdges, drawEdge, winnerOf, cpuMove } = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };
const E = (S, id) => allEdges(S.dim).find((e) => e.id === id);

// --- a fresh board: nothing owned, nothing over ---
for (const dim of [3, 5, 6]) {
  const S = mkState(dim);
  console.log(`fresh ${dim}x${dim}: ${freeEdges(S).length} edges, ${dim * dim} boxes`);
  ok(freeEdges(S).length === 2 * dim * (dim + 1), `${dim}: wrong edge count`);
  ok(S.scores[0] === 0 && S.scores[1] === 0, `${dim}: scores start non-zero`);
  ok(!S.over, `${dim}: fresh board reads over`);
  ok(S.owner.flat().every((o) => o < 0), `${dim}: a box starts owned`);
}

// --- three sides do not capture; the fourth does, and the turn stays ---
{
  const S = mkState(3);
  const sides = ['h0-0', 'h1-0', 'v0-0', 'v0-1'];
  for (const id of sides.slice(0, 3)) drawEdge(S, E(S, id));
  ok(S.owner[0][0] === -1 && S.scores[0] + S.scores[1] === 0, 'three sides already captured the box');
  ok(S.turn === 1, 'turn did not pass after three plain edges');   // 3 edges, alternating
  const last = drawEdge(S, E(S, 'v0-1'));
  ok(last.ok && last.captured.length === 1, 'fourth side did not capture');
  ok(S.owner[0][0] === S.turn || S.owner[0][0] === 1, 'captured box has no owner');
  ok(S.scores[S.owner[0][0]] === 1, 'captured box not counted');
  const turnAfter = S.turn;
  drawEdge(S, E(S, 'h0-1'));
  ok(S.turn === 1 - turnAfter, 'a plain edge after a capture did not pass the turn');
}

// --- double-cross: one edge that closes two boxes captures both, in one turn ---
{
  const S = mkState(2);
  const all = ['h0-0', 'h1-0', 'v0-0', 'h0-1', 'h1-1', 'v0-2'];
  for (const id of all) drawEdge(S, E(S, id));
  const before = S.turn;
  const res = drawEdge(S, E(S, 'v0-1'));
  ok(res.captured.length === 2, 'double-cross did not capture two boxes, got ' + res.captured.length);
  ok(S.scores[before] === 2, 'double-cross did not credit both boxes');
  ok(S.turn === before, 'double-cross passed the turn');
  ok(S.owner[0][0] === before && S.owner[0][1] === before, 'double-cross owners wrong');
}

// --- a drawn edge cannot be redrawn ---
{
  const S = mkState(4);
  drawEdge(S, E(S, 'h2-2'));
  const again = drawEdge(S, E(S, 'h2-2'));
  ok(!again.ok, 'redrawing a drawn edge was accepted');
  ok(S.moves === 1, 'redraw bumped the move counter');
}

// --- the CPU never repeats an edge and always takes a free box ---
{
  const S = mkState(5);
  for (const id of ['h0-0', 'h1-0', 'v0-0']) drawEdge(S, E(S, id));
  const take = cpuMove(S);
  ok(take && take.id === 'v0-1', 'cpu did not take the free box, chose ' + (take && take.id));
  // filled board: no move
  const T = mkState(3);
  for (const e of allEdges(3)) drawEdge(T, e);
  ok(cpuMove(T) === null, 'cpu offered a move on a full board');
}

// --- a full deterministic playout finishes with every box owned ---
for (const dim of [3, 5, 6]) {
  const S = mkState(dim);
  let guard = 0;
  while (!S.over && guard++ < 4000) {
    const e = cpuMove(S);
    ok(!!e, `${dim}: cpu returned no move with ${freeEdges(S).length} free`);
    if (!e) break;
    ok(!isDrawn(S, e), `${dim}: cpu picked an already-drawn edge`);
    drawEdge(S, e);
  }
  ok(S.over, `${dim}: playout did not finish`);
  ok(freeEdges(S).length === 0, `${dim}: playout left free edges`);
  ok(S.owner.flat().every((o) => o >= 0), `${dim}: playout left an unclaimed box`);
  ok(S.scores[0] + S.scores[1] === dim * dim, `${dim}: scores ${S.scores} do not sum to ${dim * dim}`);
  ok(S.moves === 2 * dim * (dim + 1), `${dim}: move count ${S.moves} != edge count`);
  ok([-1, 0, 1].includes(winnerOf(S)), `${dim}: winnerOf returned junk`);
  console.log(`playout ${dim}x${dim}: ${S.scores[0]}-${S.scores[1]}, winner ${winnerOf(S)}`);
}

// --- the CPU must play a respectable game: a lone heuristic pilot beats a random edge picker ---
{
  const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const S = mkState(5);
  while (!S.over) {
    const free = freeEdges(S);
    const e = S.turn === 0 ? cpuMove(S) : free[(rnd() * free.length) | 0];
    drawEdge(S, e);
  }
  console.log(`heuristic vs random: ${S.scores[0]}-${S.scores[1]}`);
  ok(S.scores[0] > S.scores[1], 'the heuristic did not beat a random picker — cpu is too weak to lose against');
}

console.log(fails ? `FAILED ${fails}` : 'OK — rules, capture/turn handling, double-cross and full playouts all agree');
process.exit(fails ? 1 : 0);
