#!/usr/bin/env node
// Proves the Wesnoth port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/wesnoth/index.html.
//
// Checks the field (77 hexes, one connected landmass, a keep and castle ring on each side),
// movement (terrain costs, water unenterable, bodies block hexes), villages (capture, income, mend),
// combat (dodge chance follows the defender's ground, one retaliation, ranged troops take none at
// range 2, a fallen leader ends the war), recruitment, the turn cycle, the cpu's turn, and a
// two-policy campaign ladder: an idle visitor always loses, an aggressive visitor wins some.
//
// usage: node wesnoth-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/wesnoth/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE\n([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { W, H, DIRS, KEY, TER, WALL, MAP, KINDS, mulberry32, rand, at, unitAt, sideUnits, hexDist,
  passable, mkUnit, mkState, reach, pathTo, moveUnit, canAttack, rollStrikes, kill, attack, income,
  villageCount, keepOf, freeCastle, recruit, beginTurn, verdict, pickTarget, actStep, aiRecruit,
  aiTurn, chargeTurn, runCampaign };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const K = C.KEY;
const tilesOf = (S) => [...S.T.values()];
const freeTile = (S, pred) => tilesOf(S).find((t) => C.passable(t) && (!pred || pred(t)));

// a duel fixture: two units on the map, `dist` hexes apart, no other bodies
function duel(kindA, kindB, dist, seed = 11) {
  const S = C.mkState(seed);
  S.units = [];
  let A = null, B = null;
  outer: for (const t of tilesOf(S)) {
    if (!C.passable(t)) continue;
    for (const n of tilesOf(S)) {
      if (n === t || !C.passable(n)) continue;
      if (C.hexDist(t, n) === dist) { A = t; B = n; break outer; }
    }
  }
  const a = C.mkUnit(0, kindA, A.q, A.r); a.id = 1;
  const b = C.mkUnit(1, kindB, B.q, B.r); b.id = 2;
  S.units.push(a, b);
  return { S, a, b };
}

// ---------- 1) the field ----------
console.log('-- field');
{
  const S = C.mkState(20261127);
  const tiles = tilesOf(S);
  ok(tiles.length === C.W * C.H, 'the field is 11x7 = 77 hexes', tiles.length);
  ok(C.MAP.every((r) => r.length === C.W), 'every map row is 11 columns', C.MAP.map((r) => r.length));
  ok(new Set(tiles.map((t) => K(t.q, t.r))).size === tiles.length, 'no duplicate hexes');

  let asym = 0;
  for (const t of tiles) {
    for (const [dq, dr] of C.DIRS) {
      const n = C.at(S, t.q + dq, t.r + dr);
      if (!n) continue;
      if (!C.DIRS.some(([bq, br]) => n.q + bq === t.q && n.r + br === t.r)) asym++;
    }
  }
  ok(asym === 0, 'hex adjacency is symmetric', asym);

  const land = tiles.filter((t) => C.passable(t));
  const seen = new Set([K(land[0].q, land[0].r)]);
  const stack = [land[0]];
  while (stack.length) {
    const cur = stack.pop();
    for (const [dq, dr] of C.DIRS) {
      const n = C.at(S, cur.q + dq, cur.r + dr);
      if (!n || !C.passable(n)) continue;
      const k = K(n.q, n.r);
      if (!seen.has(k)) { seen.add(k); stack.push(n); }
    }
  }
  ok(seen.size === land.length, 'every land hex is reachable by land (no sealed pocket)', { reached: seen.size, land: land.length });
  ok(tiles.some((t) => t.t === 'w'), 'the map has water to force a route choice');
  ok(tiles.filter((t) => t.t === 'v').length === 4, 'four villages sit between the keeps');
  ok(tiles.filter((t) => t.t === 'h' || t.t === 'f').length >= 10, 'the field has cover to fight over');

  const mk = C.keepOf(S, 0), ek = C.keepOf(S, 1);
  ok(mk && mk.keep === 0 && ek && ek.keep === 1, 'each side owns a keep', { mine: !!mk, theirs: !!ek });
  ok(mk.row === 6 && ek.row === 0, 'the keeps sit on opposite edges', { mine: mk.row, theirs: ek.row });
  for (const [side, kp] of [[0, mk], [1, ek]]) {
    const ring = C.DIRS.map(([dq, dr]) => C.at(S, kp.q + dq, kp.r + dr)).filter((t) => t && t.t === 'c');
    ok(ring.length >= 3, 'the keep of side ' + side + ' has castle hexes to recruit on', ring.length);
  }
}

