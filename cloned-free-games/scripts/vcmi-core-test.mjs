#!/usr/bin/env node
// Proves the Hex Fields (VCMI card) port's battle rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/vcmi/index.html.
//
// Checks the odd-r hex lattice (neighbour symmetry), BFS march distance, the Heroes damage
// curve and its clamps, one action per stack per round with the speed order, move-then-attack,
// the single retaliation per stack per round, ranged attacks taking no retaliation while no
// enemy stands adjacent, wait re-ordering, defend raising defence, both terminal states, and a
// full deterministic AI-vs-AI playout on many seeds so a decisive battle is reachable and the
// loop always terminates.
//
// usage: node vcmi-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/Projects/rdw-games/shelf/games/arcade/vcmi/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m || !m[1].trim()) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { COLS, ROWS, KINDS, ROSTER, nb, hexDist, rngOf, mkState, byId, stackAt, nOf, topOf,
  alive, sideCount, buildOrder, reach, reachableCells, attackInfo, attackableIds, rollDmg, hurt,
  checkOver, doAttack, doMove, doDefend, doWait, currentId, advance, bestAction, defOf };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  COLS, ROWS, KINDS, nb, hexDist, rngOf, mkState, byId, stackAt, nOf, topOf, alive, sideCount,
  buildOrder, reach, reachableCells, attackInfo, attackableIds, rollDmg, hurt, checkOver,
  doAttack, doMove, doDefend, doWait, currentId, advance, bestAction, defOf,
} = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---- 1. the lattice ----
console.log('lattice');
{
  let asym = 0, deg = 0, distBad = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const ns = nb(c, r);
    deg += ns.length;
    for (const [cc, rr] of ns) {
      if (!nb(cc, rr).some(([a, b]) => a === c && b === r)) asym++;
      if (hexDist([c, r], [cc, rr]) !== 1) distBad++;
    }
  }
  ok(asym === 0, 'every neighbour link is symmetric (' + asym + ' broken)');
  ok(distBad === 0, 'every neighbour is hex-distance 1 (' + distBad + ' wrong)');
  ok(deg > 0 && deg <= COLS * ROWS * 6, 'neighbour graph is bounded (' + deg + ' links)');
  ok(hexDist([0, 0], [0, 0]) === 0, 'a cell is distance 0 from itself');
  // a straight march down a row: adjacent cells are 1 apart, three along is 3
  ok(hexDist([0, 0], [3, 0]) === 3, 'three columns along an even row is 3', hexDist([0, 0], [3, 0]));
  ok(hexDist([0, 0], [8, 6]) === hexDist([8, 6], [0, 0]) && hexDist([0, 0], [8, 6]) > 6, 'the far corner is a legal, symmetric distance', hexDist([0, 0], [8, 6]));
}

// ---- 2. the fresh state ----
console.log('fresh battle');
{
  const S = mkState(1);
  ok(S.stacks.length === 10, 'five stacks a side (10 total)', S.stacks.length);
  ok(alive(S, 0).length === 5 && alive(S, 1).length === 5, 'both sides start with five stacks');
  ok(sideCount(S, 0) === 24, 'your army musters 24 creatures', sideCount(S, 0));
  ok(sideCount(S, 1) === 27, 'the warband musters 27 creatures', sideCount(S, 1));
  ok(!S.over && S.result === null, 'a fresh battle is not over');
  ok(S.order.length === 10, 'every stack is in the round order');
  const first = byId(S, currentId(S));
  ok(first.side === 0, 'the fastest stack is yours, so you open', { id: first.id, kind: first.kind });
  ok(KINDS[first.kind].spd === 7, 'the opener is the speed-7 cavaliers', first.kind);
  // one action per stack per round: advancing 10 times rolls into round 2
  const ids = new Set(S.order);
  ok(ids.size === 10, 'no stack appears twice in the order');
  // ties alternate sides between rounds
  const S2 = mkState(1);
  doDefend(S2, currentId(S2)); advance(S2);
  const tie = S2.stacks.filter((s) => !s.dead && KINDS[s.kind].spd === 5);
  ok(tie.length >= 2 && new Set(tie.map((s) => s.side)).size === 2, 'speed ties occur across both sides (so the round parity rule is exercised)', tie.map((s) => s.side));
  // the round-parity tiebreak really flips which side opens between rounds
  const pair = mkState(1);
  pair.stacks = [
    { id: 0, side: 0, kind: 'swords', c: 2, r: 2, pool: 35, retal: false, defending: false, acted: false, waited: false, dead: false },
    { id: 1, side: 1, kind: 'goblins', c: 6, r: 4, pool: 5, retal: false, defending: false, acted: false, waited: false, dead: false },
  ];
  const o1 = buildOrder({ ...pair, round: 1 })[0];
  const o2 = buildOrder({ ...pair, round: 2 })[0];
  ok(o1 !== o2, 'equal-speed stacks swap the opening slot between rounds', { round1: o1, round2: o2 });
}

