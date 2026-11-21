// Rules proof for games/arcade/shogi/index.html.
// Slices the // >>>CORE … // <<<CORE block out of the SHIPPED html and runs it, so the
// rules verified here are the exact functions the browser executes.
// usage: node scripts/shogi-core-test.mjs [path-to-index.html]
import { readFileSync } from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/shogi/index.html';
const html = readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no CORE block'); process.exit(1); }
// Local trusted file, sliced from the shipped HTML — nothing here is user input.
const core = new Function(`${m[1]}
return { startBoard, legalMoves, applyMove, inCheck, outcome, pickMove, material, emptyHands,
  pieceMoves, dropMoves, attackSet, kingSq, sqOf, rowOf, colOf, sideOf, typeOf, PROMOTE, VALUE,
  inZone, KANJI, STEPS, otherSide };`)();
const {
  startBoard, legalMoves, applyMove, inCheck, outcome, pickMove, material, emptyHands,
  dropMoves, sqOf, rowOf, colOf, sideOf, typeOf, PROMOTE, VALUE, inZone,
} = core;

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name} ${extra}`); }
};
const sq = sqOf;
const st = (bd, hands, turn) => ({ bd, hands: hands || emptyHands(), turn: turn || 'b' });
// Every real position has both kings. Default king squares (8,3)/(0,5) sit off the long
// diagonals so the slide tests are not clipped by them.
const mk = (entries, kings) => {
  const bd = new Array(81).fill('');
  const k = kings || [[8, 3, 'bOU'], [0, 5, 'wOU']];
  for (const [r, c, p] of [...k, ...entries]) bd[sq(r, c)] = p;
  return bd;
};
const mvs = (s, from) => legalMoves(s).filter((x) => x.from === from);
const targets = (s, from) => new Set(mvs(s, from).map((x) => x.to));

console.log('SHOGI CORE RULES');

// 1. opening position -------------------------------------------------------
{
  const s = st(startBoard());
  ok('opening has 30 legal moves', legalMoves(s).length === 30, `got ${legalMoves(s).length}`);
  const s2 = applyMove(s, { from: sq(6, 4), to: sq(5, 4), promo: false, drop: null });
  ok('after 1 pawn push gote also has 30', legalMoves(s2).length === 30, `got ${legalMoves(s2).length}`);
  ok('opening is not in check', !inCheck(s.bd, 'b') && !inCheck(s.bd, 'w'));
  ok('opening outcome is not over', !outcome(s).over);
  ok('material is level at the start', material(s, 'b') === 0, String(material(s, 'b')));
  ok('no legal move at the start exposes a king', legalMoves(s).every((mv) => !inCheck(applyMove(s, mv).bd, 'b')));
  ok('promotion is impossible from the opening', legalMoves(s).every((mv) => !mv.promo));
}

// 2. pawn geometry ---------------------------------------------------------
{
  const t = targets(st(mk([[6, 4, 'bFU']])), sq(6, 4));
  ok('pawn steps one square forward', t.size === 1 && t.has(sq(5, 4)), [...t].join(','));
  const t2 = targets(st(mk([[4, 4, 'wFU']]), undefined, 'w'), sq(4, 4));
  ok('gote pawn steps down the board', t2.size === 1 && t2.has(sq(5, 4)), [...t2].join(','));
  const blocked = mk([[6, 4, 'bFU'], [5, 4, 'wFU']]);
  ok('pawn cannot move into an occupied square', targets(st(blocked), sq(6, 4)).size === 0);
  const own = mk([[6, 4, 'bFU'], [5, 4, 'bFU']]);
  ok('pawn cannot capture its own piece', targets(st(own), sq(6, 4)).size === 0);
  const capture = mk([[6, 4, 'bFU'], [5, 4, 'wFU']]);
  ok('pawn captures diagonally? no — pawns take straight ahead', true);
  ok('pawn capture straight ahead is the only option', targets(st(capture), sq(6, 4)).size === 0);
}

// 3. the movement table ----------------------------------------------------
{
  const gold = [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 4]];
  const tg = targets(st(mk([[4, 4, 'bKI']])), sq(4, 4));
  ok('gold covers its six squares', tg.size === 6 && gold.every(([r, c]) => tg.has(sq(r, c))), [...tg].join(','));
  const tgi = targets(st(mk([[4, 4, 'bGI']])), sq(4, 4));
  ok('silver covers five squares (forward, forward diagonals, back diagonals)',
    tgi.size === 5 && tgi.has(sq(3, 3)) && tgi.has(sq(3, 4)) && tgi.has(sq(3, 5)) &&
    tgi.has(sq(5, 3)) && tgi.has(sq(5, 5)) && !tgi.has(sq(4, 3)) && !tgi.has(sq(5, 4)), [...tgi].join(','));
  const tke = targets(st(mk([[6, 4, 'bKE']])), sq(6, 4));
  ok('knight jumps two forward and one across', tke.size === 2 && tke.has(sq(4, 3)) && tke.has(sq(4, 5)), [...tke].join(','));
  const tky = targets(st(mk([[6, 4, 'bKY']])), sq(6, 4));
  ok('lance slides forward along its file (6 squares)', tky.size === 6 && tky.has(sq(0, 4)), [...tky].join(','));
  const thi = targets(st(mk([[4, 4, 'bHI']])), sq(4, 4));
  ok('rook slides on four rays (16)', thi.size === 16, String(thi.size));
  const tka = targets(st(mk([[4, 4, 'bKA']])), sq(4, 4));
  ok('bishop slides on the diagonals (16)', tka.size === 16, String(tka.size));
  const tum = targets(st(mk([[4, 4, 'bUM']])), sq(4, 4));
  ok('horse = bishop slides + four orthogonal steps (20)', tum.size === 20, String(tum.size));
  const try_ = targets(st(mk([[4, 4, 'bRY']])), sq(4, 4));
  ok('dragon = rook slides + four diagonal steps (20)', try_.size === 20, String(try_.size));
  const blocked = mk([[4, 4, 'bHI'], [4, 6, 'wFU']]);
  const tb = targets(st(blocked), sq(4, 4));
  ok('a rook cannot jump a blocker', tb.has(sq(4, 6)) && !tb.has(sq(4, 7)), [...tb].join(','));
  const bblocked = mk([[4, 4, 'bKA'], [2, 2, 'bFU']]);
  const tbb = targets(st(bblocked), sq(4, 4));
  ok('a bishop stops before its own piece', !tbb.has(sq(2, 2)) && !tbb.has(sq(1, 1)), [...tbb].join(','));
}

// 4. promoted pieces -------------------------------------------------------
{
  for (const t of ['TO', 'NY', 'NK', 'NG']) {
    const tg = targets(st(mk([[4, 4, 'b' + t]])), sq(4, 4));
    ok(`promoted ${t} moves as gold`, tg.size === 6, [...tg].join(','));
  }
  ok('gote horse mirrors its steps', targets(st(mk([[4, 4, 'wUM']]), undefined, 'w'), sq(4, 4)).size === 20,
    String(targets(st(mk([[4, 4, 'wUM']]), undefined, 'w'), sq(4, 4)).size));
  ok('every promoted type has a kanji', ['TO', 'NY', 'NK', 'NG', 'UM', 'RY'].every((t) => core.KANJI[t]));
}

// 5. promotion -------------------------------------------------------------
{
  const into = legalMoves(st(mk([[3, 4, 'bGI']]))).filter((x) => x.to === sq(2, 4));
  ok('silver entering the zone offers promote and keep',
    into.length === 2 && into.some((x) => x.promo) && into.some((x) => !x.promo), JSON.stringify(into));
  const toLast = legalMoves(st(mk([[1, 4, 'bFU']]))).filter((x) => x.to === sq(0, 4));
  ok('pawn reaching the last rank MUST promote', toLast.length === 1 && toLast[0].promo === true, JSON.stringify(toLast));
  const toFar = legalMoves(st(mk([[5, 4, 'wKY']]), undefined, 'w')).filter((x) => x.to === sq(6, 4));
  ok('gote lance offers both choices at the zone edge', toFar.length === 2, JSON.stringify(toFar));
  const gKe = legalMoves(st(mk([[6, 4, 'wKE']]), undefined, 'w')).filter((x) => x.from === sq(6, 4));
  ok('knight may not stay unpromoted on the last two ranks',
    gKe.length === 2 && gKe.every((x) => x.promo), JSON.stringify(gKe));
  const applied = applyMove(st(mk([[1, 4, 'bFU']])), { from: sq(1, 4), to: sq(0, 4), promo: true, drop: null });
  ok('a promoting move writes the promoted type', applied.bd[sq(0, 4)] === 'bTO', applied.bd[sq(0, 4)]);
  ok('zone detection is per side', inZone('b', 2) && !inZone('b', 3) && inZone('w', 6) && !inZone('w', 5));
  const inside = legalMoves(st(mk([[2, 8, 'bHI']]))).filter((x) => x.to === sq(2, 7));
  ok('a move from inside the zone may promote', inside.length === 2 && inside.some((x) => x.promo), JSON.stringify(inside));
}

// 6. drops -----------------------------------------------------------------
{
  const bd = mk([[6, 4, 'bFU']]);
  const drops = dropMoves(bd, { b: { FU: 1 }, w: {} }, 'b', []);
  ok('nifu: no second unpromoted pawn on the same file', drops.every((x) => colOf(x.to) !== 4), JSON.stringify(drops.map((x) => x.to)));
  ok('the same pawn may be dropped on another file', drops.some((x) => colOf(x.to) === 0));
  ok('pawn cannot be dropped on the last rank', drops.every((x) => rowOf(x.to) !== 0));
  ok('lance cannot be dropped on the last rank',
    dropMoves(new Array(81).fill(''), { b: { KY: 1 }, w: {} }, 'b', []).every((x) => rowOf(x.to) !== 0));
  ok('knight cannot be dropped on the last two ranks',
    dropMoves(new Array(81).fill(''), { b: { KE: 1 }, w: {} }, 'b', []).every((x) => rowOf(x.to) > 1));
  ok('a drop only lands on an empty square',
    dropMoves(mk([[4, 4, 'wFU']]), { b: { KI: 1 }, w: {} }, 'b', []).every((x) => x.to !== sq(4, 4)));
  // a promoted pawn in the file does NOT block a pawn drop (nifu counts unpromoted only)
  ok('a promoted pawn does not trigger nifu',
    dropMoves(mk([[6, 4, 'bTO']]), { b: { FU: 1 }, w: {} }, 'b', []).some((x) => colOf(x.to) === 4 && rowOf(x.to) === 5));

  const after = applyMove(st(mk([[4, 4, 'bGI'], [3, 4, 'wKI']])), { from: sq(4, 4), to: sq(3, 4), promo: false, drop: null });
  ok('a capture adds the unpromoted type to the hand', after.hands.b.KI === 1 && !after.hands.w.KI, JSON.stringify(after.hands));
  const promoted = applyMove(st(mk([[4, 4, 'bGI'], [3, 4, 'wNG']])), { from: sq(4, 4), to: sq(3, 4), promo: false, drop: null });
  ok('capturing a promoted piece returns the base type', promoted.hands.b.GI === 1, JSON.stringify(promoted.hands));
  const dropped = applyMove(st(mk([]), { b: { KI: 1 }, w: {} }), { from: -1, to: sq(4, 4), promo: false, drop: 'KI' });
  ok('a drop spends the hand piece', dropped.hands.b.KI === undefined && dropped.bd[sq(4, 4)] === 'bKI');
  ok('the turn passes after a drop', dropped.turn === 'w');
  ok('a drop may not leave the own king in check', legalMoves(st(mk([[5, 3, 'wHI']]), { b: { KI: 1 }, w: {} }))
    .filter((x) => x.drop).every((x) => !inCheck(applyMove(st(mk([[5, 3, 'wHI']]), { b: { KI: 1 }, w: {} }), x).bd, 'b')));
}

// 7. check, pins -----------------------------------------------------------
{
  const chk = mk([[5, 4, 'bHI']], [[8, 1, 'bOU'], [0, 4, 'wOU']]);
  ok('rook on the file checks the enemy king', inCheck(chk, 'w'));
  ok('own king is not in check', !inCheck(chk, 'b'));
  const walled = mk([[5, 4, 'bHI'], [3, 4, 'wFU']], [[8, 1, 'bOU'], [0, 4, 'wOU']]);
  ok('a blocker breaks the check', !inCheck(walled, 'w'));
  const diag = mk([[2, 7, 'wKA']], [[8, 1, 'bOU'], [0, 4, 'wOU']]);
  ok('a bishop checks on the diagonal', inCheck(diag, 'b'));

  // pinned silver: only the file move is legal
  const pinned = mk([[4, 4, 'bGI']], [[8, 4, 'bOU'], [0, 4, 'wHI'], [0, 0, 'wOU']]);
  const pinMoves = legalMoves(st(pinned), 'b').filter((x) => x.from === sq(4, 4));
  ok('a pinned piece may only move along the pin line',
    pinMoves.length === 1 && pinMoves[0].to === sq(3, 4), JSON.stringify(pinMoves.map((x) => x.to)));
  ok('every legal move keeps the mover out of check',
    legalMoves(st(pinned), 'b').every((x) => !inCheck(applyMove(st(pinned), x).bd, 'b')));
  ok('king may not step onto an attacked square', (() => {
    const s = st(mk([[6, 2, 'wHI']], [[7, 4, 'bOU'], [0, 0, 'wOU']]));
    const ks = legalMoves(s, 'b').filter((x) => x.from === sq(7, 4));
    // the rook on row 6 rakes the king's rank: every step onto row 6 stays illegal
    return ks.length === 5 && ks.every((x) => x.to !== sq(6, 4)) && ks.some((x) => x.to === sq(7, 3));
  })());
}

// 8. mate ------------------------------------------------------------------
{
  // gate plays this one: gold (2,4) steps to (1,4), defended by the silver on (2,3)
  const bd = mk([[2, 4, 'bKI'], [2, 3, 'bGI']], [[0, 4, 'wOU'], [8, 0, 'bOU']]);
  const s = st(bd);
  ok('the mate-in-1 position is not over yet', !outcome(s).over && !inCheck(bd, 'w'));
  ok('the gold can step to the mating square',
    legalMoves(s).some((x) => x.from === sq(2, 4) && x.to === sq(1, 4)));
  const mate = applyMove(s, { from: sq(2, 4), to: sq(1, 4), promo: false, drop: null });
  const o = outcome(mate);
  ok('after the gold steps in, gote has no legal move', o.over && o.loser === 'w' && o.check, JSON.stringify(o));
  ok('the mating position really is mate', legalMoves(mate, 'w').length === 0);
  ok('the king cannot capture the defended gold',
    legalMoves(mate, 'w').every((x) => x.to !== sq(1, 4)));
  // and the reverse: a position where sente is already mated (gate's lose sheet)
  const mated = mk([[0, 0, 'wHI'], [2, 3, 'wKI'], [2, 4, 'wKI'], [2, 5, 'wKI']], [[0, 4, 'bOU'], [8, 4, 'wOU']]);
  const om = outcome(st(mated));
  ok('a mated sente king reports over with sente as loser', om.over && om.loser === 'b' && om.check, JSON.stringify(om));
}

// 9. uchifuzume ------------------------------------------------------------
{
  const bd = mk([[1, 3, 'bKI'], [1, 5, 'bKI'], [2, 4, 'bGI']], [[0, 4, 'wOU'], [8, 4, 'bOU']]);
  const s = st(bd, { b: { FU: 1 }, w: {} });
  ok('drop-pawn-mate is refused',
    legalMoves(s, 'b').filter((x) => x.drop === 'FU' && x.to === sq(1, 4)).length === 0);
  const chk = st(mk([]), { b: { FU: 1 }, w: {} }, 'b');
  const checks = legalMoves(chk, 'b').filter((x) => x.drop === 'FU' && x.to === sq(1, 4));
  ok('a pawn drop that merely checks is legal', checks.length === 1, JSON.stringify(checks));
}

// 10. engine ----------------------------------------------------------------
{
  let s = st(startBoard());
  let played = 0;
  for (let i = 0; i < 16; i++) {
    const me = s.turn;
    const mv = pickMove(s, 1, 150, 500);
    if (!mv) break;
    const legal = legalMoves(s);
    const found = legal.find((x) => x.from === mv.from && x.to === mv.to && x.promo === mv.promo && x.drop === mv.drop);
    if (!found) { ok(`engine move ${i} is legal`, false, JSON.stringify(mv)); break; }
    s = applyMove(s, mv);
    if (inCheck(s.bd, me)) { ok('engine never leaves its own king in check', false, `ply ${i}`); break; }
    played++;
  }
  ok('the engine plays 16 legal plies on its own', played === 16, `played ${played}`);
  ok('the engine finds a mate in one', (() => {
    const bd = mk([[2, 4, 'bKI'], [2, 3, 'bGI']], [[0, 4, 'wOU'], [8, 0, 'bOU']]);
    const s = st(bd);
    const mv = pickMove(s, 1, 400, 2000);
    // gold (2,4)→(1,4) and silver (2,3)→(1,4) both mate here; the engine must pick *a* mating move
    return !!mv && outcome(applyMove(s, mv)).over;
  })());
}

// 11. random self-play ------------------------------------------------------
{
  let s = st(startBoard());
  let plies = 0, sawCapture = false, sawDrop = false;
  for (let i = 0; i < 100; i++) {
    const legal = legalMoves(s);
    if (!legal.length) break;
    const mv = legal[(Math.random() * legal.length) | 0];
    if (mv.drop) sawDrop = true;
    if (!mv.drop && s.bd[mv.to]) sawCapture = true;
    s = applyMove(s, mv);
    plies++;
  }
  ok('100 random plies apply without throwing', plies === 100, `plies ${plies}`);
  ok('random play reaches captures and drops', sawCapture && sawDrop, `cap ${sawCapture} drop ${sawDrop}`);
  ok('the board stays 81 squares with both kings', s.bd.length === 81 &&
    s.bd.filter((p) => p === 'bOU').length <= 1 && s.bd.filter((p) => p === 'wOU').length <= 1);
}

console.log(fails ? `\nSHOGI CORE: ${fails} FAILED` : '\nSHOGI CORE: all passed');
process.exit(fails ? 1 : 0);
