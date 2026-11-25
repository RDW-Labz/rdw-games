#!/usr/bin/env node
// Proves the Arrow Escape port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/arrow-escape-infinite-puzzle/index.html.
//
// Checks the four directions and their clear-path rule, empty/blocked/valid removals,
// that a deadlocked board really reads as deadlocked, and that every generated board
// comes with a removal order which clears it through the same removeArrow() the page
// calls — across sizes 4..7 and many seeds.
//
// usage: node escape-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/arrow-escape-infinite-puzzle/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { DIRS, DIR_KEYS, mulberry32, remaining, pathClear, removeArrow, unwind, makeLevel, sizeForLevel };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---------- 1) directions ----------
ok(C.DIR_KEYS.length === 4 && ['up', 'right', 'down', 'left'].every((k) => C.DIR_KEYS.includes(k)), 'four directions', C.DIR_KEYS);
ok(C.DIRS.up[1] === -1 && C.DIRS.down[1] === 1 && C.DIRS.left[0] === -1 && C.DIRS.right[0] === 1,
  'up is -y, down +y, left -x, right +x', C.DIRS);

// ---------- 2) the clear-path rule on hand boards ----------
const b1 = [['right'], [null]];                            // 1x2: right-hand arrow on a 1-wide board
ok(C.pathClear([['up']], 0, 0) === true, 'an arrow at the edge leaves immediately');
const b2 = [['right', null, null]];
ok(C.pathClear(b2, 0, 0) === true, 'an empty run to the edge is clear', b2);
const b3 = [['right', 'up', null]];
ok(C.pathClear(b3, 0, 0) === false, 'another arrow in the run blocks it', b3);
const b4 = [['up', 'right', null]];
ok(C.pathClear(b4, 1, 0) === true, 'a blocked cell only blocks its own line', b4);
ok(C.pathClear(b4, 0, 0) === true, 'an arrow in the top row leaves upwards', b4);
const b5 = [['right', 'left']];
ok(C.pathClear(b5, 0, 0) === false && C.pathClear(b5, 1, 0) === false, 'two arrows facing each other block both', b5);
ok(C.pathClear([[null]], 0, 0) === false, 'an empty cell has no direction', 'empty');

// ---------- 3) removals ----------
const g1 = [['right', null, null]];
const r0 = C.removeArrow(g1, 1, 0);
ok(r0.ok === false && r0.reason === 'empty', 'an empty cell cannot be removed', r0);
const g2 = [['right', 'up', null]];
const r1 = C.removeArrow(g2, 0, 0);
ok(r1.ok === false && r1.blocked === true && g2[0][0] === 'right', 'a blocked tap leaves the board untouched', r1);
const r2 = C.removeArrow(g2, 1, 0);
ok(r2.ok === true && r2.dir === 'up' && r2.left === 1 && g2[0][1] === null, 'a free arrow leaves and the count drops', r2);

// a deadlocked board: every edge arrow points inward, so the middle has no exit run
const dead = [['down', 'down', 'down'], ['right', 'down', 'left'], ['up', 'up', 'up']];
let any = false;
for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (C.pathClear(dead, x, y)) any = true;
ok(any === false, 'a fully inward board has no legal move', dead);
ok(C.remaining(dead) === 9, 'remaining() counts the board', C.remaining(dead));

// ---------- 4) every generated board is solvable ----------
let boards = 0, steps = 0;
for (let size = 4; size <= 7; size++) {
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = C.mulberry32(seed * 131 + size);
    const lv = C.makeLevel(rnd, size);
    boards++;
    ok(lv.size === size && lv.grid.length === size && lv.grid.every((r) => r.length === size), 'board is ' + size + 'x' + size, [seed, size]);
    ok(C.remaining(lv.grid) === size * size, 'board is full of arrows', { seed, size, left: C.remaining(lv.grid) });
    ok(lv.grid.every((r) => r.every((c) => C.DIR_KEYS.includes(c))), 'every cell has a legal direction', { seed, size });
    ok(lv.solution.length === size * size, 'solution removes every arrow', { seed, size, len: lv.solution.length, want: size * size });
    const seen = new Set(lv.solution.map(([x, y]) => x + ',' + y));
    ok(seen.size === lv.solution.length, 'solution never repeats a cell', { seed, size });
    // the first move must be legal on the board as dealt (no instant deadlock)
    const startFree = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (C.pathClear(lv.grid, x, y)) startFree.push([x, y]);
    ok(startFree.length >= 1, 'a dealt board always has a legal first move', { seed, size });
    // replay the recorded order through the same removeArrow the page uses
    const copy = lv.grid.map((r) => r.slice());
    let blockedAt = -1;
    for (let i = 0; i < lv.solution.length; i++) {
      const [x, y] = lv.solution[i];
      const res = C.removeArrow(copy, x, y);
      if (!res.ok) { blockedAt = i; break; }
      steps++;
    }
    ok(blockedAt === -1, 'the recorded order is playable move by move', { seed, size, blockedAt });
    ok(C.remaining(copy) === 0, 'replaying the order clears the board', { seed, size, left: C.remaining(copy) });
  }
}

// ---------- 5) sizing ----------
ok(C.sizeForLevel(1) === 4 && C.sizeForLevel(3) === 4, 'the first three levels are 4x4', [C.sizeForLevel(1), C.sizeForLevel(3)]);
ok(C.sizeForLevel(4) === 5 && C.sizeForLevel(7) === 6 && C.sizeForLevel(10) === 7, 'the board grows 5, 6, 7 with progress',
  [C.sizeForLevel(4), C.sizeForLevel(7), C.sizeForLevel(10)]);
ok(C.sizeForLevel(99) === 7 && C.sizeForLevel(0) === 4, 'size is clamped at both ends', [C.sizeForLevel(99), C.sizeForLevel(0)]);

console.log(JSON.stringify({ fails, file, boards, steps }));
console.log(fails ? 'CORE FAIL' : 'CORE PASS');
process.exit(fails ? 1 : 0);
