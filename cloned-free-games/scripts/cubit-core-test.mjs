#!/usr/bin/env node
// Proves the Cubit port's generated cubes with the exact rules code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced straight out of games/arcade/cubit/index.html.
//
// Per level: the generator produces the full arrow count, no cell holds two arrows, the pink
// arrow STARTS blocked (so it really has to be dug out), at least one arrow starts blocked (so
// a bump is reachable), the reverse placement order solves the whole face one free tap at a
// time, a blocked tap removes nothing, and generation is deterministic per seed.
//
// usage: node cubit-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/cubit/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { DIRS, mulberry32, inBoard, corridor, firstBlocker, pathClear, tapRes, genOnce, genLevel, solveOrder, LEVELS };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { tapRes, genLevel, solveOrder, pathClear, corridor, DIRS, LEVELS } = mod;

let fails = 0;
const ok = (cond, msg, extra) => { if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; return false; } console.log('  ok   ' + msg); return true; };

ok(LEVELS.length >= 3, 'three named cubes ship');
ok(LEVELS.every((l) => l.n >= 6 && l.count > 8 && l.seed), 'every cube has a size, a count and a seed');

for (let li = 0; li < LEVELS.length; li++) {
  const spec = LEVELS[li];
  const L = genLevel(spec.seed, spec.n, spec.count);
  console.log(`\ncube ${li + 1}: ${spec.n}x${spec.n}, wanted ${spec.count} arrows`);
  if (!ok(!!L, `cube ${li + 1} generates at all`, spec)) continue;

  ok(L.N === spec.n, 'board size matches the spec', { got: L.N });
  ok(L.order.length === spec.count, 'the generator placed exactly the arrow count', { got: L.order.length, want: spec.count });
  ok(L.count === L.order.length, 'recorded count matches the placement order');

  // no cell holds two arrows, and every placed arrow carries a real heading
  const cells = L.order.map(([r, c]) => r + ',' + c);
  ok(new Set(cells).size === cells.length, 'no cell was filled twice');
  ok(L.order.every(([r, c, d]) => d >= 0 && d < 4 && L.g[r * L.N + c] === d), 'every arrow sits where the order says');
  let filled = 0; for (const v of L.g) if (v >= 0) filled++;
  ok(filled === spec.count, 'the grid holds exactly the arrow count', { filled });

  // the pink arrow must start blocked: a free target would be a one-tap win
  const [pr, pc] = L.pink;
  ok(L.g[pr * L.N + pc] >= 0, 'pink sits on a live arrow', L.pink);
  ok(!pathClear(L.g, L.N, pr, pc, L.g[pr * L.N + pc]), 'pink STARTS blocked (not a free tap)', L.pink);
  const blockers = corridor(L.N, pr, pc, L.g[pr * L.N + pc]).filter(([r, c]) => L.g[r * L.N + c] >= 0);
  ok(blockers.length >= 1, 'pink has at least one arrow in its corridor', blockers);

  // some arrow must be blocked at the start, otherwise the bump rule is untestable
  let blocked = 0, free = 0;
  for (let r = 0; r < L.N; r++) for (let c = 0; c < L.N; c++) {
    if (L.g[r * L.N + c] < 0) continue;
    if (tapRes(L.g, L.N, r, c).kind === 'blocked') blocked++; else free++;
  }
  ok(blocked >= 2 && free >= 1, 'a fresh cube offers both free and blocked arrows', { blocked, free });

  // a blocked tap must remove nothing
  const g2 = Int8Array.from(L.g);
  let br = -1, bc = -1;
  for (let r = 0; r < L.N && br < 0; r++) for (let c = 0; c < L.N && br < 0; c++) {
    if (L.g[r * L.N + c] >= 0 && tapRes(L.g, L.N, r, c).kind === 'blocked') { br = r; bc = c; }
  }
  const res = tapRes(g2, L.N, br, bc);
  ok(res.kind === 'blocked' && res.blocker, 'a blocked arrow names its blocker', res);
  ok(g2[br * L.N + bc] >= 0, 'a blocked tap leaves the arrow on the face');
  ok(res.kind === 'blocked' && g2[res.blocker[0] * L.N + res.blocker[1]] >= 0, 'the named blocker is really occupied');

  // replay the reverse placement order: every step must be free, and the face must empty
  const g3 = Int8Array.from(L.g);
  const order = solveOrder(L);
  ok(order.length === spec.count, 'solve order covers every arrow', { got: order.length });
  let bad = 0, pinkAt = -1;
  order.forEach(([r, c], k) => {
    const t = tapRes(g3, L.N, r, c);
    if (t.kind !== 'free') { bad++; return; }
    g3[r * L.N + c] = -1;
    if (r === pr && c === pc) pinkAt = k;
  });
  ok(bad === 0, 'every step of the solve order is a free tap', { bad });
  ok(pinkAt >= 0, 'the solve order frees the pink arrow');
  ok(pinkAt >= Math.floor(order.length / 2), 'pink is buried in the second half of the reference solve', { pinkAt, total: order.length });
  ok(Array.from(g3).every((v) => v < 0), 'the reference solve empties the whole face (full clear reachable)');

  // a level must not be won by tapping empties
  const g4 = Int8Array.from(L.g);
  const emptyRes = tapRes(g4, L.N, 0, 0);
  ok(emptyRes.kind === 'empty' || L.g[0] >= 0, 'empty cells are no-ops', emptyRes);

  // determinism: the same seed must rebuild the same cube
  const again = genLevel(spec.seed, spec.n, spec.count);
  ok(JSON.stringify(again.order) === JSON.stringify(L.order) && again.pink.join() === L.pink.join(), 'same seed rebuilds the same cube');
}

console.log(fails ? `\nFAILED ${fails}` : '\nOK — every cube is solvable, has a buried pink arrow, and is policed by the shipped rules code');
process.exit(fails ? 1 : 0);
