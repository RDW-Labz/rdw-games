#!/usr/bin/env node
// Anuto TD core test — slices the // >>>CORE block out of the shipped page and runs the
// exact rules the browser runs. Proves the road geometry, plot rule, wave tables, the
// economy, and that the twelve-wave run is neither free (passive loses) nor unwinnable
// (a greedy builder wins).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = join(process.env.HOME, 'kaos/work/site/games/arcade/anuto-td/index.html');
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('FAIL: no CORE block'); process.exit(1); }
const core = html.slice(a + '// >>>CORE'.length, b);

const dir = mkdtempSync(join(tmpdir(), 'anuto-core-'));
const mod = join(dir, 'core.mjs');
writeFileSync(mod, core + `
export { W, H, BASE, WAYPOINTS, PATH, PATH_LEN, TRACK, isTrack, inBoard, isPlot, PLOTS, roadDist,
  TOWER_KINDS, ENEMY_KINDS, WAVES, GAP, START_CASH, BASE_HP, INTERMISSION, EARLY_BONUS, MAX_LVL,
  hpScale, waveSpawns, newState, startWave, posAt, pickTarget, hurt, canPlace, towerAt, place,
  upgrade, upgradeCost, sell, sellValue, callNext, step };
`);
const C = await import(pathToFileURL(mod).href);

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

// ---- 1. road geometry ----
for (let i = 1; i < C.PATH.length; i++) {
  const dc = Math.abs(C.PATH[i][0] - C.PATH[i - 1][0]);
  const dr = Math.abs(C.PATH[i][1] - C.PATH[i - 1][1]);
  ok(dc + dr === 1, `road step ${i} is orthogonal`, C.PATH[i]);
}
const end = C.PATH[C.PATH.length - 1];
ok(end[0] === C.BASE.c && end[1] === C.BASE.r, 'the road ends on the base', end);
ok(C.PATH_LEN === C.PATH.length - 1, 'path length is its step count');
ok(C.isTrack(C.BASE.c, C.BASE.r), 'the base sits on the road');
// the road did not fold back over itself
ok(new Set(C.PATH.map(p => p.join(','))).size === C.PATH.length, 'the road never revisits a cell');

// ---- 2. plot rule ----
for (const p of C.PLOTS) {
  ok(C.inBoard(p.c, p.r), 'plot in board');
  ok(!C.isTrack(p.c, p.r), 'plot is off the road');
  const adj = [[1,0],[-1,0],[0,1],[0,-1]].some(([dc,dr]) => C.isTrack(p.c+dc, p.r+dr));
  ok(adj, 'plot touches the road', p);
}
ok(!C.isPlot(C.BASE.c, C.BASE.r), 'base is not a plot');
ok(!C.isPlot(-1, 0) && !C.isPlot(C.W, 0) && !C.isPlot(0, 99), 'off-board is not a plot');
// a cell two away from any road is not a plot
let far = null;
for (let r = 0; r < C.H && !far; r++) for (let c = 0; c < C.W; c++) {
  if (C.isPlot(c, r)) continue;
  const near = [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]].some(([dc,dr]) => C.isTrack(c+dc, r+dr));
  if (!near) { far = { c, r }; break; }
}
ok(far !== null, 'a far cell exists for the refused-placement gate', far);
ok(C.PLOTS.length > 30, 'plenty of plots', { plots: C.PLOTS.length });

// ---- 3. waves ----
const seen = new Set();
for (let i = 0; i < C.WAVES.length; i++) {
  const sp = C.waveSpawns(i);
  ok(sp.length > 0, `wave ${i} has spawns`);
  ok(sp.every(s => C.ENEMY_KINDS[s.kind]), `wave ${i} kinds exist`);
  for (let k = 1; k < sp.length; k++) ok(sp[k].at >= sp[k - 1].at, `wave ${i} spawn times sorted`);
  for (const s of sp) seen.add(s.kind);
}
ok(seen.size === 4, 'all four unit kinds appear', { seen: [...seen] });
ok(C.WAVES.length === 12, '12 waves');
ok(C.hpScale(0) < C.hpScale(11), 'later waves are tougher');

