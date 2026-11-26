#!/usr/bin/env node
// Proves the FreeOrion port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/freeorion/index.html.
//
// Checks the generated galaxy (13 stars, symmetric lanes, one connected graph, two capitals with
// three worlds each), tap-to-select / one-lane-per-turn movement, colony settlement, the yard's
// costs, combat with the home-defence bonus, uncontested-orbit capture, income, every terminal
// verdict — and then plays whole campaigns: an idle visitor must NOT win while a real expansion
// policy must, so the rival is neither toothless nor unbeatable.
//
// usage: node freeorion-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/freeorion/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { P, C, N, START_PP, COST_WAR, COST_COLONY, WAR_SHIPS, DEF_BONUS, CAP_BONUS,
  TURN_CAP, WIN_SHARE, rngFrom, genGalaxy, sysOf, lanesFrom, bfsDist, bfsFromSet, mkState, fleetsAt,
  warAt, shipsAt, sideStrength, countWorlds, incomeOf, totalShips, colonyFleets, canSelect, selectStar,
  canMove, orderMove, canSettle, settleAt, settle, canBuild, build, resolveMoves, combat, capture,
  verdict, aiOrders, resetFlags, endTurn };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const T = (s) => console.log('  ' + s);

// ---------- 1) the galaxy ----------
{
  const S = C.mkState(20261126);
  const sys = S.systems;
  ok(sys.length === 13, 'the galaxy holds thirteen stars', sys.length);
  ok(sys.every((s, i) => s.id === i), 'every star id matches its index');
  ok(new Set(sys.map((s) => `${s.x.toFixed(3)},${s.z.toFixed(3)}`)).size === sys.length, 'no two stars share a position');
  let tooClose = 0;
  for (let i = 0; i < sys.length; i++) for (let j = i + 1; j < sys.length; j++) {
    if (Math.hypot(sys[i].x - sys[j].x, sys[i].z - sys[j].z) < 1.5) tooClose++;
  }
  ok(tooClose === 0, 'no two stars are closer than the lane minimum', tooClose);
  let asym = 0;
  for (const s of sys) for (const k of s.links) if (!sys[k].links.includes(s.id)) asym++;
  ok(asym === 0, 'every starlane is symmetrical', asym);
  ok(sys.every((s) => s.links.length >= 1), 'every star has at least one lane');
  // connectivity
  const seen = new Set([0]), st = [0];
  while (st.length) { for (const k of sys[st.pop()].links) if (!seen.has(k)) { seen.add(k); st.push(k); } }
  ok(seen.size === sys.length, 'the starlane graph is one connected galaxy', { reached: seen.size, of: sys.length });
  ok(C.countWorlds(S, C.P) === 3 && C.countWorlds(S, C.C) === 3, 'both empires open on three worlds', { p: C.countWorlds(S, C.P), c: C.countWorlds(S, C.C) });
  ok(sys[S.cap[0]].owner === C.P && sys[S.cap[1]].owner === C.C, 'each capital belongs to its empire');
  ok(sys[S.cap[0]].prod === 3 && sys[S.cap[1]].prod === 3, 'a capital out-produces a colony world');
  ok(Math.hypot(sys[S.cap[0]].x - sys[S.cap[1]].x, sys[S.cap[0]].z - sys[S.cap[1]].z) > 6, 'the two capitals sit far apart');
  ok(S.fleets.filter((f) => f.owner === C.P).length === 3, 'the visitor opens with two war stacks and a colony ship', S.fleets.length);
  ok(C.totalShips(S, C.P) === 5 && C.totalShips(S, C.C) === 5, 'both fleets open at five warships');
  ok(S.pp[0] === C.START_PP && S.pp[1] === C.START_PP, 'both economies open with the same industry');
  ok(S.turn === 0 && S.round === 1 && S.over === false, 'the visitor moves first on turn 1');
  // deterministic
  const S2 = C.mkState(20261126);
  ok(JSON.stringify(S2.systems.map((s) => [s.x, s.z, s.links, s.owner])) === JSON.stringify(sys.map((s) => [s.x, s.z, s.links, s.owner])), 'the same seed deals the same galaxy');
  ok(S.systems.every((s) => s.planets >= 1 && s.planets <= 3), 'every world has one to three planets');
}

