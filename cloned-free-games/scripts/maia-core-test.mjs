#!/usr/bin/env node
// Proves the Maia port's shipped rules and its rating ladder against the exact code the
// browser plays: the // >>>CORE ... // <<<CORE block is sliced out of the folder port.
//
// Assertions: perft 1/2/3 on the opening position (20 / 400 / 8902), the rating table is
// monotone, a low Maia rating really plays worse than a high one (average centipawn loss
// falls as the rating rises), head-to-head games go the higher rating's way from both
// colours, the same seed replays the same game, a mate on the board is taken by every
// rating, and no rating can blunder into an immediate loss from the opening.
//
// usage: node maia-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/mobile-maia/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { rc, idx, opp, START_FEN, parseFen, genPseudo, attacked, applyMove, legalMoves, inCheck,
  verdict, evalBoard, ordered, search, scoreMoves, MAIA, profileFor, mateInOne, mulberry32, maiaMove,
  sanOf, bestLine, MATE, VAL };`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { parseFen, applyMove, legalMoves, inCheck, verdict, evalBoard, scoreMoves, MAIA, profileFor,
  mulberry32, maiaMove, sanOf, START_FEN, MATE, opp } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const t0 = Date.now();

// ---- move generation: perft answers are the standard published counts
function perft(st, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const mv of legalMoves(st, st.turn)) n += perft(applyMove(st, mv), depth - 1);
  return n;
}
{
  const s = parseFen(START_FEN);
  const p1 = perft(s, 1), p2 = perft(s, 2), p3 = perft(s, 3);
  ok(p1 === 20, 'the opening position does not have 20 moves', p1);
  ok(p2 === 400, 'perft(2) is not 400', p2);
  ok(p3 === 8902, 'perft(3) is not 8902', p3);
  const moves = legalMoves(s, 'w');
  ok(moves.length === 20, 'legalMoves on the opening is not 20', moves.length);
  ok(verdict(s).over === false, 'the opening is reported terminal', null);
  console.log(`perft 1/2/3 = ${p1}/${p2}/${p3}`);
}

// ---- castling, en passant and promotion are the three places a generator goes wrong
{
  // white may castle both ways on an open back rank
  const st = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w');
  const mv = legalMoves(st, 'w');
  ok(mv.some((x) => x.from === 60 && x.to === 62), 'white cannot castle kingside', null);
  ok(mv.some((x) => x.from === 60 && x.to === 58), 'white cannot castle queenside', null);
  // and not through check
  const chk = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w');
  chk.b[61] = null; chk.b[53] = { t: 'r', c: 'b' }; // black rook on f3-ish file attacking f1
  ok(!legalMoves(chk, 'w').some((x) => x.from === 60 && x.to === 62), 'castling through check is allowed', null);
  // en passant: black has just pushed d7-d5, so the target square is d6 (index 19) and the
  // captured pawn is still standing on d5 (index 27)
  const ep = parseFen('4k3/8/8/3pP3/8/8/8/4K3 w');
  ep.ep = 19;
  ok(legalMoves(ep, 'w').some((x) => x.flags.ep && x.to === 19), 'en passant capture is missing', null);
  const epAfter = applyMove(ep, legalMoves(ep, 'w').find((x) => x.flags.ep));
  ok(!epAfter.b[27] && epAfter.b[19] && epAfter.b[19].t === 'p', 'en passant did not remove the passed pawn', epAfter.b.filter(Boolean).length);
  // promotion at the last rank
  const pr = parseFen('4k3/3P4/8/8/8/8/8/4K3 w');
  ok(legalMoves(pr, 'w').some((x) => x.flags.promo === 'q'), 'promotion is missing', null);
  // a pinned piece may not move off the pin
  const pin = parseFen('4k3/8/8/8/8/4r3/4P3/4K3 w');
  ok(!legalMoves(pin, 'w').some((x) => x.from === 52), 'a pinned pawn was allowed to move', null);
}

// ---- the rating table: monotone depth and temperature, every 200 from 600 to 2600
{
  ok(MAIA.length === 11, 'the rating table is not 11 steps', MAIA.length);
  let mono = true;
  for (let i = 1; i < MAIA.length; i++) {
    if (MAIA[i].rating !== MAIA[i - 1].rating + 200) mono = false;
    if (MAIA[i].temp >= MAIA[i - 1].temp) mono = false;
    if (MAIA[i].noise >= MAIA[i - 1].noise) mono = false;
    if (MAIA[i].depth < MAIA[i - 1].depth) mono = false;
  }
  ok(MAIA[0].rating === 600 && MAIA[10].rating === 2600, 'the table does not span 600..2600', [MAIA[0].rating, MAIA[10].rating]);
  ok(mono, 'the rating table is not monotone (temp/noise must fall, depth must not)', MAIA);
  const p = profileFor(1500);
  ok(p.rating === 1400 || p.rating === 1600, 'profileFor(1500) does not snap to a table rating', p.rating);
  ok(profileFor(0).rating === 600 && profileFor(99999).rating === 2600, 'profileFor does not clamp', [profileFor(0).rating, profileFor(99999).rating]);
  ok(profileFor(600).depth === 1 && profileFor(2600).depth === 2, 'the depth ladder is not 1..2', [profileFor(600).depth, profileFor(2600).depth]);
}

// ---- position samples: self-play at a mid rating, then score EVERY rating's choice
function playGame(whiteRating, blackRating, seedW, seedB, cap = 220) {
  let st = parseFen(START_FEN);
  const rw = mulberry32(seedW), rb = mulberry32(seedB);
  const line = [];
  let quiet = 0;
  for (let i = 0; i < cap; i++) {
    const moves = legalMoves(st, st.turn);
    if (!moves.length) {
      const mated = inCheck(st, st.turn);
      return { st, plies: i, result: mated ? (st.turn === 'w' ? 'b' : 'w') : 'draw', mated, line };
    }
    if (quiet >= 100) return { st, plies: i, result: 'draw', mated: false, line };
    const rating = st.turn === 'w' ? whiteRating : blackRating;
    const rnd = st.turn === 'w' ? rw : rb;
    const mv = maiaMove(st, st.turn, rating, rnd, i);
    if (!mv) return { st, plies: i, result: 'draw', mated: false, line };
    quiet = (mv.cap || st.b[mv.from].t === 'p') ? 0 : quiet + 1;
    line.push(sanOf(st, mv));
    st = applyMove(st, mv);
  }
  return { st, plies: cap, result: 'draw', mated: false, line };
}

const samples = [];
{
  let games = 0;
  for (const seed of [11, 29, 47, 83, 101, 137]) {
    let st = parseFen(START_FEN);
    const rw = mulberry32(seed), rb = mulberry32(seed * 7 + 3);
    let quiet = 0;
    for (let i = 0; i < 60; i++) {
      const moves = legalMoves(st, st.turn);
      if (!moves.length) break;
      if (i >= 8 && i % 4 === 0) samples.push({ st: { b: st.b.slice(), turn: st.turn, ep: st.ep, rights: Object.assign({}, st.rights) }, ply: i });
      const mv = maiaMove(st, st.turn, 1600, st.turn === 'w' ? rw : rb, i);
      quiet = (mv.cap || st.b[mv.from].t === 'p') ? 0 : quiet + 1;
      st = applyMove(st, mv);
    }
    games++;
  }
  console.log(`sampled ${samples.length} positions from ${games} self-play games @1600`);
  ok(samples.length >= 60, 'not enough ladder samples', samples.length);
}

// Average centipawn loss: how far the move the rating actually plays falls short of the
// best move available — measured on the port's own maiaMove, not a copy of its policy.
function acpl(rating, rndSeed) {
  const rnd = mulberry32(rndSeed);
  let total = 0, n = 0;
  for (const s of samples) {
    const scored = scoreMoves(s.st, s.st.turn, profileFor(rating).depth);
    if (!scored.length) continue;
    const best = Math.max(...scored.map((x) => x.s));
    if (best > MATE / 2) continue;          // a forced mate is not a rating sample
    const mv = maiaMove(s.st, s.st.turn, rating, rnd, s.ply);
    if (!mv) continue;
    const chosen = scored.find((x) => x.mv.from === mv.from && x.mv.to === mv.to);
    if (!chosen) continue;
    total += Math.max(0, Math.min(1200, best - chosen.s));
    n++;
  }
  return { acpl: total / Math.max(1, n), n };
}

{
  const ladder = [];
  for (const r of [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600]) {
    const a = acpl(r, 9001 + r);
    ladder.push([r, Number(a.acpl.toFixed(1))]);
  }
  console.log('rating -> average centipawn loss:');
  for (const [r, a] of ladder) console.log(`  ${r}: ${a} cp`);
  const low = ladder.find((x) => x[0] === 600)[1];
  const mid = ladder.find((x) => x[0] === 1400)[1];
  const high = ladder.find((x) => x[0] === 2600)[1];
  ok(low > mid, `600 does not play worse than 1400 (${low} vs ${mid})`, null);
  ok(mid > high, `1400 does not play worse than 2600 (${mid} vs ${high})`, null);
  ok(low - high >= 60, `the ladder is flat: 600 only ${low} vs 2600 ${high}`, null);
  let nonMono = 0;
  for (let i = 1; i < ladder.length; i++) if (ladder[i][1] > ladder[i - 1][1] + 12) nonMono++;
  ok(nonMono === 0, 'a higher rating scored a materially worse average loss', ladder);
}

// ---- head to head: the higher rating must win from both colours
{
  const pair = (ra, rb, seeds) => {
    let aw = 0, bw = 0, dr = 0;
    const games = [];
    for (const seed of seeds) {
      const aWhite = playGame(ra, rb, seed, seed * 13 + 5);
      const aBlack = playGame(rb, ra, seed * 17 + 9, seed + 71);
      for (const [g, aIsWhite] of [[aWhite, true], [aBlack, false]]) {
        const aWon = g.result === (aIsWhite ? 'w' : 'b');
        const bWon = g.result === (aIsWhite ? 'b' : 'w');
        if (aWon) aw++; else if (bWon) bw++; else dr++;
        games.push({ aIsWhite, result: g.result, plies: g.plies, moves: g.plies });
      }
    }
    return { aw, bw, dr, games };
  };
  const t1 = Date.now();
  const wide = pair(600, 2400, [3, 19, 61]);
  console.log(`600 vs 2400: 600 won ${wide.aw}, 2400 won ${wide.bw}, draws ${wide.dr} (${Math.round((Date.now() - t1) / 100) / 10}s)`);
  ok(wide.bw >= 5, `2400 did not dominate 600 (won ${wide.bw} of ${wide.aw + wide.bw + wide.dr})`, wide.games);
  ok(wide.aw <= 1, `600 beat 2400 too often (${wide.aw})`, wide.games);

  const t2 = Date.now();
  const close_ = pair(1600, 2400, [5, 23, 97]);
  console.log(`1600 vs 2400: 1600 won ${close_.aw}, 2400 won ${close_.bw}, draws ${close_.dr} (${Math.round((Date.now() - t2) / 100) / 10}s)`);
  ok(close_.bw > close_.aw, `2400 did not outscore 1600 (${close_.bw} vs ${close_.aw})`, close_.games);
}

// ---- the same seed replays the same game, and seed is honoured through mulberry32
{
  const a = playGame(1200, 1600, 777, 778, 40);
  const b = playGame(1200, 1600, 777, 778, 40);
  ok(a.line.join(' ') === b.line.join(' '), 'the same seeds did not replay the same line',
    { a: a.line.slice(0, 8), b: b.line.slice(0, 8) });
  const c = playGame(1200, 1600, 779, 780, 40);
  ok(a.line.join(' ') !== c.line.join(' '), 'different seeds produced an identical line', a.line.slice(0, 8));
  // and a deterministic first move: the opening reply is stable for a given seed
  const first = (s) => playGame(1500, 1500, s, s + 1, 3).line[1];
  ok(first(31) === first(31), 'the engine first reply is not deterministic for a seed', [first(31)]);
  ok(legalMoves(parseFen(START_FEN), 'w').length === 20, 'the visitor has no legal first move', null);
}

// ---- a mate on the board is taken by every rating, and a mate is never missed for a blunder
{
  for (const r of [600, 900, 1500, 2000, 2600]) {
    // black to move, Qh4# style: white king on g1, black queen to h4 with support... use a
    // simple back-rank mate available in one: black rook d8 to d1 is mate (king g1, pawns f2/g2/h2)
    const st = parseFen('3r2k1/8/8/8/8/8/5PPP/6K1 b');
    const mate = maiaMove(st, 'b', r, mulberry32(5), 40);
    ok(!!mate, `rating ${r} found no move at all`, null);
    if (mate) {
      const after = applyMove(st, mate);
      const v = verdict(after);
      ok(v.over && v.mated && v.winner === 'b', `rating ${r} missed a mate in one`, sanOf(st, mate));
    }
  }
}

// ---- no instant loss: the boot position offers the visitor 20 moves and the seeded
// engine's first replies are legal and never end the game in the opening
{
  for (const r of [600, 2600]) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = playGame(1500, r, seed, seed * 3 + 1, 4);
      ok(g.plies === 4, `a game at Maia ${r} was already over after 4 plies (seed ${seed}, result ${g.result})`, g.line.join(' '));
    }
  }
}

console.log(`\ncore test: ${fails ? 'FAIL' : 'PASS'} (${fails} failure(s), ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fails ? 1 : 0);
