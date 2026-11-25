#!/usr/bin/env node
// Core test for the Freebloks (Blokus) port: slices the page's // >>>CORE block and proves the
// rules the browser runs — 21 free polyominoes, the corner/edge contact law, first-piece start
// rule, scoring bonuses, and that full AI self-play games stay legal and terminate.
// usage: node scripts/freebloks-core-test.mjs [portHtml]
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/freebloks/index.html';
const html = readFileSync(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no >>>CORE block in ' + FILE); process.exit(2); }

const api = new Function(m[1] + `
  return { PIECES, ORI, PIECE_SIZE, PIECE_COUNT, CELLS_PER_PLAYER, MODES, newGame, fits, whyNot,
           legalMoves, hasMove, commit, passTurn, advance, endGame, scoreOf, bestMove, scoreMove,
           cornersAfter, denialAfter, canonKey, norm, orientations, freePolyominoes, sig };
`)();

let fails = 0, checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else console.log('ok    ' + label);
  return cond;
};

// ---- 1) the piece set --------------------------------------------------------------
const P = api.PIECES;
ok(P.length === 21, 'generates 21 free polyominoes', P.length);
const bySize = {};
for (const c of P) bySize[c.length] = (bySize[c.length] || 0) + 1;
ok(bySize[1] === 1 && bySize[2] === 1 && bySize[3] === 2 && bySize[4] === 5 && bySize[5] === 12,
  'size histogram is 1/1/2/5/12', bySize);
ok(P.reduce((n, c) => n + c.length, 0) === 89, '89 cells per player', P.reduce((n, c) => n + c.length, 0));
ok(new Set(P.map((c) => api.canonKey(c))).size === 21, 'no duplicate shapes');
ok(P.every((c) => c.every(([x, y]) => x >= 0 && y >= 0)), 'every shape is normalised at the origin');
// every shape is edge-connected
ok(P.every((cells) => {
  const s = new Set(cells.map(([x, y]) => x + ',' + y));
  const seen = new Set(['0,0']);
  // walk from the cell closest to the origin along edge neighbours
  const start = cells.map(([x, y]) => x + ',' + y).sort()[0];
  const st = [cells.find(([x, y]) => x + ',' + y === start)];
  seen.clear(); seen.add(start);
  while (st.length) {
    const [x, y] = st.pop();
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (x + ox) + ',' + (y + oy);
      if (s.has(k) && !seen.has(k)) { seen.add(k); st.push([x + ox, y + oy]); }
    }
  }
  return seen.size === cells.length;
}), 'every shape is edge-connected');
ok(api.ORI.length === 21 && api.ORI.every((o) => o.length >= 1 && o.length <= 8), 'orientation counts within 1..8');
const oriCounts = api.ORI.map((o) => o.length).sort((a, b) => a - b);
ok(oriCounts[oriCounts.length - 1] === 8, 'some piece has all 8 orientations', oriCounts);
// the straight pentomino has exactly 2 orientations, the square tetromino exactly 1
const straight5 = P.find((c) => c.length === 5 && (Math.max(...c.map((v) => v[0])) === 4 || Math.max(...c.map((v) => v[1])) === 4));
const sq4 = P.find((c) => c.length === 4 && new Set(c.map((v) => v[0])).size === 2 && new Set(c.map((v) => v[1])).size === 2);
ok(api.ORI[P.indexOf(straight5)].length === 2, 'the I-pentomino has 2 orientations', api.ORI[P.indexOf(straight5)].length);
ok(api.ORI[P.indexOf(sq4)].length === 1, 'the 2x2 square has 1 orientation', api.ORI[P.indexOf(sq4)].length);