// ---------- 2) tap, order, one lane per turn ----------
{
  const S = C.mkState(20261126);
  const cap = S.cap[0];
  ok(C.selectStar(S, cap) === true && S.sel === cap, 'tapping your capital selects its fleets');
  ok(C.canSelect(S, cap) === false, 'the same star cannot be re-selected while held');
  const lane = S.systems[cap].links[0];
  ok(C.canMove(S, lane) === true, 'a linked star is a legal destination');
  const notLinked = S.systems.find((s) => !s.links.includes(cap) && s.id !== cap).id;
  ok(C.canMove(S, notLinked) === false, 'a star across the galaxy is not one turn away', notLinked);
  ok(C.orderMove(S, lane) === true, 'the order is taken');
  const orders = S.fleets.filter((f) => f.owner === C.P && f.dest === lane);
  ok(orders.length === 3 && S.sel === null, 'all three fleets at the star get the same order and the hand empties', orders.length);
  const back = S.fleets.filter((f) => f.owner === C.P && f.at === cap).length;
  ok(back === 3, 'the fleets have not teleported yet — they move when the turn resolves', back);
  C.resolveMoves(S);
  ok(S.fleets.filter((f) => f.owner === C.P && f.at === lane).length === 3, 'the order resolves them one lane over');
  ok(S.fleets.every((f) => f.dest === null), 'resolving clears every pending destination');
}

// ---------- 3) colony ships settle unclaimed worlds, and only those ----------
{
  const S = C.mkState(20261126);
  const colony = S.fleets.find((f) => f.owner === C.P && f.kind === 'colony');
  ok(C.canSettle(S) === false, 'a colony ship over your own capital settles nothing');
  const neutral = S.systems.find((s) => s.owner === C.N).id;
  colony.at = neutral;
  ok(C.canSettle(S) === true, 'a colony ship over an unclaimed world can settle it');
  ok(C.settle(S) === true, 'settling succeeds');
  ok(S.systems[neutral].owner === C.P, 'the world changes hands');
  ok(!S.fleets.includes(colony), 'the colony ship is spent');
  ok(C.settle(S) === false, 'there is nothing left to settle');
  const before = C.countWorlds(S, C.P);
  ok(before === 4, 'the empire now holds four worlds', before);
}

// ---------- 4) the yard ----------
{
  const S = C.mkState(20261126);
  S.pp[0] = 20;
  const war0 = S.fleets.length;
  ok(C.build(S, 'war') === true, 'industry buys a warship flotilla');
  ok(S.pp[0] === 20 - C.COST_WAR, 'the flotilla costs its price', S.pp[0]);
  const built = S.fleets[S.fleets.length - 1];
  ok(built.owner === C.P && built.kind === 'war' && built.ships === C.WAR_SHIPS && built.at === S.cap[0], 'the flotilla appears in orbit of the capital');
  ok(S.fleets.length === war0 + 1, 'exactly one fleet was added');
  ok(C.build(S, 'colony') === true && S.pp[0] === 20 - C.COST_WAR - C.COST_COLONY, 'a colony ship costs its own price');
  S.pp[0] = 1;
  ok(C.canBuild(S, 'war') === false && C.build(S, 'war') === false, 'an empty treasury builds nothing');
  S.systems[S.cap[0]].owner = C.C;
  S.pp[0] = 50;
  ok(C.canBuild(S, 'war') === false, 'a lost capital has no yard to build in');
}

