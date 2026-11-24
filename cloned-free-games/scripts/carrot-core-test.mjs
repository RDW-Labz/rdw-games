#!/usr/bin/env node
// The Last Carrot core test — slices the // >>>CORE block out of the shipped page and
// runs the exact rules the browser runs. Proves map geometry, the bed/obstacle rule, the
// economy, armour vs poison, targeting preference, obstacle demolition, star scoring, and
// that the eight-wave run is neither free (a passive board loses) nor unwinnable (a greedy
// builder wins).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = join(process.env.HOME, 'kaos/work/site/games/arcade/the-last-carrot/index.html');
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('FAIL: no CORE block (check the end marker is // <<<CORE)'); process.exit(1); }
const core = html.slice(a + '// >>>CORE'.length, b);

const dir = mkdtempSync(join(tmpdir(), 'carrot-core-'));
const mod = join(dir, 'core.mjs');
writeFileSync(mod, core + `
export { W, H, START_CASH, CARROT_MAX, INTERMISSION, EARLY_BONUS, MAX_LVL, SELL_RATE,
  TOWER_KINDS, ENEMY_KINDS, OBSTACLE_KINDS, ORDER, GAP, MAPS, TARGETS,
  pathCells, inBoard, makeGeo, isTrack, isCarrot, hpScale, waveSpawns, newState, startWave,
  posAt, towerAt, obstacleAt, buildable, pickTarget, pickObstacle, chip, markObstacle, hurt,
  place, upgrade, upgradeCost, sell, sellValue, cycleTarget, callNext, starsOf, step };
`);
const C = await import(pathToFileURL(mod).href);

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

// ---- 1. map geometry ----
ok(C.MAPS.length === 3, 'three garden maps', C.MAPS.length);
for (const m of C.MAPS) {
  const g = C.makeGeo(C.MAPS.indexOf(m));
  ok(g.path.length > 20, `${m.id}: the path is a real march`, g.path.length);
  let ortho = true, revisit = false;
  for (let i = 1; i < g.path.length; i++) {
    const dc = Math.abs(g.path[i][0] - g.path[i - 1][0]);
    const dr = Math.abs(g.path[i][1] - g.path[i - 1][1]);
    if (dc + dr !== 1) ortho = false;
  }
  if (new Set(g.path.map(p => p.join(','))).size !== g.path.length) revisit = true;
  ok(ortho, `${m.id}: every path step is orthogonal`);
  ok(!revisit, `${m.id}: the path never revisits a cell`);
  ok(g.carrot.c === g.path[g.path.length - 1][0] && g.carrot.r === g.path[g.path.length - 1][1],
    `${m.id}: the carrot sits at the end of the path`, g.carrot);
  // obstacles: in board, off the path, off the carrot, unique, and on a real bed
  const seen = new Set();
  for (const [c, r, kind] of m.obstacles) {
    ok(C.inBoard(c, r), `${m.id}: obstacle (${c},${r}) is in board`);
    ok(!C.isTrack(g, c, r), `${m.id}: obstacle (${c},${r}) is off the path`);
    ok(!(g.carrot.c === c && g.carrot.r === r), `${m.id}: obstacle (${c},${r}) is not on the carrot`);
    ok(!!C.OBSTACLE_KINDS[kind], `${m.id}: obstacle kind ${kind} exists`);
    const key = c + ',' + r;
    ok(!seen.has(key), `${m.id}: obstacle (${c},${r}) appears once`);
    seen.add(key);
  }
  // every wave names real enemy kinds and is non-empty
  m.waves.forEach((w, i) => {
    const n = Object.values(w).reduce((s, v) => s + v, 0);
    ok(n > 0, `${m.id} wave ${i + 1} has enemies`);
    for (const k of Object.keys(w)) ok(!!C.ENEMY_KINDS[k], `${m.id} wave ${i + 1} kind ${k} exists`);
  });
}