// ---- 2) legality -------------------------------------------------------------------
const S = api.newGame('duo');
const [sx, sy] = S.starts[0];
const mono = api.ORI[20][0];
ok(api.fits(S, mono, sx, sy, 0) === true, 'first monomino on the start square is legal');
ok(api.fits(S, mono, sx + 3, sy + 3, 0) === false, 'first piece away from the start square is illegal');
// place a straight triomino at the start, then probe corner / edge contact
const straightTri = api.PIECES.findIndex((c) => c.length === 3 && new Set(c.map((v) => v[1])).size === 1);
const L = api.ORI[straightTri][0];
const placed = api.commit(S, 0, { piece: straightTri, ori: 0, x: sx, y: sy });
ok(!!placed, 'commit accepts a legal first piece');
ok(S.board[sy * S.W + sx] === 1 && S.turn === 1, 'board written and turn advanced', { v: S.board[sy * S.W + sx], turn: S.turn });
const cells0 = L.map(([dx, dy]) => [sx + dx, sy + dy]);
// edge-adjacent to the placed tiles -> illegal
const edgeCell = [cells0[0][0], cells0[0][1] + 1];
ok(api.fits(S, mono, edgeCell[0], edgeCell[1], 0) === false, 'own edge contact is illegal');
ok(api.whyNot(S, mono, edgeCell[0], edgeCell[1], 0).includes('edge'), 'edge refusal explains itself');
// corner-adjacent -> legal
const cornerCell = [cells0[cells0.length - 1][0] + 1, cells0[cells0.length - 1][1] + 1];
ok(api.fits(S, mono, cornerCell[0], cornerCell[1], 0) === true, 'own corner touch is legal');
// diagonally adjacent but two squares away from any own tile -> illegal (only corner counts)
const far = [sx + 3, sy + 3];
ok(api.fits(S, mono, far[0], far[1], 0) === false, 'a lone square with no contact is illegal');
// opponent edge contact is allowed; opponent start squares are not, until they open
ok(api.fits(S, mono, S.starts[1][0], S.starts[1][1], 1) === true, 'player 2 may open on its own start square');
ok(api.fits(S, mono, S.starts[1][0], S.starts[1][1], 0) === false, 'a seat cannot cover the opponent\'s unclaimed start square');
ok(api.whyNot(S, mono, S.starts[1][0], S.starts[1][1], 0).includes('opponent'), 'the start-square refusal explains itself');
{
  // once the opponent has opened, that square is just a square
  const W = api.newGame('duo');
  const p1 = api.ORI[20][0];
  api.commit(W, 0, { piece: 20, ori: 0, x: W.starts[0][0], y: W.starts[0][1] });
  api.commit(W, 1, { piece: 20, ori: 0, x: W.starts[1][0], y: W.starts[1][1] });
  ok(W.placed[1].length === 1, 'the cpu opened on its marker', W.placed[1].length);
}
// off-board and occupied squares
ok(api.fits(S, mono, -1, 0, 1) === false, 'off-board placements are refused');
ok(api.whyNot(S, mono, -1, 0, 1) === 'off the board', 'off-board refusal explains itself');
ok(api.fits(S, mono, sx, sy, 0) === false, 'an occupied square is refused');

// ---- 3) scoring ---------------------------------------------------------------------
const T = api.newGame('duo');
T.placed[0] = [0, 1, 2];        // three pentominoes = 15 cells
ok(api.scoreOf(T, 0) === 15, 'area scoring counts cells', api.scoreOf(T, 0));
T.placed[0] = [...Array(21).keys()];
ok(api.scoreOf(T, 0) === 89 + 15, 'all 21 pieces earns the +15 bonus', api.scoreOf(T, 0));
T.monoLast[0] = true;
ok(api.scoreOf(T, 0) === 89 + 15 + 5, 'monomino played last earns +5', api.scoreOf(T, 0));

// ---- 4) endGame verdicts -----------------------------------------------------------
function verdict(p0, p1) {
  const X = api.newGame('duo');
  X.placed[0] = new Array(p0).fill(0);
  X.placed[1] = new Array(p1).fill(0);
  api.endGame(X);
  return X.result;
}
ok(verdict(5, 3) === 'win', 'more area than the cpu is a win', verdict(5, 3));
ok(verdict(3, 5) === 'lose', 'less area than the cpu is a loss', verdict(3, 5));
ok(verdict(4, 4) === 'draw', 'equal area is a draw', verdict(4, 4));

// ---- 5) self-play: every move legal, games terminate -------------------------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function selfPlay(mode, style, seed, maxMoves = 400) {
  const G = api.newGame(mode);
  const r = rng(seed);
  let n = 0, illegal = 0;
  while (!G.over && n < maxMoves) {
    const side = G.turn;
    const mv = api.bestMove(G, side, style, r);
    if (!mv) { // no move: the engine must have already skipped it
      illegal++;
      break;
    }
    const before = G.board.slice();
    const cells = api.ORI[mv.piece][mv.ori];
    // re-verify independently: all cells in bounds + empty
    for (const [dx, dy] of cells) {
      const x = mv.x + dx, y = mv.y + dy;
      if (x < 0 || y < 0 || x >= G.W || y >= G.H || before[y * G.W + x] !== 0) { illegal++; break; }
    }
    if (!api.fits(G, cells, mv.x, mv.y, side)) illegal++;
    const got = api.commit(G, side, mv);
    if (!got) illegal++;
    n++;
  }
  return { G, n, illegal };
}