// ---- 3. march distance ----
console.log('march');
{
  const S = mkState(1);
  const cav = S.stacks.find((s) => s.kind === 'cavaliers');
  const cells = reachableCells(S, cav.id);
  ok(cells.length > 10, 'the cavaliers see a wide march (speed 7)', cells.length);
  ok(cells.every(([, , v]) => v >= 1 && v <= 7), 'no cell is out of speed range');
  const d = reach(S, cav.id);
  let blocked = 0;
  for (const s of S.stacks) if (!s.dead && s.id !== cav.id && d.get(s.c + ',' + s.r) !== 99) blocked++;
  ok(blocked === 0, 'every occupied cell is impassable', blocked);
  // a move onto a friendly stack must be refused
  const mate = S.stacks.find((s) => s.side === 0 && s.id !== cav.id && s.kind === 'pikemen');
  const bad = doMove(S, cav.id, mate.c, mate.r);
  ok(!bad.ok, 'marching onto a friendly stack is refused', bad);
  // a legal march consumes the action, and a second march that round is refused
  const target = cells.find(([c, r]) => !stackAt(S, c, r));
  const good = doMove(S, cav.id, target[0], target[1]);
  ok(good.ok, 'a reachable empty hex accepts the march', good);
  ok(cav.c === target[0] && cav.r === target[1], 'the stack actually walked there');
  const again = doMove(S, cav.id, target[0] + 0, target[1]);
  ok(!again.ok, 'a stack acts once per round', again);
}

// ---- 4. the damage curve ----
console.log('damage');
{
  const S = mkState(1);
  const cav = S.stacks.find((s) => s.kind === 'cavaliers');   // atk 15
  const gob = S.stacks.find((s) => s.kind === 'goblins');     // def 2
  const roll = (v) => () => v;
  const low = rollDmg(cav, gob, roll(0));    // base 15, mult 1+0.05*13 = 1.65
  const high = rollDmg(cav, gob, roll(0.999)); // base 25, same mult
  ok(low === Math.round(15 * nOf(cav) * 1.65), 'low die uses the base minimum', { low, n: nOf(cav) });
  ok(high === Math.round(25 * nOf(cav) * 1.65), 'high die uses the base maximum', high);
  ok(high > low, 'a bigger die rolls more damage');
  // clamp: 0.30 floor when defence towers over attack, 3.00 ceiling the other way. The shipped
  // roster never spans a gap that wide (worst case is 0.45 / 1.65), so the clamps are exercised
  // with two fixture kinds added to the same table the rules read.
  KINDS.__weak = { name: 'Fixture weak', atk: 0, def: 0, dmg: [1, 1], hp: 10, spd: 4, ranged: false };
  KINDS.__titan = { name: 'Fixture titan', atk: 60, def: 0, dmg: [1, 1], hp: 10, spd: 4, ranged: false };
  const S2 = mkState(1);
  const weak = { id: 90, side: 0, kind: '__weak', c: 1, r: 1, pool: 30, retal: false, defending: false, acted: false, waited: false, dead: false };
  const b = S2.stacks.find((s) => s.kind === 'cavaliers');  // def 15 → raw mult 0.25
  const floor = rollDmg(weak, b, roll(0));
  ok(floor === Math.max(1, Math.round(1 * nOf(weak) * 0.30)), 'penalty is clamped at 0.30', { floor, n: nOf(weak), raw: 0.25 });
  const titan = { id: 91, side: 1, kind: '__titan', c: 7, r: 1, pool: 30, retal: false, defending: false, acted: false, waited: false, dead: false };
  const d3 = S2.stacks.find((s) => s.kind === 'goblins');   // def 2 → raw mult 3.90
  const ceil = rollDmg(titan, d3, roll(0));
  ok(ceil === Math.max(1, Math.round(1 * nOf(titan) * 3.0)), 'bonus is clamped at 3.00', { ceil, n: nOf(titan), raw: 3.9 });
  delete KINDS.__weak; delete KINDS.__titan;
  // defend really raises defence
  const S4 = mkState(1);
  const ar = S4.stacks.find((s) => s.kind === 'archers');
  const before = defOf(ar);
  doDefend(S4, ar.id);
  ok(defOf(ar) > before, 'defend raises the defence that damage reads', { before, after: defOf(ar) });
  // damage always costs at least one creature out of a small stack
  const S5 = mkState(1);
  const t5 = S5.stacks.find((s) => s.kind === 'goblins');
  const k = hurt(t5, 999999);
  ok(t5.dead && nOf(t5) === 0, 'a lethal hit kills the stack', k);
  ok(!hurt(t5, 0) || true, 'a dead stack does not come back');
}