// ---------- 2) boot position ----------
console.log('-- boot');
{
  const S = C.mkState(20261127);
  ok(S.turn === 0, 'the visitor moves first');
  ok(S.round === 1, 'the first round is round 1', S.round);
  ok(S.gold[0] === 24 && S.gold[1] === 22, 'the purses open at 24 / 22 (level once both bank income)', S.gold);
  const mine = C.sideUnits(S, 0), theirs = C.sideUnits(S, 1);
  ok(mine.length === 3 && theirs.length === 3, 'three troops a side', { mine: mine.length, theirs: theirs.length });
  ok(mine.some((u) => u.kind === 'commander') && theirs.some((u) => u.kind === 'warlord'), 'each side fields its leader');
  const cmd = mine.find((u) => u.kind === 'commander');
  ok(cmd.q === C.keepOf(S, 0).q && cmd.r === C.keepOf(S, 0).r, 'the Commander stands on your keep');
  let closest = 99;
  for (const a of mine) for (const b of theirs) closest = Math.min(closest, C.hexDist(a, b));
  ok(closest > 2, 'no enemy starts within striking distance (no instant loss)', closest);
  ok(C.verdict(S) === null && S.over === false, 'the game is live at boot');
  ok(new Set(S.units.map((u) => K(u.q, u.r))).size === S.units.length, 'no two units share a hex');
  ok(S.units.every((u) => C.passable(C.at(S, u.q, u.r))), 'every unit stands on passable ground');
  const ids = S.units.map((u) => u.id);
  ok(new Set(ids).size === ids.length, 'unit ids are unique', ids);
}

// ---------- 3) movement ----------
console.log('-- movement');
{
  const S = C.mkState(20261127);
  const spear = S.units.find((u) => u.kind === 'spearman');
  const rc = C.reach(S, spear);
  ok(rc.size >= 10, 'a spearman with 5 moves sees a real ring of hexes', rc.size);
  ok([...rc.values()].every((c) => C.at(S, c.q, c.r).t !== 'w'), 'water is never in the reachable set');
  ok([...rc.values()].every((c) => !C.unitAt(S, c.q, c.r)), 'an occupied hex is never in the reachable set');
  ok([...rc.values()].every((c) => c.cost <= spear.mp), 'no hex costs more than the unit has', spear.mp);
  ok([...rc.values()].every((c) => c.cost === C.pathTo(S, spear, c.q, c.r).slice(-1)[0].cost),
    'every reachable hex has a path whose cost matches the reach');
  const f = [...rc.values()].find((c) => C.at(S, c.q, c.r).t === 'f');
  ok(!f || f.cost >= 2, 'a forest hex costs at least 2 to enter', f);
  ok(C.pathTo(S, spear, spear.q, spear.r) === null, 'a zero-length move is not a path (tap-self cannot waste a turn)');

  const dest = [...rc.values()].sort((a, b) => b.cost - a.cost)[0];
  const before = spear.mp;
  const r = C.moveUnit(S, spear, dest.q, dest.r);
  ok(r && r.cost === dest.cost && spear.mp === before - dest.cost, 'a march spends exactly the path cost',
    { got: r && r.cost, want: dest.cost, mp: spear.mp });
  ok(spear.q === dest.q && spear.r === dest.r, 'the unit is standing on the destination');

  const S2 = C.mkState(20261127);
  const s2 = S2.units.find((u) => u.kind === 'spearman');
  const mate = S2.units.find((u) => u.kind === 'bowman');
  ok(C.moveUnit(S2, s2, mate.q, mate.r) === null, 'you cannot march onto your own unit');

  ok(C.KINDS.bowman.range === 2 && C.KINDS.spearman.range === 1, 'bowmen out-range spearmen');
  const S3 = C.mkState(20261127);
  const s3 = S3.units.find((u) => u.kind === 'spearman');
  s3.mp = 1;
  const rc1 = C.reach(S3, s3);
  ok(rc1.size > 0 && [...rc1.values()].every((c) => c.cost === 1), 'with one move left only the ring is reachable', rc1.size);
}

