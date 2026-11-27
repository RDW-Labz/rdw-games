#!/usr/bin/env node
// Cluer Park (OpenRCT2 card) core test — slices the // >>>CORE block out of the shipped page
// and runs the exact rules the browser runs: path/ride/stall/tree placement, the routing flood,
// the guest economy, the rating, and a player ladder (a good park wins, a thin park loses,
// an idle park never sees a guest, an overbuilt one goes bankrupt).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = join(process.env.HOME, 'kaos/work/site/games/arcade/openrct2/index.html');
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('FAIL: no CORE block'); process.exit(1); }
const core = html.slice(a + '// >>>CORE'.length, b);

const dir = mkdtempSync(join(tmpdir(), 'openrct2-core-'));
const mod = join(dir, 'core.mjs');
writeFileSync(mod, core + `
export { W, H, ENTRANCE, START_CASH, SEASON, TARGET_VISITS, RATING_TARGET, PATH_COST, PATH_REFUND, TREE_COST,
  MAX_IN_PARK, GUEST_SPEED, GUEST_MONEY, DIRS, RIDE_KINDS, STALL_KIND, TOOLS, TOOL_COST, TOOL_LABEL,
  mulberry32, inBoard, idx, at, isPathAt, cellType, newState, placePath, footprintFree, footprintOnPath,
  placeRide, placeStall, placeTree, demolish, flood, routeTo, rideAccess, rideById, ridesReachable,
  rideExcite, spawnInterval, avgHappy, parkRating, spawnGuest, exitGuest, goLeave, chooseGoal, arrive,
  guestTick, step, PARK_PLAN, applyPlan };
`);
const C = await import(pathToFileURL(mod).href);

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
  return cond;
};

// ---- 1. the base state ----
{
  const S = C.newState(1);
  ok(S.cash === C.START_CASH, 'start cash is the rule constant', S.cash);
  ok(C.isPathAt(S, C.ENTRANCE.c, C.ENTRANCE.r), 'the gate tile is path');
  ok(S.cells.filter(c => c.type !== 'grass').length === 1, 'a new park has only the gate');
  ok(S.t === 0 && !S.over && S.rides.length === 0, 'a new park is not over');
  ok(C.SEASON > 60 && C.TARGET_VISITS > 20, 'the season and the target are playable', [C.SEASON, C.TARGET_VISITS]);
}

// ---- 2. path rules ----
{
  const S = C.newState(2);
  ok(C.placePath(S, C.ENTRANCE.c, C.ENTRANCE.r - 1) === 'ok', 'a path beside the gate is built');
  ok(C.placePath(S, C.ENTRANCE.c, C.ENTRANCE.r - 1) !== 'ok', 'a taken tile is refused');
  ok(C.placePath(S, 0, 0) !== 'ok', 'an island path is refused', C.placePath(S, 0, 0));
  ok(C.placePath(S, -1, 4) !== 'ok', 'an off-board path is refused');
  ok(C.placePath(S, C.W, 4) !== 'ok', 'an off-board path is refused on the far edge');
  const cash0 = S.cash;
  ok(C.placePath(S, 6, 10) === 'ok', 'a second path is built');
  ok(S.cash === cash0 - C.PATH_COST, 'a path costs its price', S.cash);
  const poor = C.newState(3); poor.cash = C.PATH_COST - 1;
  ok(C.placePath(poor, C.ENTRANCE.c, C.ENTRANCE.r - 1) !== 'ok', 'a path you cannot afford is refused');
  // chains: each new tile must touch the last
  ok(C.placePath(S, C.ENTRANCE.c, C.ENTRANCE.r - 2) === 'ok', 'the chain continues');
  ok(C.placePath(S, C.ENTRANCE.c + 1, C.ENTRANCE.r - 3) !== 'ok', 'a diagonal-only neighbour is refused');
}

// ---- 3. ride rules ----
{
  const S = C.newState(4);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  ok(C.placeRide(S, 'carousel', 8, 5) === 'ok', 'a carousel beside the path is built');
  ok(!C.footprintFree(S, 8, 5, 2, 2), 'its footprint is no longer free');
  ok(C.placeRide(S, 'dodgems', 8, 5) !== 'ok', 'a ride on a taken footprint is refused');
  ok(C.placeRide(S, 'carousel', 0, 0) !== 'ok', 'a ride with no path beside it is refused', C.placeRide(S, 'carousel', 0, 0));
  ok(C.placeRide(S, 'coaster', 2, 5) === 'ok', 'a 3x3 coaster on open grass is built', C.placeRide(S, 'coaster', 2, 5));
  ok(C.placeRide(S, 'coaster', 14, 5) !== 'ok', 'a ride hanging off the board is refused');
  const poor = C.newState(5);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(poor, c, r);
  poor.cash = 100;
  ok(C.placeRide(poor, 'coaster', 2, 5) !== 'ok', 'a ride you cannot afford is refused');
  ok(C.placeRide(poor, 'nonsense', 2, 5) !== 'ok', 'an unknown ride is refused');
}