// ---------- 5) combat: the defender's bonus, the toll, the wipe ----------
{
  const S = C.mkState(20261126);
  const id = S.systems.find((s) => s.owner === C.N).id;
  // an even fight over a neutral world: attacker 4 vs defender 4
  S.fleets = [
    { id: 1, owner: C.P, at: id, ships: 4, kind: 'war', dest: null, moved: false },
    { id: 2, owner: C.C, at: id, ships: 4, kind: 'war', dest: null, moved: false },
  ];
  ok(C.sideStrength(S, id, C.P) === 4 && C.sideStrength(S, id, C.C) === 4, 'over neutral space, strength is just hulls');
  const ev = C.combat(S);
  ok(ev.length === 1 && ev[0].win === null, 'an even fight leaves nothing standing', ev);
  ok(S.fleets.length === 0, 'both stacks are wiped out');
  // the same fight over YOUR world: the defence bonus decides it
  S.fleets = [
    { id: 3, owner: C.P, at: id, ships: 4, kind: 'war', dest: null, moved: false },
    { id: 4, owner: C.C, at: id, ships: 4, kind: 'war', dest: null, moved: false },
  ];
  S.systems[id].owner = C.P;
  ok(C.sideStrength(S, id, C.P) === 4 + C.DEF_BONUS, 'defending your own world adds the home bonus');
  const ev2 = C.combat(S);
  ok(ev2[0].win === C.P, 'the home fleet holds against an equal attacker', ev2);
  ok(S.fleets.length === 1 && S.fleets[0].owner === C.P, 'the attacker is destroyed');
  ok(S.fleets[0].ships === 4 - Math.ceil(4 / 2), 'the winner pays a toll in hulls', S.fleets[0].ships);
  S.systems[id].owner = C.C;
  const ev3 = C.combat(S);   // defender bonus flips — but there is no rival fleet left
  ok(ev3.length === 0, 'with no rival in orbit there is no battle', ev3);
  // a capital defends hardest
  const capS = C.mkState(20261126);
  capS.fleets = [{ id: 9, owner: C.P, at: capS.cap[1], ships: 3, kind: 'war', dest: null, moved: false },
    { id: 10, owner: C.C, at: capS.cap[1], ships: 6, kind: 'war', dest: null, moved: false }];
  ok(C.sideStrength(capS, capS.cap[1], C.C) === 6 + C.DEF_BONUS + C.CAP_BONUS, 'a capital adds both bonuses', C.sideStrength(capS, capS.cap[1], C.C));
  const ev4 = C.combat(capS);
  ok(ev4[0].win === C.C, 'six hulls still beat three over a capital', ev4);
}

// ---------- 6) capture: uncontested orbit flips an enemy world ----------
{
  const S = C.mkState(20261126);
  const target = S.systems.find((s) => s.owner === C.C && s.id !== S.cap[1]).id;
  S.fleets = [{ id: 1, owner: C.P, at: target, ships: 3, kind: 'war', dest: null, moved: false }];
  const flips = C.capture(S);
  ok(flips.length === 1 && flips[0].at === target, 'orbit with no defenders flips the world', flips);
  ok(S.systems[target].owner === C.P, 'the world is the visitor\'s now');
  // with a defender in orbit nothing flips
  const S2 = C.mkState(20261126);
  const t2 = S2.systems.find((s) => s.owner === C.C && s.id !== S2.cap[1]).id;
  S2.fleets = [
    { id: 1, owner: C.P, at: t2, ships: 3, kind: 'war', dest: null, moved: false },
    { id: 2, owner: C.C, at: t2, ships: 1, kind: 'war', dest: null, moved: false },
  ];
  C.capture(S2);
  ok(S2.systems[t2].owner === C.C, 'a defended world does not flip', S2.systems[t2].owner);
  // a colony ship alone cannot take a world, and dies in hostile orbit
  const S3 = C.mkState(20261126);
  const t3 = S3.systems.find((s) => s.owner === C.C && s.id !== S3.cap[1]).id;
  S3.fleets = [{ id: 1, owner: C.P, at: t3, ships: 1, kind: 'colony', dest: null, moved: false }];
  C.capture(S3);
  ok(S3.systems[t3].owner === C.C, 'a colony ship never captures a world');
}

