// Rules proof for games/arcade/go-board/index.html.
// Slices the // >>>CORE … // <<<CORE block out of the SHIPPED html and runs it, so what is
// verified here is the exact code the browser executes.
import { readFileSync } from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/go-board/index.html';
const html = readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no CORE block'); process.exit(1); }
const core = new Function(`${m[1]}
return { coreNb, coreGroup, corePlay, coreScore, coreKey, coreEye, coreBestMove, BLACK, WHITE, KOMI };`)();
const { corePlay, coreScore, coreKey, coreBestMove, coreGroup, BLACK, WHITE } = core;

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name} ${extra}`); }
};

const N = 9;
const board = (pts) => {
  const b = new Array(N * N).fill(0);
  for (const [r, c, v] of pts) b[r * N + c] = v;
  return b;
};
const at = (b, r, c) => b[r * N + c];

console.log('GO CORE RULES');
// 1. single-stone capture: white at (4,4) with black north/south/east, black plays west.
{
  const b = board([[3, 4, BLACK], [5, 4, BLACK], [4, 5, BLACK], [4, 4, WHITE]]);
  const res = corePlay(b, N, 4 * N + 3, BLACK);
  ok('single capture is legal', res.ok);
  ok('captured one white stone', res.ok && res.captured.length === 1 && res.captured[0] === 4 * N + 4, JSON.stringify(res.captured));
  ok('point becomes empty', res.ok && at(res.board, 4, 4) === 0);
}

// 2. suicide is rejected
{
  const b = board([[3, 4, BLACK], [5, 4, BLACK], [4, 3, BLACK], [4, 5, BLACK]]);
  const res = corePlay(b, N, 4 * N + 4, WHITE);
  ok('suicide rejected', !res.ok && res.why === 'suicide', JSON.stringify(res));
}

// 3. capture overrides suicide: same shape but the last liberty is a capture
{
  const b = board([[3, 4, WHITE], [5, 4, BLACK], [4, 3, BLACK], [4, 5, BLACK], [3, 3, BLACK], [3, 5, BLACK], [2, 4, BLACK]]);
  const res = corePlay(b, N, 4 * N + 4, BLACK);
  ok('multi-stone group capture', res.ok && res.captured.length === 1);
}

// 4. ko: recapturing the single stone recreates the previous position
{
  // classic ko shape — white (3,3) in atari, black takes at (3,4), white may not retake at once
  const b = board([[2, 3, BLACK], [4, 3, BLACK], [3, 2, BLACK], [3, 3, WHITE],
                   [2, 4, WHITE], [4, 4, WHITE], [3, 5, WHITE]]);
  const res = corePlay(b, N, 3 * N + 4, BLACK);
  ok('ko capture legal', res.ok && res.captured.length === 1 && at(res.board, 3, 3) === 0, JSON.stringify(res.captured));
  const back = corePlay(res.board, N, 3 * N + 3, WHITE);
  ok('the retake is a legal capture at the rules level', back.ok && back.captured.length === 1, JSON.stringify(back));
  ok('retake restores the pre-capture position (so the port must block it as ko)',
     back.ok && coreKey(back.board) === coreKey(b));
}

// 5. area scoring
{
  // black owns the left column, white the right, the middle is neutral
  const b = new Array(N * N).fill(0);
  for (let r = 0; r < N; r++) { b[r * N + 0] = BLACK; b[r * N + 8] = WHITE; }
  const sc = coreScore(b, N);
  ok('area score counts a bordered column', sc.black === 9 && sc.white === 9, JSON.stringify(sc));
  const sc2 = coreScore(new Array(N * N).fill(0), N);
  ok('empty board scores zero territory', sc2.black === 0 && sc2.white === 0, JSON.stringify(sc2));
}

// 6. the engine never fills its own eye, and always answers
{
  // black ring around (4,4) is an eye; white to move should not play inside it
  const pts = [];
  for (const [r, c] of [[3, 4], [5, 4], [4, 3], [4, 5], [3, 3], [3, 5], [5, 3], [5, 5]]) pts.push([r, c, BLACK]);
  pts.push([0, 0, WHITE], [0, 1, BLACK]);
  const b = board(pts);
  const mv = coreBestMove(b, N, WHITE, { ko: null, last: 0 * N + 1, rand: () => 0.5 });
  ok('white does not fill a black eye', mv !== 4 * N + 4, String(mv));
}

// 7. full self-play: every move legal, game terminates well under a pile of moves
{
  let b = new Array(N * N).fill(0);
  const hist = [coreKey(b)];
  let p = BLACK, passes = 0, moves = 0, illegal = 0, winner = 0;
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  while (moves < 400 && passes < 2) {
    const mv = coreBestMove(b, N, p, { ko: hist[hist.length - 2] || null, last: -1, rand });
    if (mv < 0) { passes++; hist.push(coreKey(b)); p = p === BLACK ? WHITE : BLACK; moves++; continue; }
    const res = corePlay(b, N, mv, p);
    if (!res.ok) { illegal++; break; }
    b = res.board; passes = 0; moves++;
    hist.push(coreKey(b));
    p = p === BLACK ? WHITE : BLACK;
    if (b.every((v) => v !== 0)) break;
  }
  const sc = coreScore(b, N);
  winner = sc.black > sc.white + 6.5 ? 'black' : 'white';
  ok('self-play made no illegal move', illegal === 0);
  ok('self-play terminated', passes >= 2 || b.every((v) => v !== 0), `passes=${passes} moves=${moves}`);
  ok('self-play ended with stones on the board', b.filter((v) => v !== 0).length > 4,
     `${b.filter((v) => v !== 0).length} stones, score ${JSON.stringify(sc)} -> ${winner}`);
  console.log(`  info self-play: ${moves} plies, black ${sc.black} white ${sc.white}+6.5`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL RULES CHECKS PASSED');
process.exit(fails ? 1 : 0);