// ---------- 4) villages: capture, income, mend ----------
console.log('-- villages');
{
  const S = C.mkState(20261127);
  const vil = tilesOf(S).find((t) => t.t === 'v');
  ok(vil.owner === 2, 'villages start unclaimed', vil.owner);
  ok(C.income(S, 0) === 2 && C.income(S, 1) === 2, 'income is 2 with no village', [C.income(S, 0), C.income(S, 1)]);

  // stand a fresh spearman on a passable hex beside the village and march on
  S.units = [];
  const nb = C.DIRS.map(([dq, dr]) => C.at(S, vil.q + dq, vil.r + dr)).find((t) => t && C.passable(t));
  const u = C.mkUnit(0, 'spearman', nb.q, nb.r); u.id = 1;
  S.units.push(u);
  ok(C.hexDist(u, vil) === 1, 'the fixture unit stands beside the village', C.hexDist(u, vil));
  const r = C.moveUnit(S, u, vil.q, vil.r);
  ok(r && r.captured === true, 'marching onto a neutral village captures it', r);
  ok(vil.owner === 0, 'the village now flies your colours', vil.owner);
  ok(C.income(S, 0) === 4, 'a held village pays 2 more a turn', C.income(S, 0));
  ok(C.villageCount(S, 0) === 1, 'the village count follows the flags');

  u.hp = 10;
  C.beginTurn(S, 0);
  ok(u.hp === 13, 'a unit resting on its own village mends 3', u.hp);
  ok(u.mp === C.KINDS.spearman.mv && u.acted === false, 'a new turn refills moves and clears spent');

  u.hp = C.KINDS.spearman.hp - 1;
  C.beginTurn(S, 0);
  ok(u.hp === C.KINDS.spearman.hp, 'the mend cannot push a unit past its maximum', u.hp);

  const S2 = C.mkState(20261127);
  S2.units = [];
  const v2 = tilesOf(S2).find((t) => t.t === 'v');
  const u2 = C.mkUnit(0, 'spearman', v2.q, v2.r); u2.id = 1; u2.hp = 12;
  S2.units.push(u2);
  C.beginTurn(S2, 0);
  ok(u2.hp === 12, 'an unclaimed village does not mend anyone', u2.hp);

  // an enemy village is captured too, and its income switches sides
  const S3 = C.mkState(20261127);
  const v3 = tilesOf(S3).find((t) => t.t === 'v');
  v3.owner = 1;
  ok(C.income(S3, 1) === 4, 'an enemy-held village pays the enemy', C.income(S3, 1));
  S3.units = [];
  const nb3 = C.DIRS.map(([dq, dr]) => C.at(S3, v3.q + dq, v3.r + dr)).find((t) => t && C.passable(t));
  const u3 = C.mkUnit(0, 'horseman', nb3.q, nb3.r); u3.id = 1;
  S3.units.push(u3);
  C.moveUnit(S3, u3, v3.q, v3.r);
  ok(v3.owner === 0 && C.income(S3, 1) === 2, 'taking an enemy village switches its income', { owner: v3.owner, theirIncome: C.income(S3, 1) });
}

