#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped Matewave port and proves its content with the
// exact rules code the browser runs: every tactics line is legal and ends in mate (with a unique
// key), and every opening line replays legally from the start position, alternating sides.
//
// usage: node matewave-core-test.mjs [games/arcade/matewave/index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/matewave/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
// new Function evaluates the repo's own committed source block, never external input.
const core = new Function(m[1] +
  '\nreturn { parseFen, legalMoves, applyMove, inCheck, isMate, findMove, uciPair, sqName, PUZZLES, OPENINGS, START_FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" };')();
const { parseFen, legalMoves, applyMove, inCheck, isMate, findMove, uciPair, sqName, PUZZLES, OPENINGS, START_FEN } = core;

const checks = {};
const problems = [];

// ---- tactics -----------------------------------------------------------------
function walk(line, fen) {
  let st = parseFen(fen);
  const played = [];
  for (let k = 0; k < line.length; k++) {
    const [from, to] = uciPair(line[k]);
    const side = k % 2 === 0 ? 'w' : 'b';
    if (st.turn !== side) { problems.push(`line[${k}]: expects ${side} to move, position has ${st.turn}`); return null; }
    const mv = findMove(legalMoves(st, st.turn), from, to);
    if (!mv) { problems.push(`line[${k}] ${line[k]} is not legal`); return null; }
    st = applyMove(st, mv);
    played.push(line[k]);
  }
  return { st, played };
}

function matingMoves(st) {
  const out = [];
  for (const mv of legalMoves(st, 'w')) {
    if (isMate(applyMove(st, mv), 'b')) out.push(mv);
  }
  return out;
}

function forcedMateInTwo(st, mv) {
  const n = applyMove(st, mv);
  const replies = legalMoves(n, 'b');
  if (!replies.length) return false;
  for (const r of replies) {
    if (!matingMoves(applyMove(n, r)).length) return false;
  }
  return true;
}

const perPuzzle = [];
for (const p of PUZZLES) {
  const start = parseFen(p.fen);
  const entry = { slug: p.slug, mate: p.mate, ok: true };
  if (start.turn !== 'w') { problems.push(`${p.slug}: white is not to move`); entry.ok = false; }
  if (!legalMoves(start, 'w').length) { problems.push(`${p.slug}: white has no legal moves`); entry.ok = false; }

  const w = walk(p.line, p.fen);
  if (!w) { entry.ok = false; perPuzzle.push(entry); continue; }
  entry.line = w.played;
  entry.endsInMate = isMate(w.st, 'b');
  if (!entry.endsInMate) { problems.push(`${p.slug}: line does not end in mate`); entry.ok = false; }

  if (p.mate === 1) {
    const mates = matingMoves(start);
    entry.matingMoves = mates.map((mv) => sqName(mv.from) + sqName(mv.to));
    entry.uniqueKey = mates.length === 1;
    if (!entry.uniqueKey) problems.push(`${p.slug}: ${mates.length} mating moves, expected exactly 1 — ${entry.matingMoves.join(', ')}`);
    entry.keyMatches = mates.some((mv) => mv.from === uciPair(p.line[0])[0] && mv.to === uciPair(p.line[0])[1]);
    if (!entry.keyMatches) problems.push(`${p.slug}: stated key is not a mating move`);
  } else {
    const [f, t] = uciPair(p.line[0]);
    const key = findMove(legalMoves(start, 'w'), f, t);
    entry.forced = key ? forcedMateInTwo(start, key) : false;
    if (!entry.forced) problems.push(`${p.slug}: key move does not force mate in 2 against every reply`);
    const keys = legalMoves(start, 'w').filter((mv) => forcedMateInTwo(start, mv)).map((mv) => sqName(mv.from) + sqName(mv.to));
    entry.forcingMoves = keys;
    entry.uniqueKey = keys.length === 1;
    if (!entry.uniqueKey) problems.push(`${p.slug}: ${keys.length} forcing keys (${keys.join(', ')}) — puzzle is ambiguous`);
  }
  if (problems.some((x) => x.startsWith(p.slug))) entry.ok = false;
  perPuzzle.push(entry);
}

// ---- openings ----------------------------------------------------------------
const perOpening = [];
for (const op of OPENINGS) {
  const start = parseFen(START_FEN);
  const entry = { name: op.name, moves: op.line.length, ok: true };
  if (op.line.length % 2 === 0) {
    // Even length ends on black's reply; odd length ends on white's move. Both are fine —
    // the port simply completes when the line runs out.
  }
  const w = walk(op.line, START_FEN);
  if (!w) { entry.ok = false; problems.push(`${op.name}: line does not replay from the start`); perOpening.push(entry); continue; }
  entry.replayed = w.played;
  entry.whiteMoves = op.line.filter((_, i) => i % 2 === 0).length;
  if (!legalMoves(start, 'w').length) { entry.ok = false; problems.push(`${op.name}: start has no legal moves`); }
  if (new Set(op.line).size !== op.line.length) { entry.ok = false; problems.push(`${op.name}: duplicate move strings in the line`); }
  if (op.name === 'Ruy Lopez' && !op.line.includes('e1g1')) { entry.ok = false; problems.push(`${op.name}: expected a castling move in the book line`); }
  perOpening.push(entry);
}

// A castling line must actually be reachable through the shipped castle generator.
{
  const ruy = OPENINGS.find((o) => o.name === 'Ruy Lopez');
  let st = parseFen(START_FEN);
  let castleSeen = false;
  for (let k = 0; k < ruy.line.length; k++) {
    const [f, t] = uciPair(ruy.line[k]);
    const mv = findMove(legalMoves(st, st.turn), f, t);
    if (!mv) break;
    if (mv.flags.castle) castleSeen = true;
    st = applyMove(st, mv);
  }
  checks.castlingProven = castleSeen;
  if (!castleSeen) problems.push('Ruy Lopez: e1g1 never generated as a castle move');
}

// An empty board is neither mate nor legal-move-bearing: proves the sentinel logic.
checks.emptyBoard = {
  noMoves: legalMoves(parseFen('8/8/8/8/8/8/8/8 w - - 0 1'), 'w').length === 0,
  notMate: !isMate(parseFen('8/8/8/8/8/8/8/8 w - - 0 1'), 'w'),
};

checks.puzzles = perPuzzle;
checks.openings = perOpening;
checks.counts = { puzzles: PUZZLES.length, mateIn1: PUZZLES.filter((p) => p.mate === 1).length, openings: OPENINGS.length };
checks.allOk = problems.length === 0;
checks.problems = problems;

console.log(JSON.stringify(checks, null, 1));
console.log(problems.length ? 'CORE FAIL' : 'CORE PASS');
process.exit(problems.length ? 1 : 0);
