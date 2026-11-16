#!/usr/bin/env node
// Slices the // >>>CORE block out of the shipped gomoku.html and exercises the pure rules,
// so the tactics proven here are proven against the exact code the browser runs.
import { readFile } from 'node:fs/promises';

const html = await readFile(process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/gomoku.html', 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block'); process.exit(1); }
// new Function here evaluates the repo's own committed source block, never external input.
const core = new Function(m[1] + '\nreturn { coreWinLine, corePointScore, coreBestMove };')();
const { coreWinLine, coreBestMove } = core;

const N = 15;
const mk = () => new Int8Array(N * N);
const at = (i) => [Math.floor(i / N), i % N];
const put = (b, list, p) => { for (const [r, c] of list) b[r * N + c] = p; return b; };

const checks = {};
// 1) five detection in every axis, and an overline still counts
{
  const b = mk(); put(b, [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]], 1);
  const h = coreWinLine(b, N, 7, 5, 1);
  const b2 = mk(); put(b2, [[2, 8], [3, 8], [4, 8], [5, 8], [6, 8]], 2);
  const v = coreWinLine(b2, N, 4, 8, 2);
  const b3 = mk(); put(b3, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]], 1);
  const d = coreWinLine(b3, N, 3, 3, 1);
  const b4 = mk(); put(b4, [[9, 4], [8, 5], [7, 6], [6, 7], [5, 8]], 1);
  const ad = coreWinLine(b4, N, 7, 6, 1);
  const b5 = mk(); put(b5, [[10, 2], [10, 3], [10, 4], [10, 5], [10, 6], [10, 7]], 1);
  const over = coreWinLine(b5, N, 10, 4, 1);
  const b6 = mk(); put(b6, [[10, 2], [10, 3], [10, 4], [10, 6], [10, 7]], 1);
  const gap = coreWinLine(b6, N, 10, 4, 1);
  checks.winLine = !!h && !!v && !!d && !!ad && !!over && gap === null && h.length >= 5;
  checks.winLineDetail = { h: h && h.length, v: v && v.length, d: d && d.length, ad: ad && ad.length, over: over && over.length, gap };
}

// 2) the machine takes the win in front of it instead of blocking
{
  const b = mk();
  put(b, [[7, 3], [7, 4], [7, 5], [7, 6]], 2);       // white (AI) has four
  put(b, [[1, 1], [1, 2], [1, 3], [1, 4]], 1);       // black has four too
  const mv = coreBestMove(b, N, 2, () => 0.5);
  const [r, c] = at(mv);
  const ok = (r === 7 && (c === 2 || c === 7));
  checks.takesWin = ok;
  checks.takesWinDetail = { mv, r, c };
}

// 3) with no win available it blocks the human's four
{
  const b = mk();
  put(b, [[5, 2], [5, 3], [5, 4], [5, 5]], 1);       // black four, white to move
  put(b, [[12, 12]], 2);
  const mv = coreBestMove(b, N, 2, () => 0.5);
  const [r, c] = at(mv);
  checks.blocksFour = r === 5 && (c === 1 || c === 6);
  checks.blocksFourDetail = { mv, r, c };
}

// 4) a lone first stone gets a neighbouring answer, not a random far cell
{
  const b = mk();
  b[7 * N + 7] = 1;
  const mv = coreBestMove(b, N, 2, () => 0.5);
  const [r, c] = at(mv);
  checks.repliesNear = Math.abs(r - 7) <= 2 && Math.abs(c - 7) <= 2;
  checks.repliesNearDetail = { mv, r, c };
}

// 5) an empty board never hands back -1
{
  const mv = coreBestMove(mk(), N, 1, () => 0.5);
  checks.emptyBoardMove = mv >= 0 && mv < N * N;
}

console.log(JSON.stringify(checks, null, 1));
const pass = Object.entries(checks).every(([k, v]) => k.endsWith('Detail') || v === true);
console.log(pass ? 'CORE PASS' : 'CORE FAIL');
process.exit(pass ? 0 : 1);
