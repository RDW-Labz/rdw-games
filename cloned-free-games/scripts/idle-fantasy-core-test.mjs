#!/usr/bin/env node
// Core test for the Idle Fantasy port. Slices the // >>>CORE block straight out of the shipped
// HTML and plays the exact economy the browser runs: prices that scale with the realm's levels,
// income with the market multiplier, barracks upkeep, the raid ladder, and three policies whose
// outcomes prove the realm is neither rigged nor winnable by ignoring half of it.
//
// usage: node idle-fantasy-core-test.mjs [path/to/index.html]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/idle-fantasy/index.html';
const html = await readFile(FILE, 'utf8');

const start = html.indexOf('// >>>CORE');
const end = html.indexOf('// <<<CORE');
if (start < 0 || end < 0) throw new Error('no CORE block');
const coreSrc = html.slice(start + '// >>>CORE'.length, end);

const tmp = '/tmp/idle-core/core-module.mjs';
await mkdir('/tmp/idle-core', { recursive: true });
await writeFile(tmp, coreSrc + '\nexport { PLOTS, RAIDS, RAID_SECS, STRENGTH, TAP_GOLD, START_GOLD, STEAL, UPKEEP, TYPES, TYPE_KEYS,' +
  ' mkState, levelsOf, costOf, incomeOf, mightOf, upkeepOf, strengthOf, end, buy, tapForge, step, raid };\n');
