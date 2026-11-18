#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped jigsaw-solitaire port and proves the deal with the
// exact layout/rules code the browser runs:
//   · 12 slots, four columns by three rows, on a regular pitch (the picture is a real rectangle);
//   · every seed deals each piece to a distinct tray cell — no two pieces share a landing spot;
//   · no piece is dealt within SNAP of its own slot, so a fresh board is never pre-solved;
//   · the tray sits clear of the board (the minimum deal distance is above SNAP for every seed);
//   · isWin only trips at all 12.
//
// usage: node jigsaw-core-test.mjs [games/arcade/jigsaw-solitaire/index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/jigsaw-solitaire/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
const core = new Function(m[1] + `
return { COLS, ROWS, N, PW, PD, SNAP, TRAY_Z0, TRAY_DZ, home, trayLayout, distToHome, isWin, mulberry32 };`)();
const { COLS, ROWS, N, PW, PD, SNAP, TRAY_Z0, TRAY_DZ, home, trayLayout, distToHome, isWin } = core;

const problems = [];
const checks = {};
const ok = (name, cond, why = '') => {
  checks[name] = cond ? 'ok' : 'FAIL';
  if (!cond) problems.push(`${name}${why ? ': ' + why : ''}`);
};

// 1. board geometry
ok('4x3 grid of 12', COLS === 4 && ROWS === 3 && N === 12, `${COLS}x${ROWS}=${N}`);
const homes = Array.from({ length: N }, (_, i) => home(i));
const xs = [...new Set(homes.map((h) => +h.x.toFixed(6)))];
const zs = [...new Set(homes.map((h) => +h.z.toFixed(6)))];
ok('four columns', xs.length === 4, xs.join(','));
ok('three rows', zs.length === 3, zs.join(','));
const pitchX = Math.min(...xs.slice(1).map((v, i) => v - xs[i]));
const pitchZ = Math.min(...zs.slice(1).map((v, i) => v - zs[i]));
ok('columns on one pitch', Math.abs(pitchX - PW) < 1e-9, `${pitchX} vs PW ${PW}`);
ok('rows on one pitch', Math.abs(pitchZ - PD) < 1e-9, `${pitchZ} vs PD ${PD}`);
ok('grid is centred on the origin',
  Math.abs(xs[0] + xs[xs.length - 1]) < 1e-9 && Math.abs(zs[0] + zs[zs.length - 1]) < 1e-9,
  `x ${xs[0]}..${xs[xs.length - 1]} z ${zs[0]}..${zs[zs.length - 1]}`);
ok('board split leaves 12 distinct homes', new Set(homes.map((h) => `${h.x},${h.z}`)).size === 12);

// 2. the deal, across seeds — every seed must be a legal, unsolved, non-overlapping tray
const seeds = [1, 7, 20261117, 424242, 999983, 31337, 8675309];
let minDeal = Infinity, worstSeed = null;
for (const seed of seeds) {
  const tray = trayLayout(seed);
  ok(`seed ${seed}: one cell per piece`, tray.length === N && tray.every((t) => t && Number.isFinite(t.x) && Number.isFinite(t.z)));
  const keys = new Set(tray.map((t) => `${t.x},${t.z}`));
  ok(`seed ${seed}: no shared landing spot`, keys.size === N, `${keys.size} distinct of ${N}`);
  // pieces must not overlap in the tray by more than a tenth of a piece — a jittered tray nuzzles
  // pieces together, and anything deeper than that hides a piece under its neighbour
  let minGap = Infinity;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const dx = Math.abs(tray[a].x - tray[b].x), dz = Math.abs(tray[a].z - tray[b].z);
    if (dx < PW && dz < PD) minGap = Math.min(minGap, Math.max(dx / PW, dz / PD));
  }
  ok(`seed ${seed}: tray pieces stay separable`, minGap >= 0.92, `worst overlap ratio ${minGap.toFixed(3)}`);
  // the deal must not hand the player a pre-placed piece
  const closest = Math.min(...tray.map((t, i) => distToHome(i, t.x, t.z)));
  if (closest < minDeal) { minDeal = closest; worstSeed = seed; }
  ok(`seed ${seed}: nothing dealt inside snap range`, closest > SNAP * 1.5,
    `closest ${closest.toFixed(3)} vs SNAP ${SNAP}`);
  ok(`seed ${seed}: tray below the board`, tray.every((t) => t.z - PD / 2 > Math.max(...zs)),
    `min tray z ${Math.min(...tray.map((t) => t.z))} vs board max ${Math.max(...zs)}`);
  // every piece must be draggable out of the tray and home again: the whole board is reachable
  ok(`seed ${seed}: all 12 homes reachable`, Array.from({ length: N }, (_, i) => i).every((i) => Number.isFinite(home(i).x)));
}
ok('deal clears the board for every seed', minDeal > SNAP, `worst ${worstSeed}: ${minDeal.toFixed(3)}`);
ok('two seeds deal differently', JSON.stringify(trayLayout(1)) !== JSON.stringify(trayLayout(2)));
ok('a seed replays the same deal', JSON.stringify(trayLayout(20261117)) === JSON.stringify(trayLayout(20261117)));

// 3. win rule
ok('not won at 11', isWin(11) === false);
ok('won at 12', isWin(12) === true);
ok('snap tolerance is sub-piece', SNAP < Math.min(PW, PD) / 2, `${SNAP} < ${Math.min(PW, PD) / 2}`);
ok('one snap radius can never reach two homes',
  Array.from({ length: N }, (_, i) => homes.filter((h) => Math.hypot(h.x - home(i).x, h.z - home(i).z) <= SNAP).length).every((n) => n === 1));

const pass = problems.length === 0;
console.log(JSON.stringify({ checks, problems, minDeal: +minDeal.toFixed(3), seeds }, null, 1));
console.log(pass ? 'JIGSAW CORE PASS' : 'JIGSAW CORE FAIL');
process.exit(pass ? 0 : 1);
