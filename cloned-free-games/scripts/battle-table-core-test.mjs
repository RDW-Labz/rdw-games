#!/usr/bin/env node
// Proves the Battle Table engine with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/battle-table/index.html.
//
// usage: node battle-table-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/battle-table/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { UNIT, FIRE, DIE, GARRISONS, BUDGET, KEYS, costOf, diceOf, typeCount, mkHp, runBattle, mulberry32, survivorsOf, hpOf, countOf, holdsGround, MAXPER };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  UNIT, FIRE, DIE, GARRISONS, BUDGET, KEYS, costOf, diceOf, typeCount, mkHp,
  runBattle, mulberry32, survivorsOf, hpOf, countOf, holdsGround, MAXPER,
} = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };
const pct = (x) => (x * 100).toFixed(0) + '%';

// ---------- 1. the tables themselves ----------
ok(KEYS.length === 9, 'expected 9 unit types');
ok(DIE.length === 12, 'the die must have 12 faces');
const bands = [0, 0, 0, 0, 0, 0];
for (const f of DIE) bands[f]++;
ok(bands.join(',') === '4,3,2,1,1,1', 'die banding must be 4-3-2-1-1-1, got ' + bands.join(','));
ok(Object.values(UNIT).every((u) => u.hpOff > 0 && u.hpDef > 0 && u.cost > 0), 'every unit needs hp and a cost');
// a unit whose offensive ground dice are zero is legal (a bomber only bombs from the defensive
// posture), but it must still be able to fire in SOME stance
ok(Object.keys(UNIT).every((k) => FIRE[k].gnd[0] > 0 || FIRE[k].gnd[1] > 0),
  'every unit must fire in at least one stance');

// defensive posture always buys durability and always costs dice somewhere
for (const k of KEYS) {
  ok(UNIT[k].hpDef >= UNIT[k].hpOff, `${k}: defensive stance must not be softer than offensive`);
}
ok(FIRE.FGT.air[1] > FIRE.FGT.air[0], 'a dug-in fighter must fly the anti-air dice');
ok(FIRE.ARM.gnd[0] > FIRE.ARM.gnd[1], 'armour must trade dice for hit points when it entrenches');

// ---------- 2. bookkeeping ----------
const roster = { INF: 2, ARM: 1, FGT: 1 };
ok(costOf(roster) === 2 * 1 + 3 + 3, 'cost arithmetic');
ok(countOf(mkHp(roster, 'off'), 'INF', 'off') === 2, 'count round-trips in offensive stance');
ok(countOf(mkHp(roster, 'def'), 'INF', 'def') === 2, 'count round-trips in defensive stance');
ok(diceOf(mkHp({ ARM: 2 }, 'off'), 'off', 'gnd') === 8, 'armour in the open fires 4 dice each');
ok(diceOf(mkHp({ ARM: 2 }, 'def'), 'def', 'gnd') === 4, 'entrenched armour fires 2 each');
ok(typeCount(mkHp({ FGT: 4, BOM: 2 }, 'off'), 'off') === 0, 'air alone is not a force-advantage type');
ok(typeCount(mkHp({ INF: 1, ARM: 1, CRS: 1 }, 'off'), 'off') === 3, 'land+sea types count');

// ---------- 3. an empty force can never win ----------
{
  const empty = { roster: {}, stance: 'off' };
  let wins = 0;
  for (let s = 0; s < 200; s++) {
    const r = runBattle(empty, { roster: GARRISONS[0].roster, stance: 'off' }, mulberry32(s));
    if (r.outcome === 'win') wins++;
  }
  ok(wins === 0, 'an empty attacker must never win, won ' + wins + '/200');
}

// ---------- 4. determinism ----------
{
  const a = { roster: { INF: 4, ART: 2, ARM: 2, FGT: 1 }, stance: 'off' };
  const d = { roster: GARRISONS[1].roster, stance: 'off' };
  const r1 = runBattle(a, d, mulberry32(4242));
  const r2 = runBattle(a, d, mulberry32(4242));
  ok(JSON.stringify(r1.outcome) === JSON.stringify(r2.outcome), 'same seed must give the same outcome');
  ok(JSON.stringify(r1.aRoster) === JSON.stringify(r2.aRoster), 'same seed must give the same survivors');
  ok(r1.rounds.length === 6, 'a battle is 3 air + 3 ground rounds, got ' + r1.rounds.length);
}

// ---------- 5. survivors can never exceed what was committed ----------
{
  for (let s = 0; s < 100; s++) {
    const a = { roster: { INF: 3, ARM: 2, FGT: 2 }, stance: s % 2 ? 'def' : 'off' };
    const r = runBattle(a, { roster: GARRISONS[1].roster, stance: 'off' }, mulberry32(s));
    for (const k of KEYS) {
      ok((r.aRoster[k] || 0) <= (a.roster[k] || 0) + (k === 'SUB' ? 1 : 0),
        `seed ${s}: ${k} survivors exceed the committed force`);
    }
  }
}

