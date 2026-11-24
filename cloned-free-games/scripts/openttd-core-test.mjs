#!/usr/bin/env node
// Proves the OpenTTD port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/openttd/index.html.
//
// Checks the industry chains, track/station placement rules, the rail path finder, the
// cargo match a train needs, a full hauling simulation (revenue rises, cargo is never
// double-spent), the win on the revenue target, the bankruptcy a dead line reaches, and
// that an empty board neither earns nor ends the game.
//
// usage: node openttd-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/openttd/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { W, H, CARGO, INDUSTRIES, TRACK_COST, STATION_COST, TRAIN_COST, START_CASH,
  WIN_REV, BANKRUPT, SPEED, LOAD_CAP, LOAD_TIME, STOCK_CAP, UPKEEP, NET_UPKEEP, START_STOCK,
  ck, inBoard, industryAt, hasTrack, stationIdxAt, newState, buildTrack, buildStation, stationCargo,
  railPath, buyTrain, deliver, step };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
};

const MINE = { c: 2, r: 2 }, POWER = { c: 11, r: 2 }, FARM = { c: 2, r: 7 }, MILL = { c: 11, r: 7 };
const ST_A = { c: 2, r: 3 }, ST_B = { c: 11, r: 3 };
const LINE = [];
for (let c = 3; c <= 10; c++) LINE.push([c, 3]);

function laid() {
  const S = C.newState();
  for (const [c, r] of LINE) C.buildTrack(S, c, r);
  const a = C.buildStation(S, ST_A.c, ST_A.r);
  const b = C.buildStation(S, ST_B.c, ST_B.r);
  return { S, a, b };
}

function run(S, seconds, dt = 1 / 60) {
  let t = 0;
  while (t < seconds && !S.over) { C.step(S, dt); t += dt; }
  return t;
}

// ---------- 1) industries ----------
ok(C.INDUSTRIES.length === 4, 'four industries', C.INDUSTRIES.length);
const cells = new Set();
for (const ind of C.INDUSTRIES) {
  ok(cells.has(C.ck(ind.c, ind.r)) === false, 'industry cells are unique', ind.id);
  cells.add(C.ck(ind.c, ind.r));
  ok(C.inBoard(ind.c, ind.r), `${ind.id} is on the board`, [ind.c, ind.r]);
  ok(!!C.CARGO[ind.cargo], `${ind.id} carries a known cargo`, ind.cargo);
  ok(ind.kind === 'produce' || ind.kind === 'accept', `${ind.id} has a kind`, ind.kind);
}
const producers = C.INDUSTRIES.filter(i => i.kind === 'produce');
const consumers = C.INDUSTRIES.filter(i => i.kind === 'accept');
ok(producers.length === 2 && consumers.length === 2, 'two producers, two consumers', [producers.length, consumers.length]);
for (const p of producers) {
  ok(consumers.some(x => x.cargo === p.cargo), `chain ${p.cargo} has a consumer`, p.id);
  ok(p.rate > 0, `${p.id} produces at a positive rate`, p.rate);
}
// the shipped fixture cells must be land, not industries
for (const st of [ST_A, ST_B]) ok(!C.industryAt(st.c, st.r), 'station fixture sits on land', st);

// ---------- 2) track rules ----------
{
  const S = C.newState();
  ok(Object.keys(S.tracks).length === 0, 'a new company owns no track');
  ok(S.cash === C.START_CASH, 'starts with the declared cash', S.cash);
  ok(C.buildTrack(S, MINE.c, MINE.r).ok === false, 'cannot lay track on an industry');
  ok(C.buildTrack(S, -1, 3).ok === false, 'cannot lay track off the board');
  ok(C.buildTrack(S, 3, 3).ok === true, 'lays track on empty land');
  ok(S.cash === C.START_CASH - C.TRACK_COST, 'track costs the declared price', S.cash);
  ok(C.buildTrack(S, 3, 3).ok === false, 'cannot lay track twice on one cell');
  const poor = C.newState(); poor.cash = C.BANKRUPT + 10;
  ok(C.buildTrack(poor, 5, 5).ok === false, 'the bank refuses credit past the limit');
}