const M = await import(pathToFileURL(tmp).href);

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.log('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---- state and opening
const S0 = M.mkState();
ok(S0.gold === M.START_GOLD && S0.plots.length === M.PLOTS && S0.plots.every((p) => p === null),
  'a realm opens with the start gold and eight empty plots');
ok(M.RAIDS === 5 && M.STRENGTH.length >= M.RAIDS, 'five raids, each with a strength on the ladder');
ok(M.STRENGTH.every((s, i) => i === 0 || s > M.STRENGTH[i - 1]), 'the raid ladder climbs', M.STRENGTH);
ok(M.START_GOLD >= M.TYPES.barracks.cost, 'the opening treasury can raise a barracks before the first raid');

// ---- prices scale with the realm's levels of that kind, not with the plot
{
  const S = M.mkState(); S.gold = 5000;
  const first = M.costOf(S, 'mine');
  M.buy(S, 0, 'mine'); M.buy(S, 1, 'mine'); M.buy(S, 2, 'mine');
  const fourth = M.costOf(S, 'mine');
  ok(first === M.TYPES.mine.cost, 'the first mine costs its base price', first);
  ok(fourth === Math.round(M.TYPES.mine.cost * M.TYPES.mine.growth ** 3), 'the fourth mine costs growth^3', fourth);
  ok(fourth > first * 2, 'three mines in, the price has more than doubled', { first, fourth });
  const S2 = M.mkState(); S2.gold = 5000;
  M.buy(S2, 0, 'mine'); M.buy(S2, 0, 'mine'); M.buy(S2, 0, 'mine');
  ok(M.costOf(S2, 'mine') === fourth, 'stacking three levels on one plot costs the same as three plots', M.costOf(S2, 'mine'));
}

// ---- buying rules
{
  const S = M.mkState(); S.gold = 5000;
  const r1 = M.buy(S, 0, 'barracks');
  ok(r1.ok && S.gold === 5000 - M.TYPES.barracks.cost && M.mightOf(S) === 2, 'a barracks costs gold and adds might', r1);
  const r2 = M.buy(S, 0, 'barracks');
  ok(r2.ok && S.plots[0].lvl === 2 && M.mightOf(S) === 4, 'buying the same plot again upgrades it', S.plots[0]);
  const r3 = M.buy(S, 0, 'mine');
  ok(!r3.ok && r3.why === 'occupied', 'a plot already holding a barracks refuses a mine', r3);
  const S3 = M.mkState(); S3.gold = 1;
  const r4 = M.buy(S3, 0, 'barracks');
  ok(!r4.ok && r4.why === 'gold' && S3.gold === 1 && S3.plots[0] === null, 'a short treasury buys nothing', r4);
}

// ---- income and the market multiplier
{
  const S = M.mkState(); S.gold = 5000;
  M.buy(S, 0, 'mine'); M.buy(S, 1, 'mine');
  const plain = M.incomeOf(S);
  ok(Math.abs(plain - 2 * M.TYPES.mine.gps) < 1e-9, 'two mines pay twice the mine rate', plain);
  S.plots[2] = { type: 'market', lvl: 2 };
  const withMarket = M.incomeOf(S);
  ok(withMarket > plain, 'a market raises every mine it trades with', { plain, withMarket });
  ok(Math.abs(withMarket - (2 * M.TYPES.mine.gps + 2 * M.TYPES.market.gps) * (1 + 2 * M.TYPES.market.mult)) < 1e-9,
    'the multiplier is applied to the whole realm', { withMarket });
}

// ---- upkeep: an army eats
{
  const S = M.mkState(); S.gold = 5000;
  M.buy(S, 0, 'barracks'); M.buy(S, 1, 'barracks');
  ok(Math.abs(M.upkeepOf(S) - 2 * M.UPKEEP) < 1e-9, 'each barracks level costs its wage', M.upkeepOf(S));
  const T = M.mkState();
  T.gold = 1; T.plots[0] = { type: 'barracks', lvl: 2 };
  let ev = null, guard = 0;
  while (!T.over && guard++ < 4000) ev = M.step(T, 0.05);
  ok(T.over && T.result === 'lose' && T.why === 'coffers', 'a barracks with no mine behind it empties the vault', { why: T.why, gold: T.gold });
  ok(T.gold >= 0, 'the vault never reads negative', T.gold);
}

// ---- raids
{
  const S = M.mkState(); S.gold = 400;
  S.t = M.RAID_SECS - 0.01; S.nextRaidAt = M.RAID_SECS;
  const ev = M.step(S, 0.05);
  ok(ev && ev.raid === 1 && ev.need === M.STRENGTH[0], 'the first raid arrives at its strength', ev);
  ok(S.raids === 1 && S.over === false, 'an early realm survives the loot, it is not ended', { raids: S.raids, gold: S.gold });
  const gap = M.STRENGTH[0] - 0;
  ok(Math.abs(S.plundered - gap * M.STEAL) < 1e-9, 'raiders take gold per sword of the gap', S.plundered);
  const B = M.mkState();
  B.plots[0] = { type: 'barracks', lvl: 1 };
  B.t = M.RAID_SECS - 0.01; B.nextRaidAt = M.RAID_SECS;
  M.step(B, 0.05);
  ok(B.plundered === 0 && B.spared === 1, 'a manned wall pays no tribute', { plundered: B.plundered, spared: B.spared });
  const L = M.mkState();
  L.gold = 10; L.t = M.RAID_SECS - 0.01; L.nextRaidAt = M.RAID_SECS;
  const lev = M.step(L, 0.05);
  ok(L.over && L.result === 'lose' && L.why === 'sacked', 'a treasury too thin to pay the tribute ends the realm', { why: L.why });
}

// ---- policies: the whole point of the tuning
function play(policy, tapPerSec = 1.0, maxSeconds = 400) {
  const S = M.mkState();
  let tapAcc = 0, stepCount = 0;
  const dt = 0.05;
  while (!S.over && S.t < maxSeconds && stepCount++ < 40000) {
    tapAcc += dt * tapPerSec;
    if (tapAcc >= 1) { const n = Math.floor(tapAcc); tapAcc -= n; for (let i = 0; i < n; i++) M.tapForge(S); }
    for (let i = 0; i < 8; i++) {
      const act = policy(S, M);
      if (!act) break;
      const r = M.buy(S, act[0], act[1]);
      if (!r.ok) break;
    }
    M.step(S, dt);
  }
  return { result: S.result || 'timeout', why: S.why, t: +S.t.toFixed(1), gold: +S.gold.toFixed(1), raids: S.raids, might: M.mightOf(S) };
}
const firstEmpty = (S) => S.plots.indexOf(null);
function grow(S, M, type) {
  for (let i = 0; i < S.plots.length; i++) if (S.plots[i] && S.plots[i].type === type && S.gold >= M.costOf(S, type)) return [i, type];
  const e = firstEmpty(S);
  if (e >= 0 && S.gold >= M.costOf(S, type)) return [e, type];
  return null;
}
// A visitor who keeps the walls manned and the mines working.
const balanced = (S, M) => {
  if (M.mightOf(S) < M.strengthOf(S)) return grow(S, M, 'barracks');
  return grow(S, M, 'mine') || (S.gold > 3 * M.costOf(S, 'market') ? grow(S, M, 'market') : null);
};
const economyOnly = (S, M) => grow(S, M, 'mine') || (S.gold > 3 * M.costOf(S, 'market') ? grow(S, M, 'market') : null);
const armyOnly = (S, M) => grow(S, M, 'barracks');
const idle = () => null;

for (const tap of [1.0, 1.5, 2.0]) {
  const b = play(balanced, tap);
  ok(b.result === 'win' && b.raids === 5, `balanced play at ${tap} taps/s holds all five raids`, b);
}
{
  const e = play(economyOnly, 1.0);
  ok(e.result === 'lose', 'mines with no walls are plundered out', e);
  const p = play(idle, 1.0);
  ok(p.result === 'lose', 'tapping alone does not hold the realm', p);
  const a = play(armyOnly, 1.0);
  ok(a.result === 'lose', 'an army with no economy starves', a);
  ok(a.why === 'coffers' || a.why === 'sacked', 'the army-only run names its own cause', a.why);
}
// the win is not one tap rate's accident: it holds when the player taps fast as well as steadily
{
  const rich = play(balanced, 3.0);
  ok(rich.result === 'win' && rich.gold > 0, 'a rich hand (3 taps/s) also holds the realm', rich);
  ok(rich.t < 400, 'the winning run finishes with the raids, not on the clock', rich.t);
}

// ---- the state the port actually ships: PLOTS must match the eight plot positions
ok(M.PLOTS === 8, 'eight plots on the board', M.PLOTS);

console.log(fails ? `IDLE FANTASY CORE FAILED (${fails})` : 'IDLE FANTASY CORE PASS');
process.exit(fails ? 1 : 0);