// ---------- 5) combat ----------
console.log('-- combat');
{
  const sample = (ground) => {
    const S = C.mkState(7);
    const t = tilesOf(S).find((x) => x.t === ground);
    const nb = C.DIRS.map(([dq, dr]) => C.at(S, t.q + dq, t.r + dr)).find((x) => x && C.passable(x));
    S.units = [];
    const att = C.mkUnit(0, 'spearman', nb.q, nb.r); att.id = 1;
    const def = C.mkUnit(1, 'grunt', t.q, t.r); def.id = 2;
    S.units.push(att, def);
    let hits = 0, n = 0, chance = 0;
    for (let i = 0; i < 4000; i++) { const r = C.rollStrikes(S, att, def); hits += r.hits; n += 2; chance = r.chance; }
    return { rate: +(hits / n).toFixed(3), chance, ground: t.t };
  };
  const grass = sample('g'), hill = sample('h'), forest = sample('f');
  ok(Math.abs(grass.rate - 0.80) < 0.03, 'a blow on open grass lands ~80% of the time', grass);
  ok(Math.abs(hill.rate - 0.50) < 0.03, 'a defender on a hill dodges half the blows', hill);
  ok(Math.abs(forest.rate - 0.60) < 0.03, 'a defender in forest dodges two in five', forest);
  ok(hill.rate < grass.rate && forest.rate < grass.rate, 'cover is measurably better ground than grass',
    { grass: grass.rate, forest: forest.rate, hill: hill.rate });

  {
    const { S, a, b } = duel('spearman', 'grunt', 1);
    const hp0 = b.hp;
    const hit = C.attack(S, a, b);
    ok(hit && [0, 6, 12].includes(hit.dealt), 'a spearman deals 0, 6 or 12 (two blows of six)', hit && hit.dealt);
    ok(b.hp === hp0 - hit.dealt, 'the defender loses exactly the blows that landed', { hp: b.hp, dealt: hit.dealt });
    ok(a.acted === true && a.mp === 0, 'striking spends the unit for the turn');
    ok(C.attack(S, a, b) === null, 'a spent unit cannot strike twice');
  }
  {
    // a shot from range 2 is not answered by a melee grunt, and a neighbouring blow is
    const shot = duel('bowman', 'grunt', 2);
    ok(C.canAttack(shot.S, shot.a, shot.b) === true, 'a bowman can shoot at two hexes');
    const s2 = C.attack(shot.S, shot.a, shot.b);
    ok(s2 && s2.back === null, 'a melee grunt cannot answer a shot from range 2', s2 && s2.back);
    const melee = duel('spearman', 'grunt', 1);
    const m1 = C.attack(melee.S, melee.a, melee.b);
    ok(m1 && m1.back !== null, 'an adjacent defender answers the blow', m1 && m1.back);
    ok([0, 6, 12].includes(m1.back.dealt), 'the answer is a real roll', m1.back);
  }
  {
    // a fallen leader ends the war (with a spare enemy alive, so it is the leader branch, not a rout)
    const S = C.mkState(20261127);
    S.units = [];
    const t1 = freeTile(S);
    const nb = C.DIRS.map(([dq, dr]) => C.at(S, t1.q + dq, t1.r + dr)).find((t) => t && C.passable(t));
    const far = freeTile(S, (t) => C.hexDist(t, t1) > 4);
    const horse = C.mkUnit(0, 'horseman', nb.q, nb.r); horse.id = 1;
    const lord = C.mkUnit(1, 'warlord', t1.q, t1.r); lord.id = 2; lord.hp = 3;
    const grunt = C.mkUnit(1, 'grunt', far.q, far.r); grunt.id = 3; grunt.acted = true;
    S.units.push(horse, lord, grunt);
    const kill = C.attack(S, horse, lord);
    ok(kill && kill.killed === true, 'a 3-hp warlord falls to a horseman', kill);
    ok(S.over === true && S.result === 'win' && /Warlord/.test(S.why), 'the fallen warlord ends the war as a win', { result: S.result, why: S.why });
    ok(!C.sideUnits(S, 1).some((u) => u.kind === 'warlord'), 'the warlord is off the field');
    ok(C.sideUnits(S, 1).length === 1, 'the spare orc is still standing (this was a leader kill, not a rout)');
  }
  {
    const S5 = C.mkState(20261127);
    S5.units = S5.units.filter((u) => u.side === 0);
    ok(C.verdict(S5) === 'win' && /broken/.test(S5.why), 'an emptied enemy field is a rout, not a leader kill', S5.why);
    const S6 = C.mkState(20261127);
    S6.units = S6.units.filter((u) => u.side === 1);
    ok(C.verdict(S6) === 'lose' && /broken/.test(S6.why), 'an emptied own field is a rout loss', S6.why);
    // the commander branch is reachable too
    const S7 = C.mkState(20261127);
    S7.units = S7.units.filter((u) => u.kind !== 'commander');
    ok(C.verdict(S7) === 'lose' && /Commander/.test(S7.why), 'a lost commander with troops left is a leader loss', S7.why);
  }
  {
    const { S, a, b } = duel('spearman', 'warlord', 5);
    ok(C.attack(S, a, b) === null, 'striking across the field is refused');
    ok(a.acted === false, 'a refused strike does not spend the unit');
  }
}

