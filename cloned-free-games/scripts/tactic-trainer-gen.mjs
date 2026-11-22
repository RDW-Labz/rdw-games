#!/usr/bin/env node
// Build the Tactic Trainer puzzle set. Generates mate-in-1 and mate-in-2 positions from
// random legal layouts and keeps only ones the rules prove: a unique mating move for the
// one-movers, and a key whose every black reply has a mating answer for the two-movers.
// The lines it prints are [from,to] square indices, spoken by the same legalMoves() the
// page runs. Output: JSON on stdout (paste into the port's CORE block).
import { readFile } from 'node:fs/promises';

const PORT = '/home/cluer/kaos/work/site/games/arcade/chess-puzzles/index.html';
const src = await readFile(PORT, 'utf8');
const core = src.slice(src.indexOf('// >>>CORE'), src.indexOf('// <<<CORE'));
// eval the proven rules without the puzzle table that follows them
const rules = core.slice(0, core.indexOf('// Puzzle set'));
const api = new Function(rules + '\nreturn {parseFen, legalMoves, applyMove, isMate, inCheck, findKing, attacked, rc, idx2, opp};')();

const { parseFen, legalMoves, applyMove, isMate, inCheck, rc } = api;

let seed = 20261121;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);
const sqName = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));

function toFen(b, turn = 'w') {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let s = '', run = 0;
    for (let c = 0; c < 8; c++) {
      const p = b[r * 8 + c];
      if (!p) { run++; continue; }
      if (run) { s += run; run = 0; }
      s += p.c === 'w' ? p.t.toUpperCase() : p.t;
    }
    if (run) s += run;
    rows.push(s);
  }
  return rows.join('/') + ' ' + turn + ' - - 0 1';
}

const okKingGap = (a, b) => Math.max(Math.abs(rc(a)[0] - rc(b)[0]), Math.abs(rc(a)[1] - rc(b)[1])) > 1;

function build(pieces) {
  const b = new Array(64).fill(null);
  for (const [t, c] of pieces) {
    let i, guard = 0;
    do { i = ri(64); guard++; } while (b[i] && guard < 200);
    if (b[i]) return null;
    b[i] = { t, c };
  }
  return b;
}

function mateIn1Count(b) {
  const st = { b, turn: 'w', ep: -1, rights: { wK: false, wQ: false, bK: false, bQ: false } };
  const moves = legalMoves(st, 'w');
  const mates = moves.filter((m) => isMate(applyMove(st, m), 'b'));
  return { st, moves, mates };
}

function matesNowOne(b) {
  const st = { b, turn: 'w', ep: -1, rights: { wK: false, wQ: false, bK: false, bQ: false } };
  return legalMoves(st, 'w').some((m) => isMate(applyMove(st, m), 'b'));
}

function mateIn2Keys(b) {
  const st = { b, turn: 'w', ep: -1, rights: { wK: false, wQ: false, bK: false, bQ: false } };
  const keys = [];
  for (const k of legalMoves(st, 'w')) {
    const after = applyMove(st, k);
    if (isMate(after, 'b')) continue;              // that is a mate-in-1, not a two-mover
    const replies = legalMoves(after, 'b');
    if (!replies.length) continue;
    let forced = true, last = null;
    for (const rep of replies) {
      const a2 = applyMove(after, rep);
      const answers = legalMoves(a2, 'w').filter((m) => isMate(applyMove(a2, m), 'b'));
      if (answers.length !== 1) { forced = false; break; }
      last = { rep, answer: answers[0] };
    }
    if (forced) keys.push({ key: k, sample: last });
  }
  return { st, keys };
}

const themeOf = (b, st, mv) => {
  const p = b[mv.from];
  const target = b[mv.to];
  const [fr, fc] = rc(mv.from), [tr, tc] = rc(mv.to);
  if (p.t === 'n') return 'knight strike';
  if (target && p.t !== 'p') {
    const after = applyMove(st, mv);
    // still attacked on its new square yet the mate holds -> a sacrifice
    const guarded = Object.keys(after.b).length && after.b.some((q, i) => q && q.c !== p.c && i === mv.to);
    return 'win the warden';
  }
  if (p.t === 'p') return tr <= 1 ? 'pawn promotion' : 'pawn push';
  if (p.t === 'r' && (tr === 0 || tr === 7)) return 'back rank';
  if (p.t === 'q') return 'queen strike';
  if (p.t === 'b') return 'bishop line';
  return 'mate';
};

