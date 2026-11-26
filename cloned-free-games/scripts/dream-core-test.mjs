#!/usr/bin/env node
// Proves the rules of the "I Keep Having This Dream" port with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/i-keep-having-this-dream/index.html.
//
// Checks the deck arithmetic (every cycle deals exactly HAND-1 spare tiles), that a cycle can always
// be walked to the gate with a live hand, that the deal is deterministic per seed, that no first tile
// can kill you, that the deep-slot penalty and the heals behave — and then plays whole campaigns:
// an upgrade-first pilot must survive three cycles while an enemy-first rush must get caught, so the
// pursuer is neither toothless nor unbeatable.
//
// usage: node dream-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/i-keep-having-this-dream/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { SLOTS, GATE, BUILD, CYCLES, HAND, MAXHP, START, DECKS, DEEP, mulberry32, between, shuffle,
  makeDeck, deal, newDream, forecast, place, stepThrough, readState };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
// ok() must RETURN its condition: several cases below use `if (!ok(...)) continue`.
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const T = (s) => console.log('  ' + s);

// An upgrade-first visitor: take the star first, then the ward, heal when hurt, avoid a fight that
// costs more than one slot of chase, and only brawl when nothing better is on offer.
function upgradeFirst(S) {
  let best = 0, bestScore = -1e9;
  S.hand.forEach((t, i) => {
    const f = C.forecast(S, t);
    let sc;
    if (t.kind === 'star') sc = 100;
    else if (t.kind === 'ward') sc = S.def < 4 ? 80 : 40;
    else if (t.kind === 'dew') sc = S.hp <= 9 ? 70 : 30;
    else if (t.kind === 'mist') sc = 20;
    else sc = 10 - f.delay * 12 - f.dmg * 0.5;
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return best;
}
// An enemy-first visitor: brawl at every opportunity.
function rush(S) {
  const i = S.hand.findIndex((t) => t.kind === 'enemy');
  return i >= 0 ? i : 0;
}
function campaign(seed, pilot) {
  const S = C.newDream(seed);
  let guard = 0;
  while (!S.over && guard++ < 120) C.place(S, pilot(S));
  return S;
}

// ---------- 1) deck arithmetic and the deal ----------
{
  C.DECKS.forEach((d, i) => {
    const total = d.enemy + d.star + d.ward + d.dew + d.mist;
    ok(total === C.BUILD + C.HAND - 1, `cycle ${i + 1} deck holds exactly BUILD+HAND-1 = 18 tiles`, total);
  });
  ok(C.SLOTS === C.BUILD + 2, 'the path is the built slots plus the entrance and the gate', { SLOTS: C.SLOTS, BUILD: C.BUILD });
  ok(C.GATE === C.SLOTS - 1, 'the gate is the last slot');

  const S = C.newDream(12345);
  ok(S.hand.length === C.HAND, 'a fresh dream offers three tiles', S.hand.length);
  ok(S.deck.length === C.BUILD + C.HAND - 1 - C.HAND, 'the rest of the deck is behind the hand', S.deck.length);
  ok(S.pos === 0 && S.placed === 0 && S.cycle === 1, 'a fresh dream starts on the entrance of cycle 1', C.readState(S));
  ok(S.hp === C.START.hp && S.atk === C.START.atk && S.def === C.START.def && S.gap === C.START.gap,
    'a fresh dream starts on the published stats', C.readState(S));

  // determinism: the same seed deals the same tiles in the same order
  const seq = (seed) => {
    const s = C.newDream(seed);
    const out = [];
    for (let i = 0; i < 20 && !s.over; i++) {
      out.push(s.hand.map((t) => t.kind + (t.kind === 'enemy' ? `${t.hp}/${t.atk}` : '')).join(','));
      C.place(s, 0);
    }
    return out.join('|');
  };
  ok(seq(777) === seq(777), 'the same seed deals the same dream twice');
  let differ = 0;
  for (let s = 1; s <= 40; s++) if (seq(s) !== seq(s + 1000)) differ++;
  ok(differ > 35, 'different seeds deal different dreams', differ);
}

// ---------- 2) a cycle always walks to the gate with a live hand ----------
{
  let shortHand = 0, badDeck = 0, badSlot = 0, gateBuilt = 0, cyclesSeen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const S = C.newDream(seed);
    let guard = 0;
    while (!S.over && guard++ < 200) {
      if (S.hand.length === 0) { shortHand++; break; }
      if (S.deck.length < 0) badDeck++;
      const before = S.pos;
      const r = C.place(S, 0);
      if (!r.ok) { badDeck++; break; }
      if (S.pos === before + 1 || S.pos === 0 || S.pos === C.GATE) {
        // normal step, new cycle, or the gate
      } else badSlot++;
      if (S.built.some((t) => t.slot === C.GATE)) gateBuilt++;
      cyclesSeen.add(S.cycle);
    }
    // every built tile sits on its own slot, in order
    const slots = S.built.map((t) => t.slot);
    if (S.pos !== C.GATE && slots.some((s, i) => s !== i + 1)) badSlot++;
  }
  ok(shortHand === 0, 'the hand is never empty before the gate', shortHand);
  ok(badDeck === 0, 'placement never asks the deck for a tile it does not have', badDeck);
  ok(badSlot === 0, 'every tile lands on the next slot of the path', badSlot);
  ok(gateBuilt === 0, 'the gate is never built over', gateBuilt);
  ok(cyclesSeen.has(1) && cyclesSeen.has(2) && cyclesSeen.has(3), 'campaigns reach all three cycles', [...cyclesSeen]);
}

// ---------- 3) no first tile can lose the dream ----------
{
  let lethal = 0, worst = { dmg: 0, delay: 0 };
  for (let seed = 1; seed <= 400; seed++) {
    const S = C.newDream(seed);
    for (const t of S.hand) {
      const f = C.forecast(S, t);
      if (f.dmg >= S.hp || f.delay >= S.gap) lethal++;
      worst = { dmg: Math.max(worst.dmg, f.dmg), delay: Math.max(worst.delay, f.delay) };
    }
  }
  ok(lethal === 0, 'no tile in the opening hand can end the dream on the first step', lethal);
  ok(worst.dmg < C.START.hp && worst.delay < C.START.gap, 'even the worst opening fight leaves hp and the chase intact', worst);
  // the first tile is always survivable by the cheapest choice too
  const S2 = C.newDream(9);
  ok(S2.hand.every((t) => C.forecast(S2, t).delay < S2.gap), 'the opening hand cannot be caught by the pursuer');
}

// ---------- 4) the deep-slot penalty, the heals, the terminal guards ----------
{
  // an enemy on slot >= DEEP bites one harder
  const S = C.newDream(4242);
  const e = { kind: 'enemy', hp: 4, atk: 3 };
  S.pos = C.DEEP - 2;
  S.atk = 4; S.def = 1;
  const near = C.forecast(S, e);
  S.pos = C.DEEP - 1;
  const deep = C.forecast(S, e);
  ok(deep.dmg === near.dmg + deep.rounds, 'from the deep slot on, every beast hits for one more per round', { near, deep });
  ok(deep.rounds === Math.max(1, Math.ceil(4 / 4)), 'rounds are ceil(hp / attack)', deep.rounds);
  ok(deep.delay === deep.rounds, 'a fight costs one slot of chase per round', deep.delay);

  // dew heals but never past MAXHP
  const H = C.newDream(5);
  H.hp = 11;
  H.hand = [{ kind: 'dew' }];
  C.place(H, 0);
  ok(H.hp === C.MAXHP, 'dew never heals past the cap', H.hp);

  // defence floors a blow at zero damage but the fight still costs chase
  const D = C.newDream(6);
  D.atk = 1; D.def = 9; D.gap = 8;
  D.hand = [{ kind: 'enemy', hp: 3, atk: 3 }];
  const r = C.place(D, 0);
  ok(r.f.dmg === 0, 'enough defence takes no damage', r.f.dmg);
  ok(D.gap === 8 - 3, 'a three-round fight still costs three slots of chase', D.gap);

  // guards
  const G = C.newDream(7);
  ok(C.place(G, 5).ok === false, 'a hand index with no tile is refused');
  G.over = true;
  ok(C.place(G, 0).ok === false, 'nothing can be placed after the dream ends');

  // the gate is walked, not built: sixteen laid tiles ends the cycle
  let second = null;
  for (let seed = 1; seed <= 40 && !second; seed++) {
    const W = C.newDream(seed);
    let n = 0;
    while (W.cycle === 1 && !W.over && n++ < 60) C.place(W, upgradeFirst(W));
    if (!W.over && W.cycle === 2) second = W;
  }
  ok(!!second, 'some dream walks a full cycle and steps through the gate');
  if (second) {
    ok(second.pos === 0, 'the gate opens an empty path in the next cycle', C.readState(second));
    ok(second.built.length === 0, 'a new cycle opens an empty path');
    ok(second.hand.length === C.HAND, 'a new cycle opens a fresh hand');
    ok(second.gap === C.START.gap, 'the pursuer is left behind at the gate');
    ok(second.placed === C.BUILD, 'the cycle took exactly BUILD laid tiles to leave', second.placed);
  }
}

// ---------- 5) pilots: the campaign ladder ----------
{
  let wins = 0, caught = 0, hpOut = 0, unfinished = 0, minPlaced = 1e9;
  for (let seed = 1; seed <= 300; seed++) {
    const S = campaign(seed, upgradeFirst);
    if (S.result === 'wake') { wins++; minPlaced = Math.min(minPlaced, S.placed); }
    else if (S.result === 'gap') caught++;
    else if (S.result === 'hp') hpOut++;
    else unfinished++;
  }
  T(`upgrade-first: ${wins}/300 wake, ${caught} caught by the pursuer, ${hpOut} out of hp, ${unfinished} unfinished`);
  ok(unfinished === 0, 'every campaign reaches a terminal state', unfinished);
  ok(wins >= 195, 'an upgrade-first visitor wakes up in at least two thirds of dreams', wins);
  ok(wins < 300, 'the dream still bites sometimes', wins);
  ok(minPlaced >= C.BUILD * C.CYCLES, 'a won campaign lays three full cycles of tiles', minPlaced);

  let rw = 0, rc = 0, rh = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const S = campaign(seed, rush);
    if (S.result === 'wake') rw++;
    if (S.result === 'gap') rc++;
    if (S.result === 'hp') rh++;
  }
  T(`enemy-first: ${rw}/300 wake, ${rc} caught, ${rh} out of hp`);
  ok(rc + rh >= 180, 'brawling at every tile gets the visitor killed in most dreams', { wins: rw, caught: rc, died: rh });
  ok(rw < wins, 'the ladder is real: upgrade-first beats enemy-first', { upgradeFirst: wins, rush: rw });
}