// ---------- 3) stations ----------
{
  const S = C.newState();
  ok(C.buildStation(S, 5, 5).why === 'no-industry', 'a halt with no industry beside it is refused');
  ok(C.buildStation(S, MINE.c, MINE.r).why === 'industry', 'cannot build a halt on the mine itself');
  const a = C.buildStation(S, ST_A.c, ST_A.r);
  ok(a.ok, 'halt beside the mine is built', a);
  ok(S.stations[a.index].cargo === 'coal', 'mine halt ships coal', S.stations[a.index].cargo);
  ok(S.stations[a.index].accept === null, 'mine halt accepts nothing');
  const b = C.buildStation(S, ST_B.c, ST_B.r);
  ok(b.ok && S.stations[b.index].accept === 'coal', 'power halt accepts coal', S.stations[b.index]);
  ok(C.buildStation(S, ST_A.c, ST_A.r).why === 'station', 'two halts cannot share a cell');
  const viaTrack = C.newState();
  C.buildTrack(viaTrack, 5, 5);
  ok(C.buildStation(viaTrack, 5, 5).why === 'track', 'a halt cannot sit on laid track');
}

// ---------- 4) rail path ----------
{
  const bare = C.newState();
  ok(C.railPath(bare, { c: ST_A.c, r: ST_A.r }, { c: ST_B.c, r: ST_B.r }) === null, 'no track, no path');
  const { S, a, b } = laid();
  const path = C.railPath(S, S.stations[a.index], S.stations[b.index]);
  ok(!!path, 'a laid line yields a path');
  ok(path && path.length === LINE.length + 2, 'path runs station + every tile + station', path && path.length);
  ok(path && path[0].c === ST_A.c && path[path.length - 1].c === ST_B.c, 'path ends on the two halts', path && [path[0], path[path.length - 1]]);
}

// ---------- 5) train purchase ----------
{
  const { S, a, b } = laid();
  const wrong = C.newState();
  C.buildStation(wrong, ST_A.c, ST_A.r);           // mine halt
  C.buildStation(wrong, FARM.c, FARM.r + 1);       // farm halt
  for (let c = 3; c <= 10; c++) C.buildTrack(wrong, c, 8);
  ok(C.buyTrain(wrong, 0, 1).why === 'no-cargo-match', 'coal into a grain halt is refused', C.buyTrain(wrong, 0, 1));

  const noRail = C.newState();
  C.buildStation(noRail, ST_A.c, ST_A.r); C.buildStation(noRail, ST_B.c, ST_B.r);
  ok(C.buyTrain(noRail, 0, 1).why === 'no-rail', 'stations without rail cannot be served', C.buyTrain(noRail, 0, 1));
  ok(C.buyTrain(S, 0, 0).why === 'stations', 'a train needs two different stations');

  const before = S.cash;
  const res = C.buyTrain(S, a.index, b.index);
  ok(res.ok, 'a train is bought on a complete line', res);
  ok(S.cash === before - C.TRAIN_COST, 'train costs the declared price', S.cash);
  ok(S.trains.length === 1, 'one train on the roster');
  const t = S.trains[0];
  ok(t.cargo === 'coal', 'the train hauls the producer cargo', t.cargo);
  ok(t.path[0].c === ST_A.c, 'the run starts at the producing halt', t.path[0]);
}

