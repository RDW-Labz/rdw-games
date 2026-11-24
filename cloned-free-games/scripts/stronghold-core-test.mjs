#!/usr/bin/env node
// Stronghold Protocol core test — slices the // >>>CORE block out of the shipped page and
// runs the exact rules the browser runs. Proves the roster/economy rules, the deploy zone,
// the combat accounting (shots, kills, leaks, wall), and that the fourteen-wave run is
// neither free (a passive hold loses) nor unwinnable (a drafting player wins).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = join(process.env.HOME, 'kaos/work/site/games/arcade/stronghold-protocol/index.html');
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('FAIL: no CORE block'); process.exit(1); }
const core = html.slice(a + '// >>>CORE'.length, b);

const dir = mkdtempSync(join(tmpdir(), 'stronghold-core-'));
const mod = join(dir, 'core.mjs');
writeFileSync(mod, core + `
export { COLS, ROWS, DEPLOY_FROM, WALL_HP, START_GOLD, SHOP_SIZE, REROLL_COST, BENCH_CAP, WAVES_TOTAL,
  BOARD_CAP, UNITS, FOES, WAVES, inBoard, canDeploy, rnd, newState, rollShop, boardCap, unitAt,
  buy, reroll, deploy, recall, moveUnit, upgrade, startWave, cheb, pickTarget, step, finishWave, autoDraft };
`);
const C = await import(pathToFileURL(mod).href);

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

// ---- 1. board shape and wave table ----
ok(C.COLS === 7 && C.ROWS === 5, 'a 7x5 field', { COLS: C.COLS, ROWS: C.ROWS });
ok(C.DEPLOY_FROM === 2, 'the back three rows are yours');
ok(C.canDeploy(0, 2) && C.canDeploy(6, 4), 'both corners of the deploy zone are legal');
ok(!C.canDeploy(0, 1) && !C.canDeploy(7, 4), 'the enemy rows and off-board cells are refused');
ok(C.WAVES.length === C.WAVES_TOTAL && C.WAVES_TOTAL === 14, 'fourteen waves', C.WAVES.length);
ok(C.WAVES.every(w => w.length && w.every(g => g.n > 0 && C.FOES[g.k])), 'every wave names real foes in positive counts');
ok(C.WAVES[13].some(g => g.k === 'warlord'), 'the last wave brings the warlord');
ok(Object.keys(C.UNITS).length === 5, 'five draftable unit kinds', Object.keys(C.UNITS));

// ---- 2. drafting economy ----
let S = C.newState(1234);
const shopA = C.rollShop(S);
const S2 = C.newState(1234); const shopB = C.rollShop(S2);
ok(JSON.stringify(shopA) === JSON.stringify(shopB), 'the shop roll is deterministic per seed', { shopA, shopB });
ok(shopA.length === C.SHOP_SIZE && shopA.every(k => C.UNITS[k]), 'three real offers', shopA);
ok(S.gold === C.START_GOLD, 'boot gold is the start purse', S.gold);
const kind0 = S.shop[0], cost0 = C.UNITS[kind0].cost;
ok(C.buy(S, 0) === true && S.gold === C.START_GOLD - cost0 && S.bench.length === 1, 'buying charges the shop price into the bench', { gold: S.gold, bench: S.bench });
ok(S.shop[0] === null && C.buy(S, 0) === 'empty', 'a sold slot cannot be bought twice');
S.gold = 0;
ok(C.buy(S, 1) === 'no gold', 'an empty purse refuses the buy');
S.gold = 500;
S.bench = []; for (let i = 0; i < C.BENCH_CAP; i++) S.bench.push({ kind: 'archer', lvl: 1 });
ok(C.buy(S, 1) === 'bench full', 'the bench is capped');

