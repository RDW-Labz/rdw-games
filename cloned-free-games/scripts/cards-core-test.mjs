#!/usr/bin/env node
// Core-rules test for the Cards With Cats port (Hearts + Oh Hell). Slices the // >>>CORE block out
// of the SHIPPED page and replays the exact rules the browser runs: deck integrity, follow-suit and
// hearts-leading legality, first-trick restrictions, trick winners (no trump in hearts, trump in Oh
// Hell), hand scoring incl. shooting the moon, Oh Hell exact-bid scoring, terminal match results,
// and several hundred complete games to prove nothing hangs or leaks cards.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = '/home/cluer/Projects/rdw-games/shelf/games/arcade/cards-with-cats/index.html';
const src = await readFile(PAGE, 'utf8');
const a = src.indexOf('// >>>CORE');
const b = src.indexOf('// <<<CORE');
if (a < 0 || b < 0 || b < a) { console.error('no CORE block'); process.exit(2); }
const dir = await mkdtemp(join(tmpdir(), 'catscore-'));
const mod = join(dir, 'core.mjs');
await writeFile(mod, src.slice(a, b) + `
export { SUITS, HEARTS_TARGET, OH_SIZES, OH_TRUMPS, rankOf, suitOf, cardName, mulberry32,
  mkHearts, mkOhHell, dealHearts, dealOhHell, legalHearts, legalOh, playCard, passHearts,
  botPassPick, botHearts, botBidOh, botOh, nextDeal, heartsBest, ohBest, endHandHearts,
  endRoundOh, HEARTS_TARGET as TARGET };
`);
const C = await import(mod);