// ---- 4. stalls, trees, demolish ----
{
  const S = C.newState(6);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  ok(C.placeStall(S, 7, 3) === 'ok', 'a burger bar beside the path is built');
  ok(C.placeStall(S, 0, 0) !== 'ok', 'a stall with no path beside it is refused');
  ok(C.placeTree(S, 7, 3) !== 'ok', 'a tree on a taken tile is refused');
  ok(C.placeTree(S, 6, 3) === 'ok', 'a tree on grass is planted');
  ok(C.demolish(S, C.ENTRANCE.c, C.ENTRANCE.r) !== 'ok', 'the park gate cannot be bulldozed');
  const cashBefore = S.cash;
  ok(C.demolish(S, 7, 4) === 'ok', 'a path can be bulldozed');
  ok(S.cash === cashBefore + C.PATH_REFUND, 'a bulldozed path refunds half', [cashBefore, S.cash]);
  ok(C.demolish(S, 0, 0) !== 'ok', 'bulldozing grass does nothing');
  ok(C.placeRide(S, 'dodgems', 5, 5) === 'ok', 'a dodgems block is built');
  const before = S.cash;
  ok(C.demolish(S, 5, 5) === 'ok', 'the dodgems can be bulldozed');
  ok(S.cash === before + Math.floor(C.RIDE_KINDS.dodgems.cost * 0.5), 'a bulldozed ride refunds half');
  ok(S.rides.length === 0, 'the ride is gone from the state');
  ok(S.cells.every(c => c.type !== 'ride'), 'no ride cells are left behind');
  ok(C.demolish(S, 7, 3) === 'ok' && S.stalls.length === 0, 'the stall is gone');
}

// ---- 5. routing ----
{
  const S = C.newState(7);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  const f = C.flood(S, C.ENTRANCE.c, C.ENTRANCE.r);
  ok(!!f, 'the flood runs from the gate');
  ok(f.dist[C.idx(7, 4)] === 6, 'the spine is six steps from the gate', f.dist[C.idx(7, 4)]);
  ok(f.dist[C.idx(10, 4)] === 9, 'the far end of the row is nine steps away', f.dist[C.idx(10, 4)]);
  ok(f.dist[C.idx(0, 0)] === -1, 'grass is unreachable');
  const route = C.routeTo(f, 7, 4);
  ok(Array.isArray(route) && route.length === 6, 'the route to the spine end is six tiles', route && route.length);
  ok(route[route.length - 1][0] === 7 && route[route.length - 1][1] === 4, 'the route ends on the target');
  ok(C.routeTo(f, 0, 0) === null, 'no route to grass');
  ok(C.flood(S, 0, 0) === null, 'no flood from off-path');
  // a gap in the path makes the far side unreachable
  C.demolish(S, 7, 6);
  const f2 = C.flood(S, C.ENTRANCE.c, C.ENTRANCE.r);
  ok(f2.dist[C.idx(7, 4)] === -1, 'a broken path disconnects the park');
  ok(!C.ridesReachable(S) || S.rides.length === 0, 'no ride is reachable through a gap');
}

// ---- 6. ride access + scenery ----
{
  const S = C.newState(8);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  C.placeRide(S, 'carousel', 8, 5);
  const ride = S.rides[0];
  const acc = C.rideAccess(S, ride);
  ok(acc.some(([c, r]) => c === 8 && r === 4), 'the carousel is served by the path above it', acc);
  ok(acc.every(([c, r]) => C.isPathAt(S, c, r)), 'every access tile is path');
  const base = C.rideExcite(S, ride);
  ok(Math.abs(base - C.RIDE_KINDS.carousel.excite) < 1e-9, 'with no trees a ride has its base excitement', base);
  for (const [c, r] of [[8, 3], [10, 6], [10, 3]]) C.placeTree(S, c, r);
  const boosted = C.rideExcite(S, ride);
  ok(boosted > base, 'trees lift a ride\u2019s excitement', [base, boosted]);
  ok(boosted <= base + 1.4 + 1e-9, 'the scenery bonus is capped');
  // exact payment
  const S2 = C.newState(9);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S2, c, r);
  C.placeRide(S2, 'carousel', 8, 5);
  const g = C.spawnGuest(S2);
  let guard = 0;
  while (S2.income === 0 && guard++ < 4000) C.step(S2, 0.05);
  ok(S2.income === C.RIDE_KINDS.carousel.price, 'a guest pays exactly the ticket price', S2.income);
  ok(g.rides === 1 && g.ridesDone.length === 1, 'the guest has ridden once', [g.rides, g.ridesDone]);
}