// ---- 3. deploy / move / recall / upgrade ----
S = C.newState(9); S.gold = 40; C.rollShop(S);
S.bench = [{ kind: 'archer', lvl: 1 }, { kind: 'guard', lvl: 1 }];
ok(C.deploy(S, 0, 1, 1) === 'not your ground', 'a foe row is not a deploy cell');
ok(C.deploy(S, 0, 0, 2) === true && S.units.length === 1 && S.bench.length === 1, 'deploy lands the unit in the zone', S.units);
ok(C.deploy(S, 0, 0, 2) === 'occupied', 'a cell holds one unit');
ok(C.deploy(S, 0, 1, 2) === true, 'the guard deploys beside it');
const cap = C.boardCap(S);
ok(typeof cap === 'number' && cap >= 3, 'the roster has a cap', cap);
const hpFull = C.UNITS.archer.hp;
S.units[0].hp = 3;
ok(C.recall(S, 0, 2) === true && S.bench.some(u => u.kind === 'archer'), 'recall sends a unit back to the bench');
ok(S.units.length === 1, 'recall empties the cell');
ok(C.moveUnit(S, { c: 1, r: 2 }, 2, 3) === true && C.unitAt(S, 2, 3), 'a placed unit moves inside the zone');
ok(C.upgrade(S, 2, 3) === true, 'upgrade a placed unit');
ok(C.unitAt(S, 2, 3).lvl === 2 && Math.round(C.unitAt(S, 2, 3).hp) > C.UNITS.guard.hp, 'upgrade raises level and hit points', C.unitAt(S, 2, 3));
ok(C.upgrade(S, 2, 3) === true && C.unitAt(S, 2, 3).lvl === 3, 'second upgrade reaches level three');
ok(C.upgrade(S, 2, 3) === 'maxed', 'level three is the ceiling');

// ---- 4. combat accounting ----
// two archers behind a guard against a single raider: every shot lands, the raider never reaches the wall
S = C.newState(77);
S.units = [
  { kind: 'guard', lvl: 1, col: 3, row: 4, hp: C.UNITS.guard.hp, cd: 0 },
  { kind: 'archer', lvl: 1, col: 2, row: 3, hp: C.UNITS.archer.hp, cd: 0 },
  { kind: 'archer', lvl: 1, col: 4, row: 3, hp: C.UNITS.archer.hp, cd: 0 },
];
S.foes = [{ id: 1, kind: 'raider', col: 3, row: -1, t: 0, hp: C.FOES.raider.hp, maxHp: C.FOES.raider.hp, cd: 0.5, slowT: 0 }];
S.phase = 'battle';
let guard = 0;
while (S.foes.length && guard++ < 2000 && !S.over) C.step(S, 1 / 60, null);
ok(S.foes.length === 0 && S.kills === 1, 'the firing line kills the raider', { kills: S.kills, shots: S.shots, wall: S.wall });
ok(S.wall === C.WALL_HP, 'nothing leaked', S.wall);
ok(S.shots > 0, 'shots were fired', S.shots);

// a lone raider with no defenders leaks exactly its leak value
S = C.newState(78);
S.foes = [{ id: 1, kind: 'brute', col: 0, row: 3, t: 0, hp: C.FOES.brute.hp, maxHp: C.FOES.brute.hp, cd: 0.5, slowT: 0 }];
S.phase = 'battle';
guard = 0;
while (S.foes.length && guard++ < 2000 && !S.over) C.step(S, 1 / 60, null);
ok(S.wall === C.WALL_HP - C.FOES.brute.leak && S.leaks === 1, 'an unopposed brute leaks its damage off the wall', { wall: S.wall, leaks: S.leaks });

// a wall already at the brute's damage goes down
S = C.newState(79); S.wall = C.FOES.brute.leak;
S.foes = [{ id: 1, kind: 'brute', col: 0, row: 3, t: 0, hp: C.FOES.brute.hp, maxHp: C.FOES.brute.hp, cd: 0.5, slowT: 0 }];
S.phase = 'battle';
guard = 0;
while (!S.over && guard++ < 2000) C.step(S, 1 / 60, null);
ok(S.over === true && S.result === 'lose', 'the last hit on the wall ends the run in a loss', { over: S.over, result: S.result });