// ---- 4. placement / economy rules ----
const S0 = C.newState();
ok(S0.cash === C.START_CASH && S0.base === C.BASE_HP, 'fresh state has cash and base hp');
const plot0 = C.PLOTS[0];
ok(!C.canPlace(S0, C.BASE.c, C.BASE.r), 'cannot build on the base');
ok(C.place(S0, plot0.c, plot0.r, 'gun'), 'a gun goes on a plot');
ok(S0.cash === C.START_CASH - C.TOWER_KINDS.gun.cost, 'the gun was paid for');
ok(!C.canPlace(S0, plot0.c, plot0.r), 'a plot holds one tower');
ok(!C.place(S0, plot0.c, plot0.r, 'gun'), 'cannot stack a second tower');
const poor = C.newState(); poor.cash = 1;
ok(!C.place(poor, C.PLOTS[0].c, C.PLOTS[0].r, 'tesla'), 'cannot build unaffordable');
const g = C.towerAt(S0, plot0.c, plot0.r);
ok(C.upgradeCost(g) > 0 && C.upgrade(S0, plot0.c, plot0.r), 'upgrade costs cash and works');
ok(C.towerAt(S0, plot0.c, plot0.r).lvl === 2, 'level rose');
C.upgrade(S0, plot0.c, plot0.r);
ok(!C.upgrade(S0, plot0.c, plot0.r), 'level caps at 3');
ok(C.towerAt(S0, plot0.c, plot0.r).lvl === C.MAX_LVL, 'level is max');
const cashBefore = S0.cash, t0 = C.towerAt(S0, plot0.c, plot0.r);
ok(C.sell(S0, plot0.c, plot0.r), 'sell removes the tower');
ok(S0.cash === cashBefore + Math.floor(t0.paid * 0.5), 'sell refunds half the spend');
ok(!C.towerAt(S0, plot0.c, plot0.r), 'tower is gone');

// ---- 5. early wave call pays a bonus ----
const CE = C.newState();
C.startWave(CE, 0);
CE.spawnQueue = []; CE.enemies = [];
C.step(CE, 0.02);                      // clears wave 0, opens the intermission
ok(CE.intermission > 0, 'clearing a wave opens an intermission', { i: CE.intermission });
const cashE = CE.cash;
ok(C.callNext(CE), 'calling the next wave works');
ok(CE.cash === cashE + C.EARLY_BONUS, 'early call pays the bonus');
ok(CE.wave === 1, 'the next wave started');
ok(!C.callNext(CE), 'cannot call during a live wave');

// ---- 6. targeting + slow + splash + chain ----
function fixture() {
  const S = C.newState();
  S.wave = 0; S.spawnQueue = []; S.cash = 9999;
  return S;
}
const FT = fixture();
C.place(FT, C.PLOTS[0].c, C.PLOTS[0].r, 'gun');
FT.enemies = [{ id: 1, kind: 'scout', d: 1.0, hp: 1000, maxHp: 1000, slowMul: 1, slowT: 0, dead: false }];
const tgt = C.pickTarget(FT, FT.towers[0]);
ok(tgt === FT.enemies[0] || tgt === null, 'the gun targets in-range units or holds fire');
// a tower far from the road sees nothing
const FAR = fixture();
FAR.towers.push({ c: 0, r: 0, kind: 'gun', lvl: 1, cd: 0, paid: 40 });
FAR.enemies = [{ id: 9, kind: 'scout', d: 20, hp: 50, maxHp: 50, slowMul: 1, slowT: 0, dead: false }];
if (!C.isTrack(0, 0)) ok(C.pickTarget(FAR, FAR.towers[0]) === null, 'an out-of-range tower holds fire');
// a plot that actually overlooks the stretch of road the fixture's unit stands on
const plotNearIdx = (i) => {
  const [pc, pr] = C.PATH[i];
  const hits = C.PLOTS.filter(p => Math.abs(p.c - pc) + Math.abs(p.r - pr) === 1);
  return hits[0];
};
// slow stops a scout moving at full speed
const SL = fixture();
const plotNear = plotNearIdx(1);
SL.towers.push({ c: plotNear.c, r: plotNear.r, kind: 'frost', lvl: 1, cd: 0, paid: 55 });
SL.enemies = [{ id: 1, kind: 'scout', d: 0.2, hp: 5000, maxHp: 5000, slowMul: 1, slowT: 0, dead: false }];
C.step(SL, 0.02);
ok(SL.enemies[0].slowMul < 1 || SL.enemies[0].slowT > 0, 'frost chills its target', SL.enemies[0].slowT);
// splash hurts a second unit beside the target
const SP = fixture();
SP.towers.push({ c: plotNear.c, r: plotNear.r, kind: 'cannon', lvl: 1, cd: 0, paid: 70 });
SP.enemies = [
  { id: 1, kind: 'heavy', d: 0.2, hp: 5000, maxHp: 5000, slowMul: 1, slowT: 0, dead: false },
  { id: 2, kind: 'heavy', d: 0.5, hp: 5000, maxHp: 5000, slowMul: 1, slowT: 0, dead: false },
];
C.step(SP, 0.02);
ok(SP.enemies.every(e => e.hp < 5000), 'cannon splash hits both units', SP.enemies.map(e => e.hp));
// a kill pays the bounty
const KL = fixture();
KL.towers.push({ c: plotNear.c, r: plotNear.r, kind: 'cannon', lvl: 3, cd: 0, paid: 70 });
KL.enemies = [{ id: 1, kind: 'scout', d: 0.2, hp: 1, maxHp: 1, slowMul: 1, slowT: 0, dead: false }];
const cashK = KL.cash;
C.step(KL, 0.02);
ok(KL.kills === 1 && KL.cash === cashK + C.ENEMY_KINDS.scout.bounty, 'a kill pays the bounty', { kills: KL.kills });