// ---- 7. rating + arrival curve ----
{
  const S = C.newState(10);
  const r0 = C.parkRating(S);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  const r1 = C.parkRating(S);
  ok(r1 >= r0, 'paths alone do not hurt the rating', [r0, r1]);
  C.placeRide(S, 'carousel', 8, 5);
  C.placeRide(S, 'dodgems', 5, 5);
  const r2 = C.parkRating(S);
  ok(r2 > r1, 'rides raise the rating', [r1, r2]);
  for (const [c, r] of C.PARK_PLAN.trees) C.placeTree(S, c, r);
  const r3 = C.parkRating(S);
  ok(r3 > r2, 'trees raise the rating', [r2, r3]);
  ok(r3 <= 999 && C.parkRating(S) >= 150, 'the rating stays in range');
  ok(C.spawnInterval(900) < C.spawnInterval(300), 'a better rating brings guests sooner',
    [C.spawnInterval(300), C.spawnInterval(900)]);
  ok(C.spawnInterval(300) > 1.5 && C.spawnInterval(999) > 0.4, 'the arrival gap stays human', [C.spawnInterval(300), C.spawnInterval(999)]);
}

// ---- 8. guests only come for a reachable ride, and only walk on path ----
{
  const S = C.newState(11);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(S, c, r);
  for (let i = 0; i < 1200; i++) C.step(S, 0.05);
  ok(S.visits === 0 && S.guests.length === 0, 'a park with no ride never sees a guest', [S.visits, S.guests.length]);
  ok(!C.ridesReachable(S), 'ridesReachable is false with no rides');

  const T = C.newState(12);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(T, c, r);
  C.placeRide(T, 'carousel', 8, 5);
  C.placeRide(T, 'dodgems', 5, 5);
  for (let i = 0; i < 600; i++) C.step(T, 0.05);   // 30 s
  ok(T.guests.length > 0, 'guests arrive once a ride is reachable', T.guests.length);
  let offPath = 0, ridden = 0;
  for (const g of T.guests) {
    if (!C.isPathAt(T, g.c, g.r)) offPath++;
    if (g.rides > 0) ridden++;
  }
  ok(offPath === 0, 'every guest stands on a path tile', offPath);
  ok(ridden > 0, 'guests ride the rides', ridden);
  ok(T.income > 0, 'tickets bring money in', T.income);
  ok(T.cash > 0, 'the park is solvent');
}

// ---- 9. player ladder ----
function playPark(seed, { plan = C.PARK_PLAN, stageRides = true, trees = true, cash } = {}) {
  const S = C.newState(seed);
  if (typeof cash === 'number') S.cash = cash;
  for (const [c, r] of plan.paths || []) C.placePath(S, c, r);
  let nextRide = 0, nextTree = 0, lastT = -99;
  const treeList = plan.trees || [];
  while (!S.over && S.t < C.SEASON + 1) {
    C.step(S, 0.05);
    if (S.t - lastT < 2) continue;
    lastT = S.t;
    if (stageRides && nextRide < (plan.rides || []).length) {
      const rd = plan.rides[nextRide];
      const k = C.RIDE_KINDS[rd.kind];
      if (S.cash > k.cost + 150) { if (C.placeRide(S, rd.kind, rd.c, rd.r) === 'ok') nextRide++; }
    } else if (trees && nextTree < treeList.length) {
      if (S.cash > 500) { const [c, r] = treeList[nextTree]; if (C.placeTree(S, c, r) === 'ok') nextTree++; }
    }
  }
  return S;
}