// an enemy in front of a guard fights the guard, not the wall
S = C.newState(80);
S.units = [{ kind: 'guard', lvl: 1, col: 3, row: 4, hp: C.UNITS.guard.hp, cd: 0 }];
S.foes = [{ id: 1, kind: 'raider', col: 3, row: 3, t: 0, hp: C.FOES.raider.hp, maxHp: C.FOES.raider.hp, cd: 0.5, slowT: 0 }];
S.phase = 'battle';
for (let i = 0; i < 60; i++) C.step(S, 1 / 60, null);
ok(S.wall === C.WALL_HP && S.units[0].hp < C.UNITS.guard.hp, 'a blocked raider chews the guard instead of the wall', { wall: S.wall, guardHp: S.units[0].hp, leaks: S.leaks });

// slow: a frost hit halves the foe's march
S = C.newState(81);
S.foes = [{ id: 1, kind: 'raider', col: 0, row: -1, t: 0, hp: C.FOES.raider.hp, maxHp: C.FOES.raider.hp, cd: 0.5, slowT: 0 }];
S.phase = 'battle';
S.units = [{ kind: 'frost', lvl: 1, col: 0, row: 2, hp: C.UNITS.frost.hp, cd: 0 }];
let rowAt = 0;
for (let i = 0; i < 120; i++) { C.step(S, 1 / 60, null); rowAt = S.foes[0] ? S.foes[0].row : 99; if (S.foes[0] && S.foes[0].slowT > 0) break; }
ok(S.foes.length === 1 && S.foes[0].slowT > 0, 'a frost hit chills the foe', S.foes[0] && S.foes[0].slowT);

// ---- 5. the run: passive loses, drafting wins ----
const playRun = (policy, seed) => {
  const st = C.newState(seed);
  C.rollShop(st);
  let guardN = 0;
  while (!st.over && guardN++ < 40) {
    if (st.phase !== 'prep') break;
    policy(st);
    if (C.startWave(st) !== true) break;
    let s2 = 0;
    while (st.phase === 'battle' && !st.over && s2++ < 20000) C.step(st, 1 / 60, null);
    if (st.phase === 'battle') break;   // a wave that never resolves
  }
  return st;
};
const passive = playRun(() => {}, 4242);
ok(passive.over && passive.result === 'lose', 'an undefended hold loses', { result: passive.result, wave: passive.wave + 1, wall: passive.wall });

const draft = (st) => {
  // a drafter rerolls a shop with nothing worth its purse, then spends it
  for (let rr = 0; rr < 2; rr++) {
    const useful = st.shop.filter(x => x && C.UNITS[x].cost <= st.gold).length;
    if (useful === 0 && st.gold >= 4) C.reroll(st); else break;
  }
  C.autoDraft(st);
  if (st.units.length >= C.boardCap(st)) {
    for (let k = 0; k < 6; k++) {
      const u = st.units.filter(x => x.lvl < 3).sort((p, q) => C.UNITS[p.kind].cost * p.lvl - C.UNITS[q.kind].cost * q.lvl)[0];
      if (!u) break;
      if (C.upgrade(st, u.col, u.row) !== true) break;
    }
  }
};
const winners = [];
for (const seed of [4242, 7, 99, 12345, 555]) {
  const r = playRun(draft, seed);
  winners.push({ seed, result: r.result, wave: r.wave + 1, wall: r.wall, kills: r.kills });
}
ok(winners.every(w => w.result === 'win'), 'a drafting player breaks all fourteen waves', winners);

// ---- 6. determinism ----
const r1 = playRun(draft, 31337), r2 = playRun(draft, 31337);
ok(r1.result === r2.result && r1.kills === r2.kills && r1.wall === r2.wall && r1.wave === r2.wave,
  'the same seed plays out identically', [{ a: r1.result, k: r1.kills }, { a: r2.result, k: r2.kills }]);

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(JSON.stringify(winners, null, 1)); process.exit(1); }