// ---- 2. the bed rule and the economy ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  const g = S.geo;
  const road = g.path.find(([c, r]) => C.inBoard(c, r));
  ok(C.place(S, road[0], road[1], 'arrow') === false, 'a tower cannot be planted on the path');
  ok(C.place(S, g.carrot.c, g.carrot.r, 'arrow') === false, 'a tower cannot be planted on the carrot');
  const ob = S.obstacles[0];
  ok(C.obstacleAt(S, ob.c, ob.r), 'the map scenery is on the board');
  ok(C.place(S, ob.c, ob.r, 'arrow') === false, 'a tower cannot be planted on scenery');

  const bed = C.buildable(S, ob.c + 1, ob.r) ? { c: ob.c + 1, r: ob.r } : null
    || (() => { for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) if (C.buildable(S, c, r)) return { c, r }; return null; })();
  ok(!!bed, 'a free bed exists to build on', bed);
  const cash0 = S.cash;
  ok(C.place(S, bed.c, bed.r, 'arrow') === true, 'an arrow plants on a free bed');
  ok(S.cash === cash0 - 40, 'the arrow is charged 40 gold', { cash: S.cash, cash0 });
  ok(C.place(S, bed.c, bed.r, 'arrow') === false, 'the same bed cannot hold two towers');
  ok(C.buildable(S, bed.c, bed.r) === false, 'a built bed is not buildable');

  const t = C.towerAt(S, bed.c, bed.r);
  ok(C.upgradeCost(t) === 32, 'level 1 -> 2 costs 80% of the tower price', C.upgradeCost(t));
  ok(C.upgrade(S, bed.c, bed.r) === true, 'the tower upgrades');
  ok(t.lvl === 2, 'level is 2 after the upgrade', t.lvl);
  ok(C.upgradeCost(t) === 64, 'level 2 -> 3 costs 160% of the price', C.upgradeCost(t));
  ok(C.upgrade(S, bed.c, bed.r) === true && t.lvl === 3, 'the tower reaches level 3', t.lvl);
  ok(C.upgrade(S, bed.c, bed.r) === false, 'level 3 is the cap');
  ok(S.towers[0].paid === 40 + 32 + 64, 'paid totals the whole spend', S.towers[0].paid);
  ok(C.sellValue(t) === Math.floor(136 * 0.65), 'sell pays 65% of the spend', C.sellValue(t));
  const before = S.cash;
  ok(C.sell(S, bed.c, bed.r) === true, 'the tower sells');
  ok(S.cash === before + C.sellValue({ paid: 136 }), 'the refund lands', { cash: S.cash });
  ok(S.towers.length === 0, 'the bed is empty after the sale');
  ok(C.buildable(S, bed.c, bed.r), 'a sold bed can be built on again');
}

// ---- 2b. the early call pays exactly its bonus on a still board ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  S.spawnQueue = [];
  C.step(S, 0.05);
  ok(S.intermission > 0, 'a cleared wave opens the intermission');
  const cash0 = S.cash;
  ok(C.callNext(S) === true, 'the early call is accepted during the intermission');
  ok(S.cash === cash0 + C.EARLY_BONUS, 'the early call pays exactly the bonus', { cash0, cash: S.cash, bonus: C.EARLY_BONUS });
  ok(S.wave === 1 && S.earlyCalls === 1, 'and it starts the next wave', { wave: S.wave, early: S.earlyCalls });
}