{
  // the ladder: a full park wins on every seed, a one-ride park never does
  let goodWins = 0, thinWins = 0;
  const thinPlan = { paths: C.PARK_PLAN.paths, rides: [{ kind: 'carousel', c: 8, r: 5 }], stalls: [], trees: [] };
  for (let seed = 21; seed <= 26; seed++) {
    const g = playPark(seed);
    const t = playPark(seed + 100, { plan: thinPlan });
    if (g.result === 'win') goodWins++;
    if (t.result === 'win') thinWins++;
    console.log(`LADDER seed ${seed}  full -> ${g.result} visits ${String(g.visits).padStart(3)} rating ${g.rating} t ${g.t.toFixed(0)}`
      + `  |  thin -> ${t.result} visits ${String(t.visits).padStart(3)} rating ${t.rating}`);
  }
  ok(goodWins >= 5, 'a fully built park wins on nearly every seed', goodWins);
  ok(thinWins === 0, 'a one-ride park never meets the target', thinWins);

  const good = playPark(21);
  ok(good.result === 'win', 'a fully built park meets the attendance target', [good.result, good.visits]);
  ok(good.visits >= C.TARGET_VISITS && good.rating >= C.RATING_TARGET,
    'it wins on attendance and rating, not on a technicality', [good.visits, good.rating]);

  const lazy = playPark(22, { plan: thinPlan });
  console.log('LADDER thin park  -> result', lazy.result, 'visits', lazy.visits, 'rides', lazy.rides.length, 'rating', lazy.rating);
  ok(lazy.result !== 'win', 'a park with one ride and no scenery misses the target', [lazy.result, lazy.visits]);

  const idle = playPark(23, { plan: { paths: [], rides: [], stalls: [], trees: [] } });
  console.log('LADDER idle park  -> result', idle.result, 'visits', idle.visits);
  ok(idle.result === 'season' && idle.visits === 0, 'an idle park closes the season empty', [idle.result, idle.visits]);

  // overbuilt and unconnected: upkeep eats the cash
  const built = C.newState(24);
  for (const [c, r] of C.PARK_PLAN.paths) C.placePath(built, c, r);
  for (const rd of C.PARK_PLAN.rides) C.placeRide(built, rd.kind, rd.c, rd.r);
  ok(built.rides.length === C.PARK_PLAN.rides.length, 'the bankrupt fixture has its rides', built.rides.length);
  // cut the spine so nobody can reach a ride, then leave the upkeep running
  ok(C.demolish(built, 7, 7) === 'ok', 'the spine can be cut');
  ok(!C.ridesReachable(built), 'a cut park cannot fill its rides');
  built.cash = 150;
  for (let i = 0; i < 4000 && !built.over; i++) C.step(built, 0.05);
  console.log('LADDER bankrupt   -> result', built.result, 'cash', Math.floor(built.cash), 't', built.t.toFixed(0));
  ok(built.result === 'bankrupt', 'a park drowning in upkeep goes bankrupt', built.result);

  const big = C.newState(25);
  C.applyPlan(big, C.PARK_PLAN);
  big.spent > C.START_CASH && console.log('WARN plan costs more than the starting cash', big.spent);
  ok(big.spent < C.START_CASH, 'the reference park is affordable from the start', [big.cash, big.spent]);
  ok(big.rides.length === C.PARK_PLAN.rides.length, 'every reference ride was placed', big.rides.length);
}

// ---- 10. determinism + the full-plan fixture the gate uses ----
{
  const one = C.newState(31); C.applyPlan(one, C.PARK_PLAN);
  const two = C.newState(31); C.applyPlan(two, C.PARK_PLAN);
  for (let i = 0; i < 1200; i++) { C.step(one, 0.05); C.step(two, 0.05); }
  ok(one.visits === two.visits && one.guests.length === two.guests.length,
    'the same seed deals the same park', [one.visits, two.visits]);

  const full = C.newState(41);
  const res = C.applyPlan(full, C.PARK_PLAN);
  ok(res.refused.length === 0, 'the reference park builds with nothing refused', res.refused);
  for (let i = 0; i < (C.SEASON + 40) * 20 && !full.over; i++) C.step(full, 0.05);
  console.log('FIXTURE full park -> result', full.result, 'visits', full.visits, 'rating', full.rating,
    'cash', Math.floor(full.cash), 't', full.t.toFixed(0));
  ok(full.result === 'win', 'the reference park wins inside one season', [full.result, full.visits, full.t]);
  ok(full.t < C.SEASON, 'the win lands before the season closes', full.t);
  ok(full.cash > 0, 'the winning park is still solvent', full.cash);
}

console.log(`\n${fails ? 'FAIL' : 'PASS'} openrct2 core: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