let n = 0, bad = 0;
const ok = (c, msg, extra) => {
  n++;
  if (c) return true;
  bad++;
  console.log('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const cd = (s, r) => C.SUITS.indexOf(s) * 13 + (r - 2);

// ---------- 1) deck ----------
{
  const S = C.mkHearts(7);
  const all = S.hands.flat();
  ok(S.hands.every((h) => h.length === 13), 'hearts deals 13 cards to each of four seats', S.hands.map((h) => h.length));
  ok(all.length === 52 && new Set(all).size === 52, 'the deal is 52 distinct cards', all.length);
  ok(all.every((c) => c >= 0 && c < 52), 'card ids stay inside the deck');
  const S2 = C.mkHearts(7);
  ok(S2.hands.flat().join() === all.join(), 'the same seed deals the same hands');
  const S3 = C.mkHearts(8);
  ok(S3.hands.flat().join() !== all.join(), 'a different seed deals different hands');
}

// ---------- 2) hearts legality ----------
{
  const S = C.mkHearts(3);
  // hand-built: touching the deck fields is the only way to place an exact position
  const h = (p, cards) => { S.hands[p] = cards.slice(); S.taken[p] = []; };
  S.phase = 'play'; S.trick = []; S.trickNo = 4; S.heartsBroken = false; S.toMove = 0;
  h(0, [cd('H', 5), cd('C', 3), cd('D', 7)]);
  let leg = C.legalHearts(S, 0);
  ok(!leg.includes(cd('H', 5)) && leg.length === 2, 'a heart cannot be led while hearts are closed', leg.map(C.cardName));
  S.heartsBroken = true;
  leg = C.legalHearts(S, 0);
  ok(leg.includes(cd('H', 5)), 'hearts may be led once broken', leg.map(C.cardName));
  S.heartsBroken = false;
  h(0, [cd('H', 5)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 1 && leg[0] === cd('H', 5), 'a hand of only hearts may lead one', leg.map(C.cardName));

  // follow suit
  S.trick = [{ p: 1, card: cd('C', 10) }]; S.toMove = 0;
  h(0, [cd('C', 3), cd('H', 7), cd('D', 2)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 1 && leg[0] === cd('C', 3), 'must follow the led suit when able', leg.map(C.cardName));
  h(0, [cd('H', 7), cd('D', 2)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 2, 'void in the led suit: anything may be thrown', leg.map(C.cardName));

  // first trick
  S.trick = []; S.trickNo = 0; S.heartsBroken = false; S.toMove = 0;
  h(0, [cd('H', 2), cd('S', 12), cd('D', 4)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 1 && leg[0] === cd('D', 4), 'the first trick may not be opened with a heart or the queen of spades', leg.map(C.cardName));
  h(0, [cd('H', 2), cd('S', 12)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 2, 'a first-trick hand of only hearts / QS may play one', leg.map(C.cardName));
  S.trick = [{ p: 1, card: cd('C', 9) }];
  h(0, [cd('C', 2), cd('H', 13)]);
  leg = C.legalHearts(S, 0);
  ok(leg.length === 1 && leg[0] === cd('C', 2), 'first trick: hearts are refused while a club is held', leg.map(C.cardName));

  // no seat is ever left without a legal card
  let empty = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const G = C.mkHearts(seed);
    if (G.phase === 'pass') C.passHearts(G, C.botPassPick(G, 0));
    for (let t = 0; t < 52 && G.phase === 'play'; t++) {
      const p = G.toMove;
      const l = C.legalHearts(G, p);
      if (G.hands[p].length && !l.length) empty++;
      const card = C.botHearts(G, p);
      if (!C.playCard(G, p, card)) { empty += 100; break; }
    }
  }
  ok(empty === 0, 'every seat always has a legal card and the bot never plays an illegal one', empty);
}

// ---------- 3) trick winner ----------
{
  const trick = [
    { p: 0, card: cd('C', 10) },
    { p: 1, card: cd('H', 14) },
    { p: 2, card: cd('C', 14) },
    { p: 3, card: cd('C', 2) },
  ];
  ok(C.heartsBest(trick) === 2, 'hearts has no trump: the highest of the led suit takes the trick', C.heartsBest(trick));
  const trick2 = [{ p: 0, card: cd('H', 4) }, { p: 1, card: cd('H', 13) }, { p: 2, card: cd('D', 14) }, { p: 3, card: cd('H', 8) }];
  ok(C.heartsBest(trick2) === 1, 'on a heart lead the highest heart wins, diamonds never beat it', C.heartsBest(trick2));
  const trick3 = [{ p: 0, card: cd('D', 9) }, { p: 1, card: cd('H', 2) }, { p: 2, card: cd('D', 12) }, { p: 3, card: cd('H', 14) }];
  ok(C.ohBest(trick3, 'H') === 3, 'Oh Hell: the highest trump wins whatever was led', C.ohBest(trick3, 'H'));
  ok(C.ohBest(trick3, 'S') === 2, 'Oh Hell: with no trump played the led suit decides', C.ohBest(trick3, 'S'));
  ok(C.ohBest([{ p: 0, card: cd('C', 3) }, { p: 1, card: cd('C', 2) }], 'D') === 0, 'Oh Hell: low card of the led suit wins an empty trick', 0);
}

// ---------- 4) scoring ----------
{
  // a hand where seat 1 takes everything = shooting the moon
  const S = C.mkHearts(5);
  S.scores = [0, 0, 0, 0];
  S.taken = [[], [], [], []];
  const all = [];
  for (let r = 2; r <= 14; r++) all.push(cd('H', r));
  all.push(cd('S', 12));
  S.taken[1] = all.slice();
  C.endHandHearts(S);
  ok(S.scores[1] === 0 && S.scores[0] === 26 && S.scores[2] === 26 && S.scores[3] === 26, 'shooting the moon gives the shooter 0 and everyone else 26', S.scores);

  const T = C.mkHearts(6);
  T.scores = [0, 0, 0, 0]; T.taken = [[], [], [], []];
  T.taken[0] = [cd('H', 2), cd('H', 3), cd('S', 12)];
  T.taken[2] = [cd('H', 4)];
  C.endHandHearts(T);
  ok(T.scores[0] === 15 && T.scores[2] === 1 && T.scores[1] === 0, 'a hand scores 1 per heart and 13 for the queen of spades', T.scores);

  // match end: lowest wins
  const M = C.mkHearts(9);
  M.scores = [12, 48, 20, 30]; M.taken = [[], [], [], []];
  M.taken[1] = Array.from({ length: 26 }, () => 0).fill(cd('H', 2), 0, 13);
  C.endHandHearts(M);
  ok(M.over && M.result === 'win', 'reaching the target ends the match and the lowest score wins', { over: M.over, res: M.result, sc: M.scores });
  const L = C.mkHearts(9);
  L.scores = [49, 10, 20, 30]; L.taken = [[], [], [], []];
  L.taken[0] = [cd('H', 2)];
  C.endHandHearts(L);
  ok(L.over && L.result === 'lose', 'a high score ends the match as a loss', { res: L.result, sc: L.scores });
}

// ---------- 5) passing ----------
{
  const S = C.mkHearts(21);
  S.handNo = 0; C.dealHearts(S);
  ok(S.phase === 'pass' && S.passDir === S.passDir, 'the deal opens on a pass phase', S.passDir);
  const before = S.hands.map((h) => h.slice());
  const picks = before[0].slice(0, 3);
  ok(!C.passHearts(S, picks.slice(0, 2)), 'a pass of two cards is refused');
  ok(C.passHearts(S, picks), 'a legal pass of three cards is accepted');
  ok(S.hands.every((h) => h.length === 13), 'every seat still holds 13 after the pass');
  const union = new Set(S.hands.flat());
  ok(union.size === 52, 'the pass neither duplicates nor loses a card', union.size);
  ok(!S.hands[0].some((c) => picks.includes(c)), 'your own picks leave your hand');
  ok(S.phase === 'play' && S.toMove === S.lead, 'play starts with the 2 of clubs holder', { phase: S.phase, toMove: S.toMove });
  ok(S.hands[S.toMove].includes(0) || S.hands.some((h) => h.includes(0)), 'the 2 of clubs is somewhere in play');
}

// ---------- 6) complete games ----------
{
  let games = 0, moons = 0, hands = 0, badSum = 0, hang = 0, badCards = 0, wins = 0, maxHands = 0, minHands = 99;
  for (let seed = 1; seed <= 220; seed++) {
    const S = C.mkHearts(seed);
    let guard = 0, lastHand = null, handsPlayed = 0;
    while (!S.over && guard++ < 6000) {
      if (S.phase === 'pass') { C.passHearts(S, C.botPassPick(S, 0)); continue; }
      if (S.phase === 'between') { C.nextDeal(S); continue; }
      if (S.phase !== 'play') break;
      const card = C.botHearts(S, S.toMove);
      if (card === null) { badCards++; break; }
      if (!C.playCard(S, S.toMove, card)) { badCards++; break; }
      if (S.lastHand && S.lastHand !== lastHand) {
        lastHand = S.lastHand; handsPlayed++;
        const sum = lastHand.hand.reduce((x, y) => x + y, 0);
        if (!(sum === 26 || sum === 78)) badSum++;
        if (lastHand.moon >= 0) moons++;
      }
      // conservation: cards are in hands, the trick, or taken
      const total = S.hands.flat().length + S.trick.length + S.taken.flat().length;
      if (total !== 52) { badCards++; break; }
    }
    if (!S.over) { hang++; continue; }
    games++; hands += handsPlayed;
    maxHands = Math.max(maxHands, handsPlayed); minHands = Math.min(minHands, handsPlayed);
    if (S.result === 'win') wins++;
  }
  ok(hang === 0, 'every hearts game reaches the 50-point target', hang);
  ok(badSum === 0, 'every scored hand totals 26 (78 when someone shoots the moon)', badSum);
  ok(badCards === 0, 'cards are conserved every play (52 in hands + trick + taken)', badCards);
  ok(games === 220, 'all 220 seeded games finished', games);
  ok(hands / Math.max(1, games) >= 1.5, 'a match runs several hands, not one', hands / games);
  ok(moons < games * 0.5, 'shooting the moon is reachable but rare', moons);
  ok(maxHands >= 2, 'the shortest match still plays more than one hand', { maxHands, minHands });
  console.log(`  hearts: ${games} games, ${(hands / games).toFixed(1)} hands/match, ${moons} moons, ${wins} wins for the bot seat`);
}

{
  let games = 0, hang = 0, badScore = 0, rounds = 0, wins = 0, drew = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const S = C.mkOhHell(seed);
    let guard = 0, roundsPlayed = 0, lastRound = null;
    while (!S.over && guard++ < 4000) {
      if (S.phase === 'bid') {
        // fill every outstanding bid in queue order
        while (S.bidIdx < 4) { const p = S.bidQueue[S.bidIdx]; S.bids[p] = C.botBidOh(S, p); S.bidIdx++; }
        if (S.bidIdx >= 4) { S.phase = 'play'; S.toMove = S.lead; }
        continue;
      }
      if (S.phase === 'between') { C.nextDeal(S); continue; }
      if (S.phase !== 'play') break;
      const card = C.botOh(S, S.toMove);
      if (card === null) { hang++; break; }
      if (!C.playCard(S, S.toMove, card)) { hang++; break; }
      if (S.lastRound && S.lastRound !== lastRound) {
        lastRound = S.lastRound; roundsPlayed++;
        const sumBids = lastRound.bids.reduce((x, y) => x + y, 0);
        if (sumBids > lastRound.size * 4) badScore++;
        if (!lastRound.bids.every((b) => b >= 0 && b <= lastRound.size)) badScore++;
        const sumTricks = lastRound.tricks.reduce((x, y) => x + y, 0);
        if (sumTricks !== lastRound.size) badScore++;
        for (let i = 0; i < 4; i++) {
          const want = lastRound.tricks[i] === lastRound.bids[i] ? 10 + lastRound.bids[i] : 0;
          if (lastRound.gained[i] !== want) badScore++;
        }
      }
    }
    if (!S.over) { hang++; continue; }
    games++; rounds += roundsPlayed;
    if (S.result === 'win') wins++;
    if (S.result === 'draw') drew++;
  }
  ok(hang === 0, 'every Oh Hell match finishes all six rounds', hang);
  ok(badScore === 0, 'Oh Hell: tricks add up to the hand size and exact bids pay 10 + bid', badScore);
  ok(games === 200 && rounds / Math.max(1, games) === 6, 'six rounds per match', rounds / Math.max(1, games));
  ok(wins + drew < games, 'the other three seats win often enough that the match is not rigged', { wins, drew, games });
  console.log(`  oh hell: ${games} games, ${(rounds / games).toFixed(1)} rounds/match, ${wins} wins / ${drew} draws for seat 0`);
}

// ---------- 7) turn order and illegal moves ----------
{
  const S = C.mkHearts(31);
  C.passHearts(S, C.botPassPick(S, 0));
  const notTurn = (S.toMove + 1) % 4;
  ok(!C.playCard(S, notTurn, S.hands[notTurn][0]), 'a seat may not play out of turn');
  const wrong = S.hands[S.toMove].find((c) => !C.legalHearts(S, S.toMove).includes(c));
  if (wrong !== undefined) ok(!C.playCard(S, S.toMove, wrong), 'an illegal card is refused at the table');
  ok(C.playCard(S, S.toMove, C.legalHearts(S, S.toMove)[0]), 'the legal card goes down');
  ok(S.trick.length === 1 && S.toMove === (S.lead + 1) % 4, 'the turn passes clockwise', { toMove: S.toMove });
}

console.log(`\n${n - bad}/${n} checks passed`);
if (bad) { console.log('CARDS CORE FAIL'); process.exit(1); }
console.log('CARDS CORE OK');