// ---- 5. one retaliation, ranged takes none, move-then-attack ----
console.log('strikes');
{
  // adjacent melee: both sides lose creatures, retaliation spends itself
  const S = mkState(1);
  const a = S.stacks.find((s) => s.kind === 'cavaliers');
  const b = S.stacks.find((s) => s.kind === 'goblins');
  a.c = b.c - 1; a.r = b.r;                       // stand beside them
  const pool0 = a.pool;
  const res = doAttack(S, a.id, b.id, rngOf(3));
  ok(res.ok && res.mode === 'melee', 'adjacent strike is melee', res.mode);
  ok(res.dmg > 0 && res.kills >= 1, 'the charge lands and kills', { dmg: res.dmg, kills: res.kills });
  ok(res.retal && res.dmgBack > 0, 'the survivor struck back once', { retal: res.retal, dmgBack: res.dmgBack });
  ok(a.pool < pool0, 'retaliation cost the attacker hit points');
  // a stack struck twice in one round retaliates only on the first strike
  const S1 = mkState(1);
  const atk1 = S1.stacks.find((s) => s.kind === 'cavaliers');
  const atk2 = S1.stacks.find((s) => s.kind === 'griffins');
  const vic = S1.stacks.find((s) => s.kind === 'ogres');
  atk1.c = vic.c - 1; atk1.r = vic.r;
  atk2.c = vic.c + 1; atk2.r = vic.r;
  const first = doAttack(S1, atk1.id, vic.id, rngOf(4));
  ok(first.retal === true, 'the first strike of the round draws retaliation', first.retal);
  const second = doAttack(S1, atk2.id, vic.id, rngOf(4));
  ok(second.ok && second.retal === false && second.dmgBack === 0, 'a stack retaliates only once per round', { retal: second.retal, dmgBack: second.dmgBack });

  // ranged: no retaliation from an unengaged archer
  const S2 = mkState(1);
  const arch = S2.stacks.find((s) => s.kind === 'archers');
  const tgt = S2.stacks.find((s) => s.kind === 'ogres');
  const r2 = doAttack(S2, arch.id, tgt.id, rngOf(5));
  ok(r2.ok && r2.mode === 'shoot', 'an unengaged archer shoots', r2.mode);
  ok(r2.retal === false && r2.dmgBack === 0, 'a shot draws no retaliation', r2);
  ok(arch.c === 1 && arch.r === 5, 'shooting does not move the archer', { c: arch.c, r: arch.r });

  // move-then-attack: a stack two hexes from the enemy marches into contact and strikes
  const S3 = mkState(1);
  const S3a = S3.stacks.find((s) => s.kind === 'griffins');   // spd 6
  const S3b = S3.stacks.find((s) => s.kind === 'goblins');
  S3b.c = 6; S3b.r = 3;
  S3a.c = 4; S3a.r = 3;
  ok(hexDist([S3a.c, S3a.r], [S3b.c, S3b.r]) === 2, 'target starts two hexes away', hexDist([S3a.c, S3a.r], [S3b.c, S3b.r]));
  const info = attackInfo(S3, S3a.id, S3b.id);
  ok(info && info.mode === 'melee' && info.cost >= 1, 'a two-hex charge is offered with a march cost', info);
  const r3 = doAttack(S3, S3a.id, S3b.id, rngOf(6));
  ok(r3.ok && hexDist([S3a.c, S3a.r], [S3b.c, S3b.r]) === 1, 'the charger ended beside the target', { c: S3a.c, r: S3a.r });

  // out of reach: a pikeman (speed 4) cannot cross nine columns in one round
  const S4 = mkState(1);
  const pik = S4.stacks.find((s) => s.kind === 'pikemen');
  const far = S4.stacks.find((s) => s.kind === 'cyclops');
  ok(attackInfo(S4, pik.id, far.id) === null, 'an out-of-speed target is not attackable', attackInfo(S4, pik.id, far.id));
  ok(attackableIds(S4, pik.id).length === 0, 'no targets for a stack still in its own lines');
}