// ---------- 6) danger rises with the cycle ----------
{
  const avg = (cycle) => {
    let hp = 0, atk = 0, n = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = C.mulberry32(seed);
      const deck = C.makeDeck(rng, cycle);
      for (const t of deck) if (t.kind === 'enemy') { hp += t.hp; atk += t.atk; n++; }
    }
    return { hp: hp / n, atk: atk / n, n: n / 60 };
  };
  const c1 = avg(1), c2 = avg(2), c3 = avg(3);
  T(`cycle enemy averages: c1 hp ${c1.hp.toFixed(2)} atk ${c1.atk.toFixed(2)} · c2 hp ${c2.hp.toFixed(2)} atk ${c2.atk.toFixed(2)} · c3 hp ${c3.hp.toFixed(2)} atk ${c3.atk.toFixed(2)}`);
  ok(c2.hp > c1.hp && c3.hp > c2.hp, 'each cycle deals tougher creatures', { c1: c1.hp, c2: c2.hp, c3: c3.hp });
  ok(c2.atk > c1.atk && c3.atk > c2.atk, 'each cycle deals harder hitters', { c1: c1.atk, c2: c2.atk, c3: c3.atk });
  ok(c3.n >= c1.n, 'later cycles are at least as crowded', { c1: c1.n, c3: c3.n });
}

console.log(fails === 0 ? 'PASS dream core' : `FAIL dream core (${fails} assertion(s))`);
process.exit(fails === 0 ? 0 : 1);