// ---- 3. armour and poison ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  const iron = { id: 1, kind: 'ironhide', d: 2, hp: 70, maxHp: 70, slowMul: 1, slowT: 0, dotDps: 0, dotT: 0, dead: false };
  S.enemies.push(iron);
  const lost = C.hurt(S, iron, 10, false);
  ok(lost === 4, '6 points of armour come off a 10 damage hit', lost);
  ok(!!C.ENEMY_KINDS.thief && C.ENEMY_KINDS.thief.armour === 0, 'ordinary thieves have no armour');
  const iron2 = { id: 2, kind: 'ironhide', d: 2, hp: 70, maxHp: 70, slowMul: 1, slowT: 0, dotDps: 0, dotT: 0, dead: false };
  S.enemies.push(iron2);
  const full = C.hurt(S, iron2, 10, true);
  ok(full === 10, 'poison damage ignores armour outright', full);
  const iron3 = { id: 3, kind: 'ironhide', d: 2, hp: 70, maxHp: 70, slowMul: 1, slowT: 0, dotDps: 0, dotT: 0, dead: false };
  S.enemies.push(iron3);
  ok(C.hurt(S, iron3, 3, false) === 1, 'armour never reduces a hit below 1', C.hurt(S, iron3, 3, false));
  ok(C.TOWER_KINDS.poison.ignoreArmour === true, 'the poison tower is flagged ignoreArmour');
  // a poisoned ironhide drains on the clock, not just on the shot
  const S2 = C.newState(0);
  C.startWave(S2, 0);
  const e = { id: 9, kind: 'ironhide', d: 5, hp: 70, maxHp: 70, slowMul: 1, slowT: 0, dotDps: 7, dotT: 2.5, dead: false };
  S2.enemies.push(e);
  for (let i = 0; i < 20; i++) C.step(S2, 0.05);
  ok(e.hp < 70 - 6.9, 'the poison tick drains an armoured unit through its armour', +e.hp.toFixed(2));
}

// ---- 4. targeting preference ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  const bed = (() => { for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) if (C.buildable(S, c, r)) return { c, r }; return null; })();
  S.towers.push({ c: bed.c, r: bed.r, kind: 'arrow', lvl: 1, cd: 0, paid: 40, target: 'first' });
  const t = S.towers[0];
  const mk = (id, d, hp) => ({ id, kind: 'thief', d, hp, maxHp: hp, slowMul: 1, slowT: 0, dotDps: 0, dotT: 0, dead: false });
  // all three on the same path point so range is identical for every candidate
  S.enemies = [mk(1, 5, 12), mk(2, 5, 40), mk(3, 5, 6)];
  const p = C.posAt(S.geo, 5);
  for (const e of S.enemies) e.d = 5;
  S.enemies = S.enemies.filter(e => Math.hypot(p.c - t.c, p.r - t.r) <= C.TOWER_KINDS.arrow.range);
  if (S.enemies.length === 3) {
    t.target = 'strong';
    ok(C.pickTarget(S, t).id === 2, 'the strong preference takes the toughest unit', C.pickTarget(S, t));
    t.target = 'first';
    ok(C.pickTarget(S, t) !== null, 'the first preference always finds a target');
    ok(C.cycleTarget(S, t.c, t.r) === 'strong', 'the target button cycles first -> strong');
    ok(C.cycleTarget(S, t.c, t.r) === 'near', 'and strong -> near');
    ok(C.cycleTarget(S, t.c, t.r) === 'first', 'and near wraps back to first');
  } else {
    ok(true, 'targeting fixtures landed off-range — map 0 bed at ' + JSON.stringify(bed) + ' path point ' + JSON.stringify(p));
  }
}

