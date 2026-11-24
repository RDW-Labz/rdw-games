#!/usr/bin/env node
// Proves the Unciv port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/unciv/index.html.
//
// Map generation (both starts open, a land corridor between them on every seed, resources on
// open ground), movement costs and blocks, settling, tile yields, growth, science and the tech
// ladder, production and buying, combat (exchange, kill, no-retaliation archer, city capture),
// the win and both losses, the turn cap — then whole games played through the real rules: a
// settling, fighting pilot must take the rival capital on most seeds, a pilot that settles but
// never attacks must lose, and an idle pilot must lose.
//
// usage: node unciv-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/unciv/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { W, H, TILE, TERRAIN, RES, UNIT, TECHS, MAX_TURNS, CITY_HP, CITY_STR, BUY_COST, POP_CAP,
  START_P, START_R, NB8, inb, idx, tileAt, cheb, mulberry32, mkMap, mkState, addUnit, addCity,
  claim, refreshSeen, unitAt, cityAt, ownTile, cityTiles, yieldOf, cityScience, growAt, passable,
  reach, moveUnit, foundCity, setQueue, buyUnit, strengthOf, defenseOf, kill, capture, attack,
  cityTurn, research, bfsPath, connected, aiTarget, aiTurn, checkEnd, endTurn, freeHome };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
};
const P = (x, y) => ({ x, y });

// ---------- 1) map generation ----------
function mapConnected(S, a, b) {
  const N = C.W * C.H, seen = new Array(N).fill(false);
  const start = a.y * C.W + a.x;
  const q = [start]; seen[start] = true;
  while (q.length) {
    const i = q.shift(), x = i % C.W, y = (i - x) / C.W;
    for (const [dx, dy] of C.NB8) {
      const nx = x + dx, ny = y + dy;
      if (!C.inb(nx, ny)) continue;
      const ni = ny * C.W + nx;
      if (seen[ni] || C.TERRAIN[S.tiles[ni].t].move === 0) continue;
      seen[ni] = true; q.push(ni);
    }
  }
  return seen[b.y * C.W + b.x];
}
let connectedSeeds = 0, resCount = 0, waterCount = 0;
const SEEDS = 60;
for (let seed = 1; seed <= SEEDS; seed++) {
  const S = C.mkState(seed);
  const sp = S.tiles[C.idx(C.START_P.x, C.START_P.y)];
  const rp = S.tiles[C.idx(C.START_R.x, C.START_R.y)];
  ok(C.TERRAIN[sp.t].move > 0, `seed ${seed}: player start is settle-able`, sp.t);
  ok(C.TERRAIN[rp.t].move > 0, `seed ${seed}: rival capital is on open ground`, rp.t);
  if (mapConnected(S, C.START_P, C.START_R)) connectedSeeds++;
  else console.error('  FAIL seed ' + seed + ': starts are walled off');
  const nb = C.NB8.filter(([dx, dy]) => C.inb(C.START_P.x + dx, C.START_P.y + dy)
    && C.TERRAIN[S.tiles[C.idx(C.START_P.x + dx, C.START_P.y + dy)].t].move > 0);
  ok(nb.length >= 3, `seed ${seed}: player start has room to expand`, nb.length);
  const me = S.units.filter((u) => u.side === 0);
  ok(me.length === 2 && me.some((u) => u.kind === 'settler') && me.some((u) => u.kind === 'warrior'),
    `seed ${seed}: opens with a settler and a warrior`, me.map((u) => u.kind));
  const rival = S.cities.filter((c) => c.side === 1);
  ok(rival.length === 1 && rival[0].capital, `seed ${seed}: rival holds one capital`, rival.length);
  ok(S.units.filter((u) => u.side === 1).length === 1, `seed ${seed}: rival has one garrison`);
  resCount += S.tiles.filter((t) => t.res > 0).length;
  waterCount += S.tiles.filter((t) => t.t === C.TILE.WATER).length;
  ok(S.tiles.filter((t) => t.res > 0).length >= 4, `seed ${seed}: resources are placed`, S.tiles.filter((t) => t.res > 0).length);
}
ok(connectedSeeds === SEEDS, 'every seed has a passable corridor between the capitals', connectedSeeds);
ok(resCount / SEEDS >= 6, 'roughly seven resource tiles per map', resCount / SEEDS);
ok(waterCount === 3 * SEEDS, 'three coast tiles per map', waterCount / SEEDS);