// ---------- 6) recruitment ----------
console.log('-- recruitment');
{
  const S = C.mkState(20261127);
  ok(C.recruit(S, 0, 'grunt') === null, 'you cannot recruit the enemy roster');
  ok(C.recruit(S, 0, 'commander') === null, 'you cannot recruit a second commander');
  S.gold[0] = 5;
  ok(C.recruit(S, 0, 'spearman') === null, 'a 5-gold purse cannot buy a 14-gold spearman');
  S.gold[0] = 14;
  const u = C.recruit(S, 0, 'spearman');
  ok(!!u && S.gold[0] === 0, 'a spearman costs 14 and leaves the purse empty', { u: !!u, gold: S.gold[0] });
  ok(u && C.hexDist(u, C.keepOf(S, 0)) === 1 && C.at(S, u.q, u.r).t === 'c', 'the recruit stands on a castle hex beside your keep',
    u && { hex: [u.q, u.r], ground: C.at(S, u.q, u.r).t });
  ok(u && u.acted === true && u.mp === 0, 'a fresh recruit fights from next turn, not this one');
  S.gold[0] = 200;
  let placed = 0;
  while (C.recruit(S, 0, 'spearman')) placed++;
  ok(placed >= 1, 'the castle ring takes more recruits', placed);
  ok(C.recruit(S, 0, 'spearman') === null, 'a full castle ring refuses another recruit');
  ok(C.recruit(S, 1, 'spearman') === null, 'the enemy cannot buy your roster');
  const S2 = C.mkState(20261127);
  S2.gold[1] = 12;
  ok(C.recruit(S2, 1, 'grunt') !== null, 'the enemy can buy a grunt with 12 gold');
}

