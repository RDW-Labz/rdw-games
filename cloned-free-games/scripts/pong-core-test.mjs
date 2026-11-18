#!/usr/bin/env node
// Core test for the King Pong port: slices the // >>>CORE block out of the SHIPPED page and
// checks the maths the browser runs — the wall fold, the meeting-point projection and the
// league ladder — so a hand-edited level table cannot ship a broken campaign.
// usage: node pong-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/king-pong/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('CORE FAIL: no >>>CORE block in ' + FILE); process.exit(1); }

const dir = await mkdtemp(join(tmpdir(), 'pong-core-'));
const mod = join(dir, 'core.mjs');
await writeFile(mod, m[1] + '\nexport { HALF_X, COURT, PLAYER_Z, CPU_Z, BALL_R, LEVELS, BIAS, fold, meetX };\n');
const C = await import(mod);

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

// 1. the fold reflects off both walls and stays inside the court
let foldBad = 0, reflectBad = 0;
for (let u = -40; u <= 40; u += 0.137) {
  const x = C.fold(u);
  if (Math.abs(x) > C.HALF_X + 1e-9) foldBad++;
}
for (let k = -6; k <= 6; k++) {
  const wall = (2 * k + 1) * C.HALF_X;                // odd multiples of HALF_X are the walls
  if (Math.abs(Math.abs(C.fold(wall)) - C.HALF_X) > 1e-6) reflectBad++;
}
ok('fold stays inside the court', foldBad === 0, `${foldBad} escapes`);
ok('fold hits both walls exactly', reflectBad === 0, `${reflectBad} misses`);
ok('fold(0) is centre', Math.abs(C.fold(0)) < 1e-9, C.fold(0));
ok('fold is odd around the centre', Math.abs(C.fold(3.2) + C.fold(-3.2)) < 1e-9, `${C.fold(3.2)} vs ${C.fold(-3.2)}`);

// 2. meetX only predicts for a ball heading at that row, and always lands inside the court
const cases = [
  { x: 0, vx: 3, z: 0, vz: -8, row: C.CPU_Z },
  { x: 4, vx: 5, z: 1, vz: -9, row: C.CPU_Z },
  { x: -4.5, vx: -6, z: -2, vz: 10, row: C.PLAYER_Z },
];
let meetBad = 0;
for (const c of cases) {
  const x = C.meetX(c.x, c.vx, c.z, c.vz, c.row);
  if (!Number.isFinite(x) || Math.abs(x) > C.HALF_X + 1e-9) meetBad++;
}
ok('meetX lands inside the court', meetBad === 0, `${meetBad} off-court`);
ok('meetX ignores a ball heading away', C.meetX(2, 3, 0, 8, C.CPU_Z) === 2, C.meetX(2, 3, 0, 8, C.CPU_Z));
// straight shot down a clear lane must be an exact hit
ok('meetX straight lane', Math.abs(C.meetX(1, 0, 0, -8, C.CPU_Z) - 1) < 1e-9, C.meetX(1, 0, 0, -8, C.CPU_Z));

// 3. the league ladder: five leagues, monotone difficulty, sane sizes
const L = C.LEVELS;
ok('five leagues', L.length === 5, L.length);
let mono = true;
for (let i = 1; i < L.length; i++) {
  if (!(L[i].cpu > L[i - 1].cpu)) mono = false;              // cpu paddle gets quicker
  if (!(L[i].width <= L[i - 1].width)) mono = false;         // player paddle gets narrower
  if (!(L[i].err <= L[i - 1].err)) mono = false;             // cpu aim gets tighter
  if (!(L[i].speed >= L[i - 1].speed)) mono = false;         // ball gets faster
}
ok('difficulty is monotone across the ladder', mono, JSON.stringify(L.map((l) => [l.cpu, l.err, l.speed, l.width])));
ok('every league is short enough to finish', L.every((l) => l.toWin >= 2 && l.toWin <= 7), L.map((l) => l.toWin).join(','));
ok('paddle always fits inside the court', L.every((l) => l.width > 0 && l.width <= C.HALF_X), L.map((l) => l.width).join(','));
ok('cpu can always reach the ball line', L.every((l) => l.cpu > 2), L.map((l) => l.cpu).join(','));
ok('ball starts slower than the cpu tier 1 can chase', L[0].speed > L[0].cpu * 0.8, `${L[0].speed} vs ${L[0].cpu}`);
ok('court geometry is sane', C.COURT > C.PLAYER_Z && C.COURT > -C.CPU_Z && C.BALL_R < 0.5,
  `${C.COURT} ${C.PLAYER_Z} ${C.CPU_Z} ${C.BALL_R}`);

// 4. the early leagues must be winnable by a player who returns every ball: a rally bias bigger
//    than the cpu paddle half-width plus the ball radius means the cpu physically cannot reach it.
const maxBias = Math.max(...C.BIAS.map(Math.abs));
const unbeatable = C.LEVELS.slice(0, 2).filter((l) => l.err * maxBias <= (l.width * 0.92) / 2 + C.BALL_R);
ok('a perfect returner can take the first two leagues', unbeatable.length === 0,
  `maxBias ${maxBias} -> ${C.LEVELS.map((l) => (l.err * maxBias).toFixed(2)).join(',')} vs reach ${C.LEVELS.map((l) => ((l.width * 0.92) / 2 + C.BALL_R).toFixed(2)).join(',')}`);
ok('bias table is varied (no constant drift)', new Set(C.BIAS.map((x) => Math.sign(x))).size === 2, C.BIAS.join(','));

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name} (${c.detail})`);
console.log(failed.length ? 'CORE FAIL' : 'CORE PASS');
process.exit(failed.length ? 1 : 0);