// ---------- 2) movement ----------
{
  const S = C.mkState(3);
  const u = S.units.find((v) => v.kind === 'warrior' && v.side === 0);
  ok(u.moves === 2, 'a warrior starts with 2 moves', u.moves);
  const reachable = C.reach(S, u);
  let flat = null;
  for (let y = 0; y < C.H; y++) for (let x = 0; x < C.W; x++) {
    const i = C.idx(x, y);
    if (x === u.x && y === u.y) continue;
    if (Number.isFinite(reachable[i])) flat = { x, y, i };
  }
  ok(!!flat, 'the warrior can reach something on turn 1');
  if (flat) {
    ok(C.moveUnit(S, u, flat.x, flat.y) === true, 'a reachable tile is a legal move');
    ok(u.x === flat.x && u.y === flat.y, 'the unit actually stands there', [u.x, u.y]);
    ok(u.moves < 2, 'the move spends movement points', u.moves);
  }
  // mountains and water are never legal — plant one of each so the fixture never depends on luck
  S.tiles[C.idx(0, 6)].t = C.TILE.MOUNT;
  const mount = { x: 0, y: 6 };
  let water = null;
  for (let y = 0; y < C.H && !water; y++) for (let x = 0; x < C.W; x++) {
    if (S.tiles[C.idx(x, y)].t === C.TILE.WATER) water = { x, y };
  }
  ok(C.passable(S, 0, mount.x, mount.y) === false, 'mountains are impassable', mount);
  ok(!!water && C.passable(S, 0, water.x, water.y) === false, 'coast is impassable', water);
  if (mount) {
    const before = { x: u.x, y: u.y };
    ok(C.moveUnit(S, u, mount.x, mount.y) === false, 'a mountain move is refused');
    ok(u.x === before.x && u.y === before.y, 'a refused move does not teleport the unit');
  }
  // a friendly unit blocks its tile
  const other = S.units.find((v) => v !== u && v.side === 0);
  if (other) ok(C.moveUnit(S, u, other.x, other.y) === false, 'cannot walk onto a friendly unit');
  // a second move past the budget is refused
  const far = { x: C.START_R.x, y: C.START_R.y };
  const u2 = C.addUnit(S, 0, 'warrior', 4, 4);
  u2.moves = 1;
  ok(C.moveUnit(S, u2, far.x, far.y) === false, 'a far tile costs more than the budget');
  // an archer sees two tiles for attacks but one move costs the same
  ok(C.UNIT.archer.ranged === 2, 'archers shoot at range 2');
}

// ---------- 3) settling ----------
{
  const S = C.mkState(5);
  const set = S.units.find((u) => u.kind === 'settler');
  const tx = set.x, ty = set.y;
  ok(C.foundCity(S, set) === true, 'a settler founds a city');
  const city = C.cityAt(S, tx, ty);
  ok(!!city && city.side === 0, 'the city belongs to the player', city && city.side);
  ok(city.capital === true, 'the first city is the capital');
  ok(!S.units.includes(set), 'the settler is consumed');
  ok(S.tiles[C.idx(tx, ty)].own === 0, 'the city tile is claimed');
  const claimed = S.tiles.filter((t) => t.cid === city.id).length;
  ok(claimed >= 5, 'the city claims its ring', claimed);
  ok(C.foundCity(S, C.addUnit(S, 0, 'warrior', 2, 5)) === false, 'a warrior cannot found a city');
  // founding on top of a city is refused
  ok(C.foundCity(S, C.addUnit(S, 0, 'settler', tx, ty)) === false, 'no second city on the same tile');
}

// ---------- 4) yields, growth, science ----------
{
  const S = C.mkState(11);
  const set = S.units.find((u) => u.kind === 'settler');
  C.foundCity(S, set);
  const city = S.cities.find((c) => c.side === 0);
  const y = C.yieldOf(S, city);
  ok(y.f + y.p + y.g > 0, 'a city works something', y);
  const food0 = city.food;
  C.cityTurn(S, city);
  ok(city.food === Math.max(0, y.f - city.pop) || city.pop > 1, 'the city eats and stores food', { food0, food: city.food, y });
  ok(S.sides[0].sci >= 1, 'a city produces science', S.sides[0].sci);
  // enough food grows the population
  city.food = 100;
  C.cityTurn(S, city);
  ok(city.pop >= 2, 'stored food grows the city', city.pop);
  // science unlocks a tech at its cost
  S.sides[0].sci = C.TECHS[0].cost - 1;
  ok(C.research(S, 0) === null, 'a tech needs its full cost');
  S.sides[0].sci = C.TECHS[0].cost;
  const got = C.research(S, 0);
  ok(got && got.id === 'archery', 'science unlocks Archery', got && got.id);
  ok(S.sides[0].techs.includes('archery'), 'the tech sticks');
  ok(S.sides[0].sci < C.TECHS[0].cost, 'the cost is spent', S.sides[0].sci);
}