// ---------- 6) hauling simulation ----------
{
  const { S, a, b } = laid();
  C.buyTrain(S, a.index, b.index);
  run(S, 40);
  ok(S.revenue > 0, 'the line earns revenue', S.revenue);
  ok(S.delivered > 0, 'cargo is delivered', S.delivered);
  ok(S.revenue === S.delivered * C.CARGO.coal.price, 'revenue is units x the coal price', [S.revenue, S.delivered]);
  ok(S.stock.mine >= 0, 'the mine stock never goes negative', S.stock.mine);
  ok(S.trains[0].load <= C.LOAD_CAP, 'a train never loads past its cap', S.trains[0].load);
  ok(S.trains[0].p >= 0 && S.trains[0].p <= S.trains[0].path.length - 1, 'the train stays on its line', S.trains[0].p);
  const first = S.revenue;
  run(S, 300);
  ok(S.result === 'win', 'a working coal line reaches the revenue target', [S.result, S.revenue]);
  ok(S.delivered >= C.LOAD_CAP * 3, 'the win takes several full hauls', S.delivered);
}

// ---------- 7) win on the revenue target ----------
{
  const { S, a, b } = laid();
  C.buyTrain(S, a.index, b.index);
  S.revenue = C.WIN_REV - 320;
  const elapsed = run(S, 120);
  ok(S.over === true, 'the game ends once the target is met', S.over);
  ok(S.result === 'win', 'and it is a win', S.result);
  ok(S.why === 'revenue', 'the win names the revenue target', S.why);
  ok(S.revenue >= C.WIN_REV, 'revenue passed the target', S.revenue);
  ok(elapsed < 120, 'the win arrives from play, not the safety loop', elapsed);
  const extra = JSON.parse(JSON.stringify(S));
  C.step(extra, 5);
  ok(extra.revenue === S.revenue, 'a finished company does not keep trading', extra.revenue);
}

// ---------- 8) bankruptcy on a dead line ----------
{
  const S = C.newState();
  for (const [c, r] of LINE) C.buildTrack(S, c, r);
  S.cash = 60;                                  // spent up: the network alone now drains it
  S.stock.mine = 0; S.stock.farm = 0;
  const rate = C.NET_UPKEEP * LINE.length;
  const elapsed = run(S, 200);
  ok(S.over === true, 'a dead line does not survive', S.over);
  ok(S.result === 'lose', 'and it is a loss', S.result);
  ok(S.why === 'bankrupt', 'the loss names bankruptcy', S.why);
  ok(S.cash < C.BANKRUPT, 'cash fell past the limit', S.cash);
  const predicted = (60 - C.BANKRUPT) / rate;
  ok(Math.abs(elapsed - predicted) < 3, 'the drain matches the network upkeep', [elapsed, predicted]);
}

// ---------- 9) empty board ----------
{
  const S = C.newState();
  const cash = S.cash;
  run(S, 300);
  ok(S.over === false, 'an empty board never ends on its own', S.over);
  ok(S.revenue === 0 && S.delivered === 0, 'an empty board earns nothing', [S.revenue, S.delivered]);
  ok(S.cash === cash, 'no track and no trains cost nothing', S.cash);
}

// ---------- 10) determinism ----------
{
  const A = laid(); C.buyTrain(A.S, A.a.index, A.b.index); run(A.S, 60);
  const B = laid(); C.buyTrain(B.S, B.a.index, B.b.index); run(B.S, 60);
  ok(A.S.revenue === B.S.revenue, 'the same company plays the same way twice', [A.S.revenue, B.S.revenue]);
}

// ---------- 11) a run a visitor can actually win ----------
{
  const { S, a, b } = laid();
  C.buyTrain(S, a.index, b.index);
  const spent = C.START_CASH - S.cash;
  ok(spent < C.START_CASH / 2 + 400, 'the standard line is affordable from the opening cash', spent);
  const secs = run(S, 240);
  ok(S.result === 'win', 'the opening cash buys a winning line', { result: S.result, revenue: S.revenue });
  ok(secs < 200, 'and it wins in good time', secs);
}

if (fails) { console.error(`FAILED ${fails} check(s)`); process.exit(1); }
console.log('OK openttd core: industries, placement, rail path, hauling, win, bankruptcy, empty board');