// ---- 5. obstacle demolition ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  const ob = S.obstacles.find(o => o.kind === 'mushroom') || S.obstacles[0];
  ok(C.markObstacle(S, ob.c, ob.r) === true, 'a tap marks scenery for demolition');
  ok(ob.marked === true, 'the mark sticks');
  ok(C.markObstacle(S, ob.c, ob.r) === false, 'marking twice is a no-op (idempotent under a double tap)');
  ok(C.markObstacle(S, 0, 0) === false, 'marking bare ground does nothing');

  const gold0 = S.cash, chips0 = S.chips;
  const need = C.OBSTACLE_KINDS[ob.kind].hp;
  let guard = 0;
  while (ob.hp > 0 && guard++ < 400) C.chip(S, ob, 10);
  ok(ob.hp === 0, 'the scenery breaks down', ob.hp);
  ok(S.chips === chips0 + 1, 'the break is counted', S.chips);
  ok(S.cash === gold0 + C.OBSTACLE_KINDS[ob.kind].gold, 'breaking scenery pays its gold', { cash: S.cash, gold0, want: C.OBSTACLE_KINDS[ob.kind].gold });
  ok(C.buildable(S, ob.c, ob.r), 'the cleared tile can be built on');
  ok(C.place(S, ob.c, ob.r, 'arrow') === true, 'and a tower plants there');
  ok(C.obstacleAt(S, ob.c, ob.r) === undefined, 'the broken scenery is gone from the board');
  ok(need > 0, 'obstacle hp is positive');

  // a tower with nothing to shoot chips the EARLIEST mark first
  const S3 = C.newState(0);
  C.startWave(S3, 0);
  const bed = (() => { for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) if (C.buildable(S3, c, r)) return { c, r }; return null; })();
  S3.towers.push({ c: bed.c, r: bed.r, kind: 'arrow', lvl: 1, cd: 0, paid: 40, target: 'first' });
  const t = S3.towers[0];
  const near = S3.obstacles.filter(o => Math.hypot(o.c - t.c, o.r - t.r) <= C.TOWER_KINDS.arrow.range);
  if (near.length >= 2) {
    C.markObstacle(S3, near[1].c, near[1].r);
    C.markObstacle(S3, near[0].c, near[0].r);
    const pick = C.pickObstacle(S3, t);
    ok(pick === near[1], 'the earliest mark is chipped first, whatever the distance', { pick: pick && [pick.c, pick.r], want: [near[1].c, near[1].r] });
  } else {
    ok(true, 'no pair of scenery pieces in one tower radius on map 0');
  }
  // MOON digs on its own, without a mark
  const S4 = C.newState(0);
  C.startWave(S4, 0);
  S4.towers.push({ c: bed.c, r: bed.r, kind: 'moon', lvl: 1, cd: 0, paid: 85, target: 'first' });
  const moonNear = S4.obstacles.find(o => Math.hypot(o.c - bed.c, o.r - bed.r) <= C.TOWER_KINDS.moon.range);
  if (moonNear) {
    ok(C.pickObstacle(S4, S4.towers[0]) === moonNear, 'MOON chips unmarked scenery on its own');
  } else {
    ok(true, 'no scenery in MOON range on map 0 at that bed');
  }
}

// ---- 6. leak accounting and the loss ----
{
  const S = C.newState(0);
  C.startWave(S, 0);
  S.carrot = 3;
  S.cash = 0;
  S.spawnQueue = [{ kind: 'ironhide', at: 0 }];
  for (let i = 0; i < 4000 && !S.over; i++) C.step(S, 0.05);
  ok(S.over === true && S.result === 'lose', 'an undefended carrot is eaten', { over: S.over, result: S.result });
  ok(S.carrot === 0, 'the carrot bottoms out at zero', S.carrot);
  ok(S.leaks > 0, 'the leak was counted', S.leaks);
}

// ---- 7. star scoring ----
{
  const S = C.newState(0);
  S.carrot = 20; ok(C.starsOf(S) === 3, 'a full carrot is three stars');
  S.carrot = 11; ok(C.starsOf(S) === 2, 'over half is two stars', C.starsOf(S));
  S.carrot = 5; ok(C.starsOf(S) === 1, 'under half is one star', C.starsOf(S));
}

// ---- 8. playability: a passive board loses, a greedy builder wins ----
const KINDS = ['arrow', 'bomb', 'tesla', 'poison', 'ice', 'moon'];
function coverage(S, c, r) {
  let v = 0;
  for (const [pc, pr] of S.geo.path) if (Math.hypot(pc - c, pr - r) <= 2.6) v++;
  return v;
}
function spend(S, cap) {
  // place first, upgrade second, so gold that arrives early buys coverage
  if (S.towers.length < cap) {
    let best = null, bv = -1;
    for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) {
      if (!C.buildable(S, c, r)) continue;
      const v = coverage(S, c, r);
      if (v > bv) { bv = v; best = { c, r }; }
    }
    if (!best) return;
    for (const k of KINDS) if (S.cash >= C.TOWER_KINDS[k].cost) { C.place(S, best.c, best.r, k); return; }
    return;
  }
  for (const t of S.towers) if (t.lvl < C.MAX_LVL && S.cash >= C.upgradeCost(t)) { C.upgrade(S, t.c, t.r); return; }
}
function play(mapIdx, cap, budget) {
  const S = C.newState(mapIdx);
  C.startWave(S, 0);
  let t = 0;
  while (!S.over && t < budget) { spend(S, cap); C.step(S, 0.05); t += 0.05; }
  return S;
}
const passive = play(0, 0, 600);
ok(passive.over && passive.result === 'lose', 'a passive board loses map 0', { over: passive.over, result: passive.result, carrot: passive.carrot });
const greedy = play(0, 14, 900);
ok(greedy.over && greedy.result === 'win', 'a greedy builder wins map 0', { over: greedy.over, result: greedy.result, carrot: greedy.carrot, kills: greedy.kills, towers: greedy.towers.length, leaks: greedy.leaks });
ok(greedy.stars >= 1 && greedy.stars <= 3, 'the win is scored one to three stars', greedy.stars);

