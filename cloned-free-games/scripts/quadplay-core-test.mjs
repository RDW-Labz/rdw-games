#!/usr/bin/env node
// Rules test for the Quadplay · HexFlipper port. Slices the // >>>CORE block straight out of the
// shipped games/arcade/quadplay/index.html and plays it headless, so what is proven here is what
// the browser runs. No DOM, no three.js — only the pure rules.
//
// usage: node quadplay-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = resolve(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/quadplay/index.html');
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE\r?\n([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no // >>>CORE block in ' + FILE); process.exit(2); }
// The only string handed to Function() is the CORE block sliced out of the checked-in port file
// above — a repo source file, never user or network input. That is what lets this test prove the
// rules the browser actually ships instead of a duplicate copy that can drift.
const CORE = m[1];
const names = ['mulberry32', 'makeBoard', 'hexScores', 'genMove', 'makeHex', 'hexFlips', 'hexVerdict',
  'commitHex', 'cpuHexPick', 'AXIAL_DIRS', 'BOARD_ROWS', 'START_HEX', 'NEUTRAL'];
const { makeBoard, hexScores, makeHex, hexFlips, hexVerdict, commitHex, cpuHexPick, START_HEX, NEUTRAL } =
  new Function(`${CORE}\nreturn { ${names.join(', ')} };`)();

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) return true;
  fails++;
  console.log('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const T = (msg) => console.log('     ' + msg);
const dirs = (m) => { let n = 0; for (let i = 0; i < 6; i++) if (m & (1 << i)) n++; return n; };
const supers = (m) => { let n = 0; for (let i = 6; i < 12; i++) if (m & (1 << i)) n++; return n; };

console.log('== the comb ==');
const B = makeBoard();
ok(B.cells.length === 61, 'the comb carries quadplay\'s 61 hexes', B.cells.length);
const symBad = [];
for (let i = 0; i < B.cells.length; i++) {
  for (let d = 0; d < 6; d++) {
    const j = B.nb[i][d];
    if (j < 0) continue;
    if (B.nb[j].indexOf(i) < 0) symBad.push([i, d]);
    else if ((B.nb[j].indexOf(i) + 3) % 6 !== d) symBad.push([i, d, 'not opposite']);
  }
}
ok(symBad.length === 0, 'every neighbour link is mutual and opposite', symBad.slice(0, 4));
ok(B.nb.every((r) => r.length >= 2 && r.length <= 6), 'every hex has 2..6 neighbours');
ok(B.nb.filter((r) => r.length === 6).length > 20, 'the interior is properly six-connected');
ok(B.idx.get('9:1') !== undefined && B.idx.get('5:1') !== undefined, 'both start hexes are on the comb', START_HEX);
ok(new Set(B.cells.map((c) => c.q + ':' + c.r)).size === 61, 'no duplicate cells');
const rows = {};
for (const c of B.cells) rows[c.r] = (rows[c.r] || 0) + 1;
ok(JSON.stringify(Object.values(rows)) === JSON.stringify([5, 6, 7, 8, 9, 8, 7, 6, 5]),
  'the comb is 5-6-7-8-9-8-7-6-5 hexes per row', Object.values(rows));
// a radius-4 hexagon: one centre cell, six cells at each ring, 1+6+12+18+24 = 61
const ring = {};
for (const c of B.cells) {
  const x = c.q - 5, z = c.r - 5, y = -x - z;
  const d = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  ring[d] = (ring[d] || 0) + 1;
}
ok(JSON.stringify(ring) === JSON.stringify({ 0: 1, 1: 6, 2: 12, 3: 18, 4: 24 }),
  'the comb is a regular hexagon: 1 + 6 + 12 + 18 + 24 cells round the centre', ring);
ok(B.nb[B.idx.get('5:5')].every((j) => j >= 0), 'the centre cell joins all six neighbours');

console.log('== the turn ==');
const H = makeHex(7);
ok(H.scores[0] === 1 && H.scores[1] === 1 && H.scores[2] === 59, 'a fresh comb starts 1 / 1 / 59', H.scores);
ok(dirs(H.cur[0]) >= 1 && dirs(H.cur[0]) <= 6 && dirs(H.cur[1]) >= 1, 'each side is handed 1-6 arrows', [H.cur[0], H.cur[1]]);
ok(supers(H.cur[0]) <= 1 && supers(H.cur[1]) <= 1, 'at most one super arrow per hand');
let hands = 0, useful = 0, wide = 0;
for (let seed = 1; seed <= 200; seed++) {
  const S = makeHex(seed);
  for (let p = 0; p < 2; p++) {
    hands++;
    if (dirs(S.cur[p]) >= 4) wide++;
    let can = 0;
    for (let i = 0; i < S.owner.length; i++) {
      if (S.owner[i] === p && hexFlips(S, i, S.cur[p]).flips > 0) can++;
    }
    if (can) useful++;
  }
}
ok(useful === hands, 'every hand can flip something for the side that holds it', { hands, useful });
T(`${hands} hands: ${wide} of them four arrows or wider`);

// a directional fixture: one owned hex, everything else neutral
const mid = B.idx.get('3:5');
const dirE = 1;   // the game's order: NE, E, SE, SW, W, NW
const fix = makeHex(3);
fix.owner.fill(NEUTRAL);
fix.owner[mid] = 0;
fix.scores = hexScores(B, fix.owner);
const one = hexFlips(fix, mid, 1 << dirE);
ok(one.flips === 1 && one.cells.length === 1, 'a single E arrow claims the hex east of the origin', one);
ok(fix.owner[one.cells[0]] === NEUTRAL, 'previewing a shot never mutates the comb');
const two = hexFlips(fix, mid, (1 << dirE) | (1 << 0));
ok(two.flips === 2, 'two arrows claim two neighbours', two.flips);

// super arrows steal, plain arrows bounce
const enemy = makeHex(3);
enemy.owner.fill(NEUTRAL);
enemy.owner[mid] = 0;
enemy.owner[B.nb[mid][dirE]] = 1;
enemy.owner[B.idx.get('3:3')] = 1;          // keep them alive so the commit is not a wipe-out
enemy.scores = hexScores(B, enemy.owner);
ok(hexFlips(enemy, mid, 1 << dirE).flips === 0, 'a plain arrow bounces off enemy ground');
const superShot = hexFlips(enemy, mid, (1 << dirE) | (1 << (dirE + 6)));
ok(superShot.flips === 1 && superShot.steals === 1, 'the super arrow takes their hex', superShot);
const pre = enemy.scores.slice();
const done = commitHex(enemy, mid, (1 << dirE) | (1 << (dirE + 6)));
ok(done.ok === true, 'the commit lands');
ok(enemy.owner[B.nb[mid][dirE]] === 0, 'the stolen hex changes hands', enemy.owner[B.nb[mid][dirE]]);
ok(enemy.scores[0] === pre[0] + 1 && enemy.scores[1] === pre[1] - 1, 'a steal moves one each way', { pre, after: enemy.scores });
ok(enemy.turn === 1, 'the turn passes after a commit', enemy.turn);

// an illegal commit must not touch the comb
const illegal = makeHex(3);
illegal.owner.fill(NEUTRAL);
illegal.owner[mid] = 0;
illegal.owner[B.idx.get('3:3')] = 1;
illegal.scores = hexScores(B, illegal.owner);
const snap = JSON.stringify([illegal.scores, Array.from(illegal.owner), illegal.turn]);
const refused = commitHex(illegal, B.idx.get('7:5'), 0b111111111111);
ok(refused.ok === false, 'firing from a hex you do not hold is refused', refused);
ok(JSON.stringify([illegal.scores, Array.from(illegal.owner), illegal.turn]) === snap, 'a refused shot leaves the comb untouched');
ok(commitHex(illegal, -1, 1).ok === false, 'firing from nowhere is refused');

console.log('== the verdict ==');
const mk = (mine, theirs, rest = NEUTRAL) => {
  const S = makeHex(1);
  S.owner.fill(rest);
  mine.forEach((i) => { S.owner[i] = 0; });
  theirs.forEach((i) => { S.owner[i] = 1; });
  S.scores = hexScores(B, S.owner);
  return S;
};
ok(hexVerdict(mk([0], [1])) === null, 'both sides hold ground and neutral remains: play on');
ok(hexVerdict(mk([0], [])) === 'win', 'taking their last hex wins with neutral ground left on the comb');
ok(hexVerdict(mk([], [0])) === 'lose', 'losing your last hex loses the comb');
ok(hexVerdict(mk([0, 1], [])) === 'win', 'a wipe-out is a win, not a draw');
const full = Array.from({ length: 61 }, (_, i) => i);
ok(hexVerdict(mk(full.slice(0, 40), full.slice(40))) === 'win', 'a full comb with a majority wins');
ok(hexVerdict(mk(full.slice(0, 20), full.slice(20))) === 'lose', 'a full comb with a minority loses');
ok(hexVerdict(mk(full.slice(0, 30), full.slice(30, 60), NEUTRAL)) === null, 'a full comb minus one hex still plays on');
const tie = makeHex(1);
tie.owner.fill(0);
for (let i = 0; i < 31; i++) tie.owner[i] = 1;
tie.owner[60] = NEUTRAL;
tie.scores = hexScores(B, tie.owner);
ok(hexVerdict(tie) === null, 'a level board that is not yet full plays on', tie.scores);

console.log('== the cpu ==');
// give the cpu a hand that wipes the visitor out in one shot and see it take the shot
const wipe = makeHex(5);
wipe.turn = 1;
wipe.owner.fill(NEUTRAL);
const doomed = B.idx.get('3:5');
wipe.owner[doomed] = 0;
for (let i = 0; i < wipe.owner.length; i++) if (i !== doomed) wipe.owner[i] = 1;
wipe.scores = hexScores(B, wipe.owner);
wipe.cur[1] = (1 << dirE) | (1 << (dirE + 6));   // the hex west of the doomed one steals it
const shotFrom = B.idx.get('2:5');
const pick = cpuHexPick(wipe);
ok(pick >= 0 && wipe.owner[pick] === 1, 'the cpu picks one of its own hexes', pick);
const sim = hexFlips(wipe, pick, wipe.cur[1]);
ok(sim.steals >= 1, 'with a wipe-out available the cpu takes the stealing shot', { pick, shotFrom, sim });
commitHex(wipe, pick, wipe.cur[1]);
ok(wipe.over === true && wipe.result === 'lose', 'and it ends the match — as a loss for the visitor', { over: wipe.over, result: wipe.result });

// two cpus play every seed to a verdict
let ended = 0, winsA = 0, draws = 0, longest = 0, plies = [];
for (let seed = 1; seed <= 200; seed++) {
  const S = makeHex(seed);
  let n = 0;
  while (!S.over && n < 400) {
    const i = cpuHexPick(S);
    if (i < 0) break;
    commitHex(S, i, S.cur[S.turn]);
    n++;
  }
  if (!S.over) continue;
  ended++;
  plies.push(S.plies);
  longest = Math.max(longest, S.plies);
  if (S.result === 'win') winsA++;
  if (S.result === 'draw') draws++;
}
plies.sort((a, b) => a - b);
ok(ended === 200, 'every seed settles', { ended, of: 200 });
ok(longest <= 120, 'no match drags past 120 plies', longest);
T(`cpu v cpu: median ${plies[100]} plies, longest ${longest}, first seat wins ${winsA}/200, draws ${draws}`);
ok(winsA >= 20 && winsA <= 180, 'neither seat is rigged to win', winsA);
ok(draws <= 40, 'draws stay rare', draws);

console.log('== the visitor ==');
// an idle visitor always fires from the first hex it owns
function playVisitor(seed, policy) {
  const S = makeHex(seed);
  let n = 0;
  while (!S.over && n < 400) {
    if (S.turn === 0) {
      const owned = [];
      for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === 0) owned.push(i);
      if (!owned.length) break;
      let pickI = owned[0];
      if (policy === 'greedy') {
        let bestF = -1, bestS = -1;
        for (const i of owned) {
          const f = hexFlips(S, i, S.cur[0]);
          if (f.flips > bestF || (f.flips === bestF && f.steals > bestS)) { pickI = i; bestF = f.flips; bestS = f.steals; }
        }
      }
      commitHex(S, pickI, S.cur[0]);
    } else {
      const i = cpuHexPick(S);
      if (i < 0) break;
      commitHex(S, i, S.cur[1]);
    }
    n++;
  }
  return S;
}
let idleLose = 0, idleWin = 0, greedyWin = 0, greedyLose = 0, greedyStuck = 0;
for (let seed = 1; seed <= 100; seed++) {
  const a = playVisitor(seed, 'idle');
  if (a.result === 'lose') idleLose++;
  if (a.result === 'win') idleWin++;
  const b = playVisitor(seed, 'greedy');
  if (b.result === 'win') greedyWin++;
  else if (b.result === 'lose') greedyLose++;
  else greedyStuck++;
}
T(`idle visitor loses ${idleLose}/100, wins ${idleWin}/100`);
T(`a visitor who always fires its best shot wins ${greedyWin}/100, loses ${greedyLose}, unsettled ${greedyStuck}`);
ok(idleLose >= 80, 'an idle visitor loses at least 80 of 100', idleLose);
ok(idleWin <= 3, 'an idle visitor does not inherit wins', idleWin);
// The point is that the arrows, not the seat, decide it: a visitor who reads its hand and fires its
// best shot sits near an even match, while an idle one never wins. Both bounds matter — a walkover
// would mean the game was rigged for one seat, which is worse than a hard game.
ok(greedyWin >= 30 && greedyWin <= 70, 'the visitor\'s choices decide the match, near an even split', greedyWin);
ok(greedyWin - idleWin >= 30, 'reading the hand beats not reading it by a wide margin', { greedyWin, idleWin });
ok(greedyStuck === 0, 'every visitor match settles', greedyStuck);
// the two seats are mirrored corners of the comb, so neither side starts with more room
const n0 = B.nb[B.idx.get(START_HEX[0][0] + ':' + START_HEX[0][1])].filter((j) => j >= 0).length;
const n1 = B.nb[B.idx.get(START_HEX[1][0] + ':' + START_HEX[1][1])].filter((j) => j >= 0).length;
ok(n0 === n1, 'both seats start on a corner with the same number of neighbours', { n0, n1 });

console.log('');
console.log(fails === 0
  ? `PASS — quadplay core test (${checks} checks)`
  : `FAIL — ${fails} of ${checks} checks failed`);
process.exit(fails === 0 ? 0 : 1);