// ---------- 6. force advantage turns wild dice into kills ----------
{
  // same points, same dice: breadth should beat a single stack at the same cost
  const broad = { roster: { INF: 4, ART: 3, ARM: 2 }, stance: 'off' };     // 4+6+6 = 16
  const narrow = { roster: { INF: 1, ARM: 5 }, stance: 'off' };            // 1+15 = 16
  const d = { roster: GARRISONS[1].roster, stance: GARRISONS[1].stance };
  let bw = 0, nw = 0;
  for (let s = 0; s < 400; s++) {
    if (runBattle(broad, d, mulberry32(s)).outcome === 'win') bw++;
    if (runBattle(narrow, d, mulberry32(s)).outcome === 'win') nw++;
  }
  console.log(`  breadth check vs the brigade: broad ${pct(bw / 400)} vs narrow ${pct(nw / 400)}`);
  ok(bw > nw + 12, 'a broad force on the same points should out-fight a single stack', { broad: bw, narrow: nw });
  ok(bw > 40, 'a broad force must actually be able to win');

  // the advantage itself: three types against one the defender can field
  const r = runBattle({ roster: { INF: 2, ART: 2, ARM: 2 }, stance: 'off' },
    { roster: { INF: 4 }, stance: 'off' }, mulberry32(7));
  ok(r.advantage.a === true && r.advantage.b === false, 'only the broader force holds the advantage', r.advantage);
  ok(r.diff === 2, 'a three-to-one type gap is a two-type advantage', r.diff);
}

// ---------- 7. every outcome in the taxonomy is reachable ----------
{
  const seen = new Set();
  const probes = [
    { roster: { INF: 1 }, stance: 'off' },
    { roster: { INF: 8, ARM: 8 }, stance: 'def' },
    { roster: { INF: 6 }, stance: 'off' },
    { roster: { FGT: 6, BOM: 4, INF: 2 }, stance: 'off' },
    { roster: { SUB: 3, CRS: 2, BS: 1 }, stance: 'off' },
  ];
  for (const p of probes) for (let s = 0; s < 120; s++) {
    for (let g = 0; g < GARRISONS.length; g++) {
      seen.add(runBattle(p, { roster: GARRISONS[g].roster, stance: GARRISONS[g].stance }, mulberry32(s)).outcome);
    }
  }
  console.log('  outcomes seen:', [...seen].join(', '));
  for (const o of ['win', 'loss']) ok(seen.has(o), `outcome "${o}" must be reachable`);
  ok(seen.has('draw') || seen.has('mutual'), 'a contested result must be reachable');
}

// ---------- 8. the campaign is winnable and losable with the shipped budget ----------
function campaignRate(rosterKeys, stance) {
  // muster a fixed roster and run the three objectives, survivors carrying over
  const build = {};
  for (const k of KEYS) build[k] = 0;
  for (const k of rosterKeys) build[k] = (build[k] || 0) + 1;
  let take = 0;
  const N = 200;
  for (let s = 0; s < N; s++) {
    let cur = { ...build }, won = 0, lost = 0;
    for (let b = 0; b < 3 && won < 2 && lost < 2; b++) {
      const g = GARRISONS[b];
      const r = runBattle({ roster: cur, stance }, { roster: g.roster, stance: g.stance }, mulberry32(900 + s * 31 + b));
      if (r.outcome === 'win') won++; else lost++;
      cur = r.aRoster;
      if (KEYS.every((k) => !cur[k])) cur.INF = 2;
    }
    if (won >= 2) take++;
  }
  return take / N;
}
console.log('\n  campaign win rate by muster (budget ' + BUDGET + '):');
const samples = [
  ['balanced', ['INF', 'INF', 'INF', 'INF', 'ART', 'ART', 'ARM', 'ARM', 'FGT', 'FGT', 'BOM'], 'off'],
  ['balanced-def', ['INF', 'INF', 'INF', 'INF', 'ART', 'ART', 'ARM', 'ARM'], 'def'],
  ['infantry swarm', ['INF', 'INF', 'INF', 'INF', 'INF', 'INF', 'INF', 'INF'], 'off'],
  ['armour only', ['ARM', 'ARM', 'ARM', 'ARM', 'ARM'], 'off'],
  ['air only', ['FGT', 'FGT', 'FGT', 'BOM', 'BOM'], 'off'],
  ['sea', ['SUB', 'CRS', 'CRS', 'BS', 'BS'], 'off'],
];
const rates = {};
for (const [name, keys, stance] of samples) {
  const cost = keys.reduce((s, k) => s + UNIT[k].cost, 0);
  const r = campaignRate(keys, stance);
  rates[name] = r;
  console.log(`    ${name.padEnd(15)} cost ${String(cost).padStart(2)}/${BUDGET}  take-the-area ${pct(r)}`);
}
ok(rates.balanced > 0.55, 'a well-composed muster must take the area more often than not');
ok(rates['air only'] === 0, 'air alone can never hold ground, so it must never take an area');
ok(rates['infantry swarm'] < 0.2, 'a one-type swarm must lose to combined arms');

// ---------- 9. subs escape at one hit point ----------
{
  let escapes = 0;
  for (let s = 0; s < 300; s++) {
    const r = runBattle({ roster: { SUB: 2, INF: 1 }, stance: 'off' }, { roster: { BS: 3, INF: 2 }, stance: 'off' }, mulberry32(s));
    if (r.aEsc || r.bEsc) escapes++;
  }
  ok(escapes > 0, 'a damaged submarine must be able to escape');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nOK: tables, bookkeeping, determinism, force advantage, outcomes and campaign tuning all hold.');
process.exit(fails ? 1 : 0);