const out = [];
const seen = new Set();

// ---- mate in one: white K + two heavy/light pieces vs a lone black king + up to 2 blockers
const HEAVY = [['q', 'r'], ['r', 'r'], ['q', 'n'], ['q', 'b'], ['r', 'b'], ['r', 'n'], ['q', 'b'], ['r', 'r']];
let tries = 0;
while (out.filter((o) => o.mate === 1).length < 9 && tries < 400000) {
  tries++;
  const mat = HEAVY[ri(HEAVY.length)];
  const blockers = ri(3);            // black pawns/knights as box material
  const pieces = [['k', 'w'], ['k', 'b'], ...mat.map((t) => [t, 'w'])];
  for (let i = 0; i < blockers; i++) pieces.push([['p', 'n', 'b'][ri(3)], 'b']);
  const b = build(pieces);
  if (!b) continue;
  let wk = -1, bk = -1;
  for (let i = 0; i < 64; i++) if (b[i] && b[i].t === 'k') { if (b[i].c === 'w') wk = i; else bk = i; }
  if (wk < 0 || bk < 0 || !okKingGap(wk, bk)) continue;
  const st = { b, turn: 'w', ep: -1, rights: { wK: false, wQ: false, bK: false, bQ: false } };
  if (inCheck(st, 'b')) continue;                       // start quiet
  const all = legalMoves(st, 'w');
  if (all.length < 9) continue;                         // a real choice, not a forced march
  const { mates } = mateIn1Count(b);
  if (mates.length !== 1) continue;
  const mv = mates[0];
  const fen = toFen(b);
  if (seen.has(fen)) continue;
  seen.add(fen);
  const after = applyMove(st, mv);
  if (!isMate(after, 'b')) continue;
  out.push({ mate: 1, fen, line: [[mv.from, mv.to]], theme: themeOf(b, st, mv), key: sqName(mv.from) + sqName(mv.to) });
}

// ---- mate in two: K + Q/R + a helper vs K + two defenders, key must force mate
const TWO_MAT = [['q', 'r'], ['q', 'b'], ['r', 'r'], ['q', 'n'], ['r', 'n'], ['r', 'b']];
tries = 0;
while (out.filter((o) => o.mate === 2).length < 7 && tries < 400000) {
  tries++;
  const mat = TWO_MAT[ri(TWO_MAT.length)];
  const pieces = [['k', 'w'], ['k', 'b'], ...mat.map((t) => [t, 'w']), ['p', 'b'], ['p', 'b']];
  const b = build(pieces);
  if (!b) continue;
  let wk = -1, bk = -1;
  for (let i = 0; i < 64; i++) if (b[i] && b[i].t === 'k') { if (b[i].c === 'w') wk = i; else bk = i; }
  if (wk < 0 || bk < 0 || !okKingGap(wk, bk)) continue;
  const st = { b, turn: 'w', ep: -1, rights: { wK: false, wQ: false, bK: false, bQ: false } };
  if (inCheck(st, 'b') || inCheck(st, 'w')) continue;
  if (matesNowOne(b)) continue;                         // no shortcut: this must not be a mate-in-1
  const { keys } = mateIn2Keys(b);
  if (keys.length !== 1) continue;                      // force a unique key, like a real puzzle
  const k = keys[0];
  const fen = toFen(b);
  if (seen.has(fen)) continue;
  seen.add(fen);
  const line = [[k.key.from, k.key.to], [k.sample.rep.from, k.sample.rep.to], [k.sample.answer.from, k.sample.answer.to]];
  out.push({ mate: 2, fen, line, theme: themeOf(b, st, k.key), key: sqName(k.key.from) + sqName(k.key.to), replies: legalMoves(applyMove(st, k.key), 'b').length });
}

out.sort((a, b) => a.mate - b.mate);
console.error(`generated ${out.length} puzzles in ${tries} tries`);
console.log(JSON.stringify(out, null, 1));