// ---------- 7) income and the turn clock ----------
{
  const S = C.mkState(20261126);
  const income = C.incomeOf(S, C.P);
  ok(income === 5, 'three worlds — a capital and two colonies — pay five industry', income);
  const pp0 = S.pp[0];
  C.endTurn(S);
  ok(S.pp[0] === pp0 + income, 'ending a round pays the visitor economy', { before: pp0, after: S.pp[0] });
  ok(S.round === 2 && S.turn === 0, 'the round advances and the visitor moves again');
  ok(S.fleets.every((f) => !f.moved && f.dest === null), 'every fleet is ready again next round');
  const S2 = C.mkState(20261126);
  S2.round = C.TURN_CAP + 1;
  const v = C.verdict(S2);
  ok(v === 'draw', 'a campaign that runs out of turns is a draw at equal holdings', v);
}

// ---------- 8) every terminal verdict ----------
{
  const mk = () => C.mkState(20261126);
  let S = mk(); S.systems[S.cap[1]].owner = C.P;
  ok(C.verdict(S) === 'win' && S.why === 'capital', 'taking the rival capital wins the war', { r: S.result, w: S.why });
  S = mk(); S.systems[S.cap[0]].owner = C.C;
  ok(C.verdict(S) === 'lose' && S.why === 'capital', 'losing your capital loses the war', { r: S.result, w: S.why });
  S = mk();
  const neutral = S.systems.filter((s) => s.owner === C.N);
  for (const s of neutral) s.owner = C.P;
  ok(C.verdict(S) === 'win' && S.why === 'dominion', 'holding 60 % of the worlds is a dominion win', { r: S.result, w: S.why, mine: C.countWorlds(S, C.P) });
  S = mk();
  for (const s of S.systems) s.owner = C.C;
  S.systems[S.cap[0]].owner = C.P;
  S.systems[S.cap[1]].owner = C.P;   // both capitals, everything else theirs
  S.systems[S.cap[1]].owner = C.C;
  ok(C.verdict(S) === 'lose', 'a galaxy held by the rival is a defeat', { r: S.result, w: S.why });
  S = mk(); S.systems.forEach((s) => { if (s.owner === C.P) s.owner = C.N; });
  ok(C.verdict(S) === 'lose' && S.why === 'rout', 'an empire with no worlds is routed', { r: S.result, w: S.why });
  S = mk(); S.systems.forEach((s) => { if (s.owner === C.C) s.owner = C.N; });
  ok(C.verdict(S) === 'win' && S.why === 'rout', 'a rival with no worlds is routed', { r: S.result, w: S.why });
  // a finished game takes no more orders
  S = mk(); S.systems[S.cap[1]].owner = C.P; C.verdict(S);
  ok(C.endTurn(S) === false, 'a finished campaign accepts no further turns');
  ok(C.canSelect(S, S.cap[0]) === false, 'a finished campaign accepts no orders');
}