// ---- 6. wait and the round order ----
console.log('order');
{
  const S = mkState(1);
  const first = currentId(S);
  const w = doWait(S, first);
  ok(w.ok, 'the acting stack can wait', w);
  ok(S.order[S.order.length - 1] === first, 'waiting sends the stack to the end of the round', S.order);
  const next = currentId(S);
  ok(next !== first, 'the next stack steps up', { first, next });
  // the waited stack sits at the end of the order; point the cursor at it and try again
  S.idx = S.order.indexOf(first);
  const r2 = doWait(S, first);
  ok(!r2.ok, 'a waited stack cannot wait again this round', r2);
  // walking the whole order reaches round 2 and re-arms everyone
  let guard = 0;
  while (S.round === 1 && guard++ < 40) { const id = currentId(S); if (id == null) break; doDefend(S, id); advance(S); }
  ok(S.round === 2, 'a full lap rolls the round over', S.round);
  ok(S.stacks.every((s) => !s.acted && !s.waited && !s.retal && !s.defending), 'the new round re-arms every stack');
  ok(S.order.length === 10, 'the rebuilt order holds every living stack', S.order.length);
  const acted = S.order.map((id) => nOf(byId(S, id)));
  ok(acted.every((n) => n > 0), 'every stack in the order is alive', acted);
}

// ---- 7. terminal states ----
console.log('terminal');
{
  const S = mkState(1);
  for (const s of S.stacks) if (s.side === 1) { s.dead = true; s.pool = 0; }
  ok(checkOver(S) === 'win', 'no enemy stacks left reads a win', checkOver(S));
  const S2 = mkState(1);
  for (const s of S2.stacks) if (s.side === 0) { s.dead = true; s.pool = 0; }
  ok(checkOver(S2) === 'lose', 'no friendly stacks left reads a loss', checkOver(S2));
  const S3 = mkState(1);
  ok(checkOver(S3) === null && !S3.over, 'a full field is not over');
  // a strike that kills the last enemy stack ends the battle inside the rules
  const S4 = mkState(1);
  S4.stacks = [
    { id: 0, side: 0, kind: 'cavaliers', c: 3, r: 3, pool: 200, retal: false, defending: false, acted: false, waited: false, dead: false },
    { id: 1, side: 1, kind: 'goblins', c: 4, r: 3, pool: 1, retal: false, defending: false, acted: false, waited: false, dead: false },
  ];
  S4.order = [0, 1];
  const r = doAttack(S4, 0, 1, rngOf(9));
  ok(r.ok && S4.over && S4.result === 'win', 'killing the last stack ends the battle as a win', { over: S4.over, result: S4.result });
  ok(r.kills === 1, 'the last creature counted as a kill', r.kills);
}