// ---------- 5) production + buying ----------
{
  const S = C.mkState(13);
  C.foundCity(S, S.units.find((u) => u.kind === 'settler'));
  const city = S.cities.find((c) => c.side === 0);
  ok(C.setQueue(S, city.id, 'archer') === false, 'archers are locked before Archery');
  ok(C.setQueue(S, city.id, 'warrior') === true, 'warriors can be queued');
  const before = S.units.filter((u) => u.side === 0).length;
  let turns = 0;
  while (S.units.filter((u) => u.side === 0).length === before && turns < 20) { C.cityTurn(S, city); turns++; }
  ok(S.units.filter((u) => u.side === 0).length === before + 1, 'production eventually spawns a warrior', turns);
  const spawned = S.units.filter((u) => u.side === 0).slice(-1)[0];
  ok(spawned.moves === 0, 'a freshly built unit has not moved yet', spawned.moves);
  ok(turns >= 2 && turns <= 12, 'the cost is neither trivial nor out of reach', turns);
  S.sides[0].techs.push('archery');
  ok(C.setQueue(S, city.id, 'archer') === true, 'Archery unlocks the archer queue');
  // gold buys a unit only with enough coin
  S.sides[0].gold = C.BUY_COST - 1;
  ok(C.buyUnit(S, city.id).ok === false, 'buying needs full gold');
  S.sides[0].gold = C.BUY_COST + 5;
  const n0 = S.units.filter((u) => u.side === 0).length;
  const b = C.buyUnit(S, city.id);
  ok(b.ok === true && S.units.filter((u) => u.side === 0).length === n0 + 1, 'gold buys a warrior', b);
  ok(S.sides[0].gold === 5, 'the gold is spent', S.sides[0].gold);
}

// ---------- 6) combat ----------
{
  const S = C.mkState(17);
  C.foundCity(S, S.units.find((u) => u.kind === 'settler'));
  const city = S.cities.find((c) => c.side === 0);
  S.units = S.units.filter((u) => u.side === 0);
  const a = C.addUnit(S, 0, 'warrior', city.x + 1, city.y);
  const d = C.addUnit(S, 1, 'warrior', city.x + 2, city.y);
  const hpD = d.hp, hpA = a.hp;
  const r = C.attack(S, a, d.x, d.y);
  ok(r.ok === true, 'an adjacent enemy is attackable', r);
  ok(d.hp < hpD, 'the defender takes damage', d.hp);
  ok(a.hp <= hpA, 'the attacker takes some too', a.hp);
  ok(r.toDef > 0 && r.toAtk >= 0, 'the exchange is reported', r);
  ok(a.moves === 0, 'attacking spends the turn', a.moves);
  ok(C.attack(S, C.addUnit(S, 0, 'warrior', city.x, city.y), d.x, d.y + 3).ok === false, 'out of range is refused');
  // a kill removes the unit
  d.hp = 1;
  const a2 = C.addUnit(S, 0, 'warrior', d.x - 1, d.y); a2.moves = 2;
  const r2 = C.attack(S, a2, d.x, d.y);
  ok(r2.ok && !S.units.includes(d), 'a lethal hit removes the defender', r2);
  // archers do not get hit back
  const ar = C.addUnit(S, 0, 'archer', city.x + 1, city.y + 1);
  const foe = C.addUnit(S, 1, 'warrior', city.x + 3, city.y + 1);
  const arHp = ar.hp, foeHp = foe.hp;
  const r3 = C.attack(S, ar, foe.x, foe.y);
  ok(r3.ok && r3.ranged === true, 'an archer attacks at range 2', r3);
  ok(ar.hp === arHp, 'no retaliation at range', { arHp, now: ar.hp });
  ok(foe.hp < foeHp, 'the ranged shot lands', foe.hp);
  // city defence and capture
  const S2 = C.mkState(19);
  C.foundCity(S2, S2.units.find((u) => u.kind === 'settler'));
  const rcity = S2.cities.find((c) => c.side === 1);
  const w = C.addUnit(S2, 0, 'warrior', rcity.x - 1, rcity.y);
  w.moves = 2;
  const cHp = rcity.hp;
  const r4 = C.attack(S2, w, rcity.x, rcity.y);
  ok(r4.ok && r4.target === 'city', 'a city is a target', r4);
  ok(rcity.hp < cHp, 'the city loses hit points', rcity.hp);
  ok(w.hp < 20, 'taking a city costs the attacker blood', w.hp);
  rcity.hp = 2;
  const w2 = C.addUnit(S2, 0, 'warrior', rcity.x - 1, rcity.y); w2.moves = 2;
  const r5 = C.attack(S2, w2, rcity.x, rcity.y);
  ok(r5.ok && rcity.side === 0, 'a broken city changes hands', rcity.side);
  ok(S2.over === true && S2.result === 'win', 'taking the rival capital wins', { over: S2.over, result: S2.result });
  ok(S2.tiles[C.idx(rcity.x, rcity.y)].own === 0, 'captured ground changes owner');
}