// ---------- 7) turn cycle + the cpu ----------
console.log('-- turn cycle and cpu');
{
  const S = C.mkState(20261127);
  const g0 = S.gold[0];
  C.beginTurn(S, 1);
  ok(S.turn === 1, 'ending your turn hands the field to the enemy');
  ok(S.gold[1] === 22 + C.income(S, 1), 'the enemy banks its income when its turn starts', S.gold[1]);
  C.beginTurn(S, 0);
  ok(S.round === 2, 'the round advances when the field comes back to you', S.round);
  ok(S.gold[0] === g0 + C.income(S, 0), 'you bank your income when your turn starts', S.gold[0]);

  const S2 = C.mkState(20261127);
  C.beginTurn(S2, 1);
  const acts = C.aiTurn(S2);
  ok(acts.length >= 3, 'every enemy unit acts on its turn', acts.length);
  ok(C.sideUnits(S2, 1).every((u) => u.acted), 'the cpu leaves no unit unspent');
  ok(S2.units.every((u) => C.passable(C.at(S2, u.q, u.r))), 'the cpu never parks a unit on water or rock');
  ok(new Set(S2.units.map((u) => K(u.q, u.r))).size === S2.units.length, 'the cpu never stacks two units on one hex');

  // an armed fixture: a grunt beside a 10-hp bowman must take the shot
  {
    const S3 = C.mkState(20261127);
    S3.units = [];
    const t1 = tilesOf(S3).find((t) => t.t === 'g');
    const nb = C.DIRS.map(([dq, dr]) => C.at(S3, t1.q + dq, t1.r + dr)).find((t) => t && C.passable(t));
    const grunt = C.mkUnit(1, 'grunt', nb.q, nb.r); grunt.id = 1;
    const bow = C.mkUnit(0, 'bowman', t1.q, t1.r); bow.id = 2; bow.hp = 10;
    // a leader each side so the verdict stays live
    const cmd = C.mkUnit(0, 'commander', freeTile(S3, (t) => C.hexDist(t, t1) > 3 && C.passable(t)).q, 6); cmd.id = 3;
    const lord = C.mkUnit(1, 'warlord', freeTile(S3, (t) => C.hexDist(t, t1) > 3 && C.passable(t)).q, 0); lord.id = 4;
    cmd.q = C.keepOf(S3, 0).q; cmd.r = C.keepOf(S3, 0).r;
    lord.q = C.keepOf(S3, 1).q; lord.r = C.keepOf(S3, 1).r;
    S3.units.push(grunt, bow, cmd, lord);
    const a = C.actStep(S3, 1);
    ok(a && a.kind === 'attack' && a.target === bow.id, 'a grunt beside a wounded bowman strikes it', a);
    ok(bow.hp < 10, 'the strike drew blood', bow.hp);
  }

  // the cpu marches toward the visitor when nothing is in reach
  const S4 = C.mkState(20261127);
  C.beginTurn(S4, 1);
  const before = C.sideUnits(S4, 1).map((u) => [u.q, u.r]);
  C.actStep(S4, 1);
  const after = C.sideUnits(S4, 1).map((u) => [u.q, u.r]);
  ok(JSON.stringify(before) !== JSON.stringify(after), 'with nothing in reach the cpu advances', { before, after });
}

// ---------- 8) campaign ladder ----------
console.log('-- campaign ladder');
{
  const run = (policy, seeds) => {
    const out = { win: 0, lose: 0, draw: 0, rounds: [], earliestLoss: 99 };
    for (const s of seeds) {
      const r = C.runCampaign(s, policy, 30);
      out[r.result]++;
      out.rounds.push(r.round);
      if (r.result === 'lose') out.earliestLoss = Math.min(out.earliestLoss, r.round);
    }
    out.avgRound = +(out.rounds.reduce((a, b) => a + b, 0) / out.rounds.length).toFixed(1);
    out.minRound = Math.min(...out.rounds);
    out.maxRound = Math.max(...out.rounds);
    return out;
  };
  const seeds = Array.from({ length: 40 }, (_, i) => 1000 + i * 7);
  const idle = run('idle', seeds);
  const charge = run('charge', seeds);
  console.log('   idle   ' + JSON.stringify(idle));
  console.log('   charge ' + JSON.stringify(charge));
  ok(idle.win === 0, 'a visitor who never moves cannot win', idle.win);
  ok(idle.lose >= 38, 'a visitor who never moves is beaten nearly always', idle.lose);
  ok(idle.earliestLoss >= 2, 'no idle loss on round 1 (the cpu has to march first)', idle.earliestLoss);
  ok(charge.win >= 8, 'an aggressive visitor wins a real share of battles', { wins: charge.win, of: seeds.length });
  ok(charge.win < seeds.length, 'the cpu is a threat, not a formality', charge.win);
  ok(charge.win > idle.win, 'playing well beats playing not at all', { charge: charge.win, idle: idle.win });
  ok(charge.minRound >= 2 && charge.maxRound <= 30, 'battles end at a sane pace', charge);
  const a = C.runCampaign(1000, 'charge', 30), b = C.runCampaign(1000, 'charge', 30);
  ok(a.result === b.result && a.round === b.round, 'the same seed fights the same battle', { a, b });
}

console.log(fails === 0 ? '\nPASS — all wesnoth core assertions held' : '\nFAIL — ' + fails + ' assertion(s) failed');
process.exit(fails === 0 ? 0 : 1);