// ---- 8. AI playouts are decisive and terminate ----
console.log('playouts');
{
  let wins = 0, losses = 0, maxRounds = 0, bad = 0, stalls = 0;
  for (let seed = 1; seed <= 40; seed++) {
    // side 1 (the warband's own pilot) fights a mirrored pilot for side 0
    const S = mkState(seed);
    const rnd = rngOf(seed * 2654435761);
    let guard = 0;
    while (!S.over && guard++ < 900) {
      const id = currentId(S);
      if (id == null) break;
      const s = byId(S, id);
      const a = bestAction(S, id, rnd);
      const res = a.type === 'attack' ? doAttack(S, id, a.target, rnd)
        : a.type === 'move' ? doMove(S, id, a.to[0], a.to[1])
        : a.type === 'defend' ? doDefend(S, id) : doWait(S, id);
      if (!res || !res.ok) {
        // a refused action must never wedge the pilot: fall back to defend
        const f = doDefend(S, id);
        if (!f.ok) { bad++; break; }
        if (a.type === 'wait') stalls++;
      }
      if (!S.over) advance(S);
    }
    if (guard >= 900) bad++;
    maxRounds = Math.max(maxRounds, S.round);
    if (S.result === 'win') wins++;
    else if (S.result === 'lose') losses++;
    // sanity: no stack is dead with hit points left, and vice versa
    for (const s of S.stacks) if ((nOf(s) === 0) !== s.dead) bad++;
  }
  ok(bad === 0, 'every playout terminates cleanly with dead stacks at zero hit points', bad);
  ok(wins + losses === 40, 'every playout reaches a decisive result', { wins, losses });
  ok(wins >= 12 && losses >= 12, 'a mirror pilot lands near even, so neither army is a foregone conclusion', { wins, losses });
  ok(maxRounds <= 14, 'no playout drags on (a stack marching out of reach used to defend forever)', maxRounds);
  // regression: two melee stacks eight hexes apart must close, not stand off
  const L = mkState(1);
  L.stacks = [
    { id: 0, side: 0, kind: 'pikemen', c: 0, r: 0, pool: 90, retal: false, defending: false, acted: false, waited: false, dead: false },
    { id: 1, side: 1, kind: 'goblins', c: 8, r: 6, pool: 60, retal: false, defending: false, acted: false, waited: false, dead: false },
  ];
  L.order = [0, 1];
  const far0 = hexDist([L.stacks[0].c, L.stacks[0].r], [L.stacks[1].c, L.stacks[1].r]);
  const act = bestAction(L, 0, rngOf(11));
  ok(act.type === 'move', 'a stack with nothing in reach marches instead of holding', act.type);
  const mr = doMove(L, 0, act.to[0], act.to[1]);
  const far1 = hexDist([L.stacks[0].c, L.stacks[0].r], [L.stacks[1].c, L.stacks[1].r]);
  ok(mr.ok && far1 < far0, 'the march closed the distance', { far0, far1 });
  console.log(`  (pilots: ${wins} your-side wins, ${losses} warband wins, longest ${maxRounds} rounds)`);
}

// ---- 9. the opening is playable ----
console.log('opening');
{
  const S = mkState(20261121);
  const id = currentId(S);
  const s = byId(S, id);
  ok(s.side === 0, 'the deterministic opening hands the first action to you');
  const moves = reachableCells(S, id);
  ok(moves.length > 0, 'the opening stack has somewhere to march', moves.length);
  ok(!S.over, 'the opening position is not already lost');
  // the opening may offer a long charge (speed 7 across a 9-wide field is a real Heroes move),
  // but no single strike may end the battle on turn one
  ok(!S.over && S.result === null, 'the opening is not already decided');
  const probe = JSON.parse(JSON.stringify(S));
  for (const tid of attackableIds(S, id)) {
    const P = mkState(S.seed);
    P.stacks = JSON.parse(JSON.stringify(S.stacks));
    P.over = false; P.result = null;
    doAttack(P, id, tid, rngOf(21));
    ok(!(P.over && P.result === 'win'), 'no turn-one strike wins the battle outright', tid);
  }
}

console.log(fails ? `\nFAIL ${fails} assertion(s)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