let totalIllegal = 0, totalGames = 0;
for (const mode of ['duo', 'classic']) {
  for (const style of ['steady', 'sharp']) {
    for (const seed of [1, 7, 42]) {
      const { G, n, illegal } = selfPlay(mode, style, seed);
      totalGames++; totalIllegal += illegal;
      const cells = G.placed.reduce((acc, list) => acc + list.length, 0);
      if (illegal || !G.over || cells < 4) {
        console.log('FAIL  self-play ' + mode + '/' + style + '/seed' + seed,
          JSON.stringify({ illegal, n, over: G.over, pieces: cells, result: G.result }));
        fails++; checks++;
      }
      if (seed === 42) console.log('      ' + mode + '/' + style + ': ' + n + ' moves, result ' + G.result +
        ', final ' + JSON.stringify(G.final) + ', pieces ' + JSON.stringify(G.placed.map((a) => a.length)));
    }
  }
}
ok(totalIllegal === 0, 'no illegal move in ' + totalGames + ' self-play games', totalIllegal);
ok(totalGames === 12, 'played 12 self-play games', totalGames);

// a full Duo game has to place a decent number of pieces, or the AI is broken
const sample = selfPlay('duo', 'steady', 42);
ok(sample.G.over, 'the Duo self-play game reaches a terminal state', sample.G.over);
ok(sample.G.placed[0].length >= 8 && sample.G.placed[1].length >= 8,
  'both seats place at least 8 pieces', sample.G.placed.map((a) => a.length));
ok(['win', 'lose', 'draw'].includes(sample.G.result), 'the terminal result is one of win/lose/draw', sample.G.result);
ok(sample.G.final[0] > 0 && sample.G.final[1] > 0, 'both final scores are positive', sample.G.final);

// per-player accounting: no player can place more than 89 cells (+15 / +5 bonuses)
for (const mode of ['duo', 'classic']) {
  const { G } = selfPlay(mode, 'sharp', 99);
  ok(G.final.every((v) => v <= 89 + 20), mode + ': no final score exceeds the 89-cell ceiling + bonuses', G.final);
  ok(G.placed.every((a) => a.length <= 21), mode + ': no seat plays more than 21 pieces', G.placed.map((a) => a.length));
}

// ---- 6) AI never returns an illegal or out-of-turn move ----------------------------
{
  const G = api.newGame('duo');
  const r = rng(5);
  let bad = 0, probes = 0;
  for (let i = 0; i < 40 && !G.over; i++) {
    const side = G.turn;
    const mv = api.bestMove(G, side, 'sharp', r);
    if (mv) {
      probes++;
      if (!api.fits(G, api.ORI[mv.piece][mv.ori], mv.x, mv.y, side)) bad++;
      api.commit(G, side, mv);
    } else api.passTurn(G, side);
  }
  ok(bad === 0, 'every sharp AI move passed an independent legality check (' + probes + ' probes)', bad);
}

// ---- 7) the modes the page ships --------------------------------------------------
ok(api.MODES.duo.W === 14 && api.MODES.duo.players === 2, 'Duo is 14x14 with two seats');
ok(api.MODES.classic.W === 20 && api.MODES.classic.players === 4, 'Classic is 20x20 with four seats');
ok(api.MODES.classic.starts.length === 4 && new Set(api.MODES.classic.starts.map((p) => p.join(','))).size === 4,
  'the four Classic start squares are distinct');
ok(api.MODES.duo.starts.every(([x, y]) => x >= 0 && y >= 0 && x < 14 && y < 14), 'Duo start squares are on the board');

// ---- 8) a fresh game is not terminal ----------------------------------------------
const fresh = api.newGame('duo');
ok(fresh.over === false && fresh.result === null, 'a new game is not over');
ok(api.hasMove(fresh, 0) && api.hasMove(fresh, 1), 'both seats can open');

console.log('\n' + (fails ? 'FAILED ' + fails + ' of ' + checks : 'PASS ' + checks + ' checks'));
process.exit(fails ? 1 : 0);
