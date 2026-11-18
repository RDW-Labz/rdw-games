#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped chess-puzzles port and proves the puzzle set
// with the exact rules code the browser runs: every line is legal, every line ends in mate, and
// each stated key move is the only one that gets there.
//
// usage: node chess-puzzles-core-test.mjs [games/arcade/chess-puzzles/index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/chess-puzzles/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
// new Function evaluates the repo's own committed source block, never external input.
const core = new Function(m[1] + '\nreturn { parseFen, legalMoves, applyMove, inCheck, isMate, findMove, PUZZLES };')();
const { parseFen, legalMoves, applyMove, inCheck, isMate, findMove, PUZZLES } = core;

const sq = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
const checks = {};
const problems = [];

// Walk a puzzle's line turn by turn from the FEN, insisting each entry is legal.
function walk(p) {
  let st = parseFen(p.fen);
  const played = [];
  for (let k = 0; k < p.line.length; k++) {
    const [from, to] = p.line[k];
    const side = k % 2 === 0 ? 'w' : 'b';
    if (st.turn !== side) { problems.push(`${p.slug}: line[${k}] expects ${side} to move, position has ${st.turn}`); return null; }
    const mv = findMove(legalMoves(st, st.turn), from, to);
    if (!mv) { problems.push(`${p.slug}: line[${k}] ${sq(from)}-${sq(to)} is not legal`); return null; }
    st = applyMove(st, mv);
    played.push(sq(from) + sq(to));
  }
  return { st, played };
}

// Mate-in-1 key uniqueness: exactly one legal white move mates.
function matingMoves(st) {
  const out = [];
  for (const mv of legalMoves(st, 'w')) {
    const n = applyMove(st, mv);
    if (isMate(n, 'b')) out.push(mv);
  }
  return out;
}

// Mate-in-2: after the key move, EVERY black reply must have a mating answer.
function forcedMateInTwo(st, mv) {
  const n = applyMove(st, mv);
  const replies = legalMoves(n, 'b');
  if (!replies.length) return false;                     // that would be mate in 1
  if (inCheck(n, 'b') === false && replies.length === 0) return false;
  for (const r of replies) {
    const n2 = applyMove(n, r);
    if (!matingMoves(n2).length) return false;
  }
  return true;
}

const perPuzzle = [];
for (const p of PUZZLES) {
  const start = parseFen(p.fen);
  const entry = { slug: p.slug, mate: p.mate, ok: true };
  if (start.turn !== 'w') { problems.push(`${p.slug}: white is not to move`); entry.ok = false; }
  if (legalMoves(start, 'w').length === 0) { problems.push(`${p.slug}: white has no legal moves`); entry.ok = false; }
  if (inCheck(start, 'b') && start.turn === 'w') { problems.push(`${p.slug}: black is already in check with white to move`); entry.ok = false; }

  const w = walk(p);
  if (!w) { entry.ok = false; perPuzzle.push(entry); continue; }
  const { st, played } = w;
  entry.line = played;

  const mated = isMate(st, 'b');
  entry.endsInMate = mated;
  if (!mated) { problems.push(`${p.slug}: line does not end in mate (turn=${st.turn}, check=${inCheck(st, st.turn)})`); entry.ok = false; }

  if (p.mate === 1) {
    const mates = matingMoves(start);
    entry.matingMoves = mates.map((mv) => sq(mv.from) + sq(mv.to));
    entry.uniqueKey = mates.length === 1;
    if (!entry.uniqueKey) problems.push(`${p.slug}: ${mates.length} mating moves, expected exactly 1 — ${entry.matingMoves.join(', ')}`);
    const first = findMove(mates, p.line[0][0], p.line[0][1]);
    if (!first) { problems.push(`${p.slug}: stated key is not a mating move`); entry.ok = false; }
  } else {
    const key = findMove(legalMoves(start, 'w'), p.line[0][0], p.line[0][1]);
    entry.forced = key ? forcedMateInTwo(start, key) : false;
    if (!entry.forced) problems.push(`${p.slug}: key move does not force mate in 2 against every reply`);
    const keys = legalMoves(start, 'w').filter((mv) => forcedMateInTwo(start, mv)).map((mv) => sq(mv.from) + sq(mv.to));
    entry.forcingMoves = keys;
    entry.uniqueKey = keys.length === 1;
    if (!entry.uniqueKey) problems.push(`${p.slug}: ${keys.length} forcing keys (${keys.join(', ')}) — puzzle is ambiguous`);
  }
  if (problems.some((x) => x.startsWith(p.slug))) entry.ok = false;
  perPuzzle.push(entry);
}

checks.puzzles = perPuzzle;
checks.count = PUZZLES.length;
checks.mateIn1 = PUZZLES.filter((p) => p.mate === 1).length;
checks.allOk = problems.length === 0;
checks.problems = problems;

console.log(JSON.stringify(checks, null, 1));
console.log(problems.length ? 'CORE FAIL' : 'CORE PASS');
process.exit(problems.length ? 1 : 0);