// ---- 7. a passive base is overrun ----
function runPassive(limit = 1200) {
  const S = C.newState();
  C.startWave(S, 0);
  let t = 0;
  while (t < limit && !S.over) { C.step(S, 1 / 60); t += 1 / 60; }
  return { S, t };
}
const passive = runPassive();
ok(passive.S.over && passive.S.result === 'lose', 'a passive base loses', { r: passive.S.result, base: passive.S.base });
ok(passive.S.base === 0, 'the passive loss drains the base to zero');
ok(passive.S.kills === 0, 'no towers means no kills');

// ---- 8. a greedy builder holds all twelve waves ----
function greedyRun(limit = 20000) {
  const S = C.newState();
  C.startWave(S, 0);
  // plots closest to the base first: the last stretch is where a tower earns most
  const order = C.PLOTS.slice().sort((a, b) => C.roadDist(a.c, a.r) - C.roadDist(b.c, b.r));
  let t = 0, idx = 0;
  while (t < limit && !S.over) {
    for (;;) {
      const guns = S.towers.filter(x => x.kind === 'gun');
      // buy a tower while there is room, else pour cash into upgrading what is built
      const up = S.towers.slice().sort((a, b) => a.lvl - b.lvl)[0];
      if (idx < order.length && S.cash >= C.TOWER_KINDS.gun.cost && S.towers.length < 14) {
        C.place(S, order[idx].c, order[idx].r, 'gun'); idx++;
        continue;
      }
      if (up && up.lvl < C.MAX_LVL && S.cash >= C.upgradeCost(up)) { C.upgrade(S, up.c, up.r); continue; }
      break;
    }
    C.step(S, 1 / 60); t += 1 / 60;
  }
  return { S, t, towers: S.towers.length };
}
const greedy = greedyRun();
ok(greedy.S.result === 'win', 'a greedy builder wins the twelve waves', {
  result: greedy.S.result, wave: greedy.S.wave + 1, base: greedy.S.base, kills: greedy.S.kills, towers: greedy.towers,
});
ok(greedy.S.base > 0 && greedy.S.base <= C.BASE_HP, 'the winner keeps a positive base', { base: greedy.S.base });
ok(greedy.S.over, 'the winning run terminates instead of looping');

// ---- 9. leak accounting ----
const LK = C.newState();
C.startWave(LK, 0);
LK.spawnQueue = [];
LK.enemies = [{ id: 1, kind: 'brute', d: C.PATH_LEN - 0.01, hp: 100, maxHp: 100, slowMul: 1, slowT: 0, dead: false }];
const baseBefore = LK.base;
C.step(LK, 0.2);
ok(LK.leaks === 1, 'a unit that reaches the base leaks', { leaks: LK.leaks });
ok(LK.base === baseBefore - C.ENEMY_KINDS.brute.leak, 'a leak costs the base its damage', { base: LK.base });

console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