// ---------- 7) the losses ----------
{
  // rival takes your capital
  const S = C.mkState(23);
  C.foundCity(S, S.units.find((u) => u.kind === 'settler'));
  const cap = S.cities.find((c) => c.side === 0 && c.capital);
  cap.hp = 3;
  // nothing else of the player's is in reach, so the rival must go for the city itself
  S.units = S.units.filter((u) => u.side !== 0);
  const foe = C.addUnit(S, 1, 'warrior', cap.x + 1, cap.y);
  foe.moves = 2;
  C.endTurn(S);
  ok(S.over === true && S.result === 'lose', 'losing the capital loses the game', { over: S.over, result: S.result, why: S.why });
  ok(cap.side === 1, 'the AI actually took it', cap.side);
  ok(/capital/i.test(S.why), 'the loss names the cause', S.why);
  // the turn cap
  const S2 = C.mkState(29);
  C.foundCity(S2, S2.units.find((u) => u.kind === 'settler'));
  S2.turn = C.MAX_TURNS;
  C.endTurn(S2);
  ok(S2.over === true && S2.result === 'lose' && /age/i.test(S2.why), 'the age ends the game', { why: S2.why, turn: S2.turn });
}

// ---------- 8) whole games through the real rules ----------
function target(S, u) {
  const cap = S.cities.find((c) => c.side === 1 && c.capital);
  const foe = S.units.filter((v) => v.side === 1).sort((a, b) => C.cheb(u, a) - C.cheb(u, b))[0];
  if (foe && C.cheb(u, foe) <= 1) return foe;
  return cap || foe || null;
}
function play(seed, { settle = true, fight = true, buy = false } = {}) {
  const S = C.mkState(seed);
  let guard = 0;
  while (!S.over && guard++ < 160) {
    if (settle) {
      const st = S.units.find((u) => u.side === 0 && u.kind === 'settler');
      if (st) C.foundCity(S, st);
    }
    for (const c of S.cities.filter((c) => c.side === 0)) {
      const want = S.sides[0].techs.includes('archery') && c.id % 2 === 0 ? 'archer' : 'warrior';
      if (c.queue !== want) C.setQueue(S, c.id, want);
      if (buy) C.buyUnit(S, c.id);
    }
    if (fight) {
      for (const u of S.units.filter((v) => v.side === 0 && v.kind !== 'settler' && v.moves > 0).sort((a, b) => a.id - b.id)) {
        let g2 = 0;
        while (!S.over && u.moves > 0 && g2++ < 8) {
          const t = target(S, u);
          if (!t) break;
          if (C.cheb(u, t) <= (C.UNIT[u.kind].ranged || 1)) {
            if (!C.attack(S, u, t.x, t.y).ok) break;
            continue;
          }
          const p = C.bfsPath(S, 0, u.x, u.y, t.x, t.y);
          if (!p || p.length < 2) break;
          const step = p[1];
          if (!C.moveUnit(S, u, step.x, step.y)) break;
        }
      }
    }
    if (S.over) break;
    C.endTurn(S);
  }
  return S;
}

let wins = 0, settleOnlyWins = 0, idleWins = 0, longest = 0;
const GAMES = 24;
for (let seed = 1; seed <= GAMES; seed++) {
  const w = play(seed, { settle: true, fight: true, buy: true });
  if (w.result === 'win') { wins++; longest = Math.max(longest, w.turn); }
  const so = play(seed, { settle: true, fight: false });
  if (so.result === 'win') settleOnlyWins++;
  const idle = play(seed, { settle: false, fight: false });
  if (idle.result === 'win') idleWins++;
}
ok(wins >= GAMES * 0.7, 'a settling, fighting pilot takes the capital on most seeds', { wins, GAMES });
ok(longest > 0 && longest <= C.MAX_TURNS, 'wins land inside the age limit', longest);
ok(settleOnlyWins === 0, 'settling without attacking never wins', settleOnlyWins);
ok(idleWins === 0, 'an idle player never wins', idleWins);

// the shipped opening is playable: the settler can settle and the warrior can move on turn 1
{
  const S = C.mkState(31);
  const st = S.units.find((u) => u.side === 0 && u.kind === 'settler');
  ok(S.seen[0][C.idx(st.x, st.y)] === 2, 'the opening tiles are scouted');
  ok(S.seen[0].filter((v) => v === 0).length > 30, 'most of the map starts in fog', S.seen[0].filter((v) => v === 0).length);
}

console.log(JSON.stringify({
  seeds: SEEDS, wins, games: GAMES, settleOnlyWins, idleWins, longestWinTurn: longest,
  connectedSeeds, avgResources: +(resCount / SEEDS).toFixed(2),
}, null, 0));
if (fails) { console.error('CORE FAIL (' + fails + ')'); process.exit(1); }
console.log('CORE PASS');