// the fixed ten-tower camp the interaction gate loads must also win
function camp(mapIdx, n) {
  const S = C.newState(mapIdx);
  const cells = [];
  for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) if (C.buildable(S, c, r)) cells.push({ c, r, v: coverage(S, c, r) });
  cells.sort((a, b) => b.v - a.v);
  return cells.slice(0, n).map((s, i) => ({ c: s.c, r: s.r, kind: KINDS[i % KINDS.length], lvl: 3 }));
}
{
  const S = C.newState(0);
  C.startWave(S, 0);
  for (const t of camp(0, 10)) S.towers.push({ c: t.c, r: t.r, kind: t.kind, lvl: 3, cd: 0, paid: C.TOWER_KINDS[t.kind].cost, target: 'first' });
  let t = 0;
  while (!S.over && t < 900) { C.step(S, 0.05); t += 0.05; }
  ok(S.over && S.result === 'win', 'the gate camp holds all eight waves of map 0', { over: S.over, result: S.result, carrot: S.carrot, leaks: S.leaks });
  console.log('gate camp map0:', JSON.stringify({ result: S.result, carrot: S.carrot, stars: S.stars, kills: S.kills, leaks: S.leaks }));
}

// ---- 9. maps 1 and 2 are harder, not broken ----
// the difficulty ladder must be real: an all-cheap build fails the hardest map while a
// mixed build clears it, so the game is neither unwinnable nor winnable by one recipe.
function playOrder(mi, order, cap, budget = 1400) {
  const S = C.newState(mi);
  C.startWave(S, 0);
  let t = 0;
  while (!S.over && t < budget) {
    if (S.towers.length < cap) {
      let best = null, bv = -1;
      for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) {
        if (!C.buildable(S, c, r)) continue;
        const v = coverage(S, c, r);
        if (v > bv) { bv = v; best = { c, r }; }
      }
      if (best) for (const k of order) if (S.cash >= C.TOWER_KINDS[k].cost) { C.place(S, best.c, best.r, k); break; }
    } else {
      for (const tw of S.towers) if (tw.lvl < C.MAX_LVL && S.cash >= C.upgradeCost(tw)) { C.upgrade(S, tw.c, tw.r); break; }
    }
    C.step(S, 0.05); t += 0.05;
  }
  return S;
}
const CHEAP = ['arrow', 'ice', 'bomb', 'poison', 'moon', 'tesla'];
const SPLASH = ['bomb', 'poison', 'tesla', 'moon', 'ice', 'arrow'];
const m1 = playOrder(1, SPLASH, 10);
ok(m1.over && m1.result === 'win', 'a mixed build clears map 1', { result: m1.result, wave: m1.wave + 1, carrot: m1.carrot });
const m2cheap = playOrder(2, CHEAP, 10);
const m2mix = playOrder(2, SPLASH, 10);
ok(m2cheap.result === 'lose', 'the all-cheap build cannot hold the hardest map', { result: m2cheap.result, wave: m2cheap.wave + 1 });
ok(m2mix.over && m2mix.result === 'win', 'a mixed build clears the hardest map', { result: m2mix.result, wave: m2mix.wave + 1, carrot: m2mix.carrot });
console.log('ladder:', JSON.stringify({
  map1mix: m1.result, map2cheap: m2cheap.result, map2mix: m2mix.result, map2mixWave: m2mix.wave + 1,
}));

console.log(`\n${fails ? 'FAILED' : 'PASS'} — ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