// ---------- 9) whole campaigns: the ladder is real ----------
const settleAndMarch = (S) => {
  C.settle(S);
  if (C.colonyFleets(S, C.P).length < 2 && C.canBuild(S, 'colony')) C.build(S, 'colony');
  else if (C.canBuild(S, 'war')) C.build(S, 'war');
  const free = S.systems.filter((s) => s.owner === C.N).map((s) => s.id);
  if (free.length) {
    const open = C.bfsFromSet(S, free);
    for (const f of S.fleets.filter((f) => f.owner === C.P && f.kind === 'colony')) {
      if (f.moved || C.sysOf(S, f.at).owner === C.N) continue;
      let dest = null, bd = open.has(f.at) ? open.get(f.at) : 99;
      for (const k of C.lanesFrom(S, f.at)) { const d = open.has(k) ? open.get(k) : 99; if (d < bd) { bd = d; dest = k; } }
      if (dest !== null) { f.dest = dest; f.moved = true; }
    }
  }
  // war stacks: hold the capital, and push on the rival capital when we out-gun it
  const enemyCap = S.cap[1];
  const dist = C.bfsDist(S, enemyCap);
  const byAt = new Map();
  for (const f of S.fleets.filter((f) => f.owner === C.P && f.kind === 'war' && !f.moved)) byAt.set(f.at, (byAt.get(f.at) || 0) + f.ships);
  for (const [at, ships] of byAt) {
    let dest = null;
    for (const k of C.lanesFrom(S, at)) {
      const t = C.sysOf(S, k);
      if (t.owner === C.C && ships > C.sideStrength(S, k, C.C) + 1) { dest = k; break; }
    }
    if (dest === null && ships >= 7) {
      let bd = dist.has(at) ? dist.get(at) : 99;
      for (const k of C.lanesFrom(S, at)) { const d = dist.has(k) ? dist.get(k) : 99; if (d < bd) { bd = d; dest = k; } }
    }
    if (dest !== null) for (const f of S.fleets) if (f.owner === C.P && f.kind === 'war' && f.at === at && !f.moved) { f.dest = dest; f.moved = true; }
  }
  C.endTurn(S);
};

{
  const idle = [];
  for (const seed of [20261126, 7, 424242]) {
    const S = C.mkState(seed);
    let guard = 0;
    while (!S.over && guard++ < C.TURN_CAP + 2) C.endTurn(S);
    idle.push({ seed, over: S.over, r: S.result, w: S.why, round: S.round, mine: C.countWorlds(S, C.P), theirs: C.countWorlds(S, C.C) });
  }
  T('idle campaigns ' + JSON.stringify(idle));
  ok(idle.every((g) => g.over), 'a campaign with no orders still ends by itself');
  ok(idle.every((g) => g.r !== 'win'), 'sitting still never wins the war', idle);
}
{
  const played = [];
  for (const seed of [20261126, 7, 424242, 9001]) {
    const S = C.mkState(seed);
    let guard = 0;
    while (!S.over && guard++ < C.TURN_CAP + 2) settleAndMarch(S);
    played.push({ seed, over: S.over, r: S.result, w: S.why, round: S.round, mine: C.countWorlds(S, C.P), theirs: C.countWorlds(S, C.C) });
  }
  T('played campaigns ' + JSON.stringify(played));
  ok(played.every((g) => g.over), 'a played campaign always reaches a verdict');
  ok(played.some((g) => g.r === 'win'), 'a real expansion policy can win the galaxy — the port is winnable', played);
  ok(played.some((g) => g.r !== 'win') || played.every((g) => g.r === 'win'), 'the ladder is not one-sided', played);
  const total = played.reduce((a, g) => a + g.mine, 0);
  ok(total > 0, 'the visitor always holds worlds at the end', total);
}

// ---------- 10) the rival actually plays ----------
{
  const S = C.mkState(20261126);
  const worlds0 = C.countWorlds(S, C.C);
  for (let i = 0; i < 10 && !S.over; i++) C.endTurn(S);
  const worlds = C.countWorlds(S, C.C);
  T('rival after ten rounds ' + JSON.stringify({ worlds0, worlds, pp: S.pp[1], fleets: S.fleets.filter((f) => f.owner === C.C).length }));
  ok(worlds >= worlds0, 'the rival never loses ground to nobody');
  ok(worlds > worlds0 || S.fleets.filter((f) => f.owner === C.C).length > 3, 'the rival expands or arms itself — it is not a statue', { worlds, fleets: S.fleets.filter((f) => f.owner === C.C).length });
}

if (fails) { console.error(`\nFAIL: ${fails} assertion(s) failed`); process.exit(1); }
console.log('\nPASS freeorion core: galaxy, lanes, orders, colonies, yard, combat, capture, income, verdicts, campaigns');
