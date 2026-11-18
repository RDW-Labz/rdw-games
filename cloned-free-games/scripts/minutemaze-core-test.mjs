#!/usr/bin/env node
// Proves the Minute Maze port's shipped levels with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/minute-maze/index.html.
// Per level: the carved maze is a perfect maze (every cell reachable, so a solution always
// exists), the stored solution is legal move-by-move through canMove() and ends on the goal,
// the goal is the farthest cell, and the time/score rewards are positive.
//
// usage: node minutemaze-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/minute-maze/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { LEVELS, BUDGET_MS, levelSpec, carveMaze, canMove, stepOnce, bfsPath, farthest, bonusSec, clearPoints };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LEVELS, BUDGET_MS, levelSpec, carveMaze, canMove, stepOnce, bfsPath, farthest, bonusSec, clearPoints } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

ok(BUDGET_MS >= 30000, 'time budget too small to play', BUDGET_MS);

const lens = [];
for (let level = 1; level <= LEVELS.length; level++) {
  const spec = levelSpec(level);
  const maze = carveMaze(spec.cols, spec.rows, spec.seed);
  const cells = maze.cols * maze.rows;
  console.log(`level ${level}: ${maze.cols}x${maze.rows} (${cells} cells) goal=${maze.goal} path=${maze.solution.length}`);

  ok(maze.cols === spec.cols && maze.rows === spec.rows, 'level size drifted from its spec');
  ok(maze.n[0].every((w) => w === true), 'north border has a hole');
  ok(maze.e.every((row) => row[row.length - 1] === true), 'east border has a hole');
  ok(!(maze.goal[0] === maze.start[0] && maze.goal[1] === maze.start[1]), 'goal sits on the start cell');

  // the solution must be legal, move by move, through the same canMove() the page uses
  let pos = maze.start.slice();
  let legal = true;
  for (const d of maze.solution) {
    const s = stepOnce(maze, pos, d);
    if (!s.ok) { legal = false; break; }
    pos = s.pos;
  }
  ok(legal, 'stored solution makes an illegal move');
  ok(pos[0] === maze.goal[0] && pos[1] === maze.goal[1], 'solution does not end on the goal', { pos, goal: maze.goal });
  ok(maze.solution.length > 0, 'solution is empty (the maze is a win on arrival)');

  // perfect maze: every cell reachable from the start, so no board can be unwinnable
  const seen = new Set([`${maze.start[0]},${maze.start[1]}`]);
  const q = [maze.start];
  while (q.length) {
    const [c, r] = q.shift();
    for (const d of ['up', 'down', 'left', 'right']) {
      const s = stepOnce(maze, [c, r], d);
      if (!s.ok) continue;
      const k = `${s.pos[0]},${s.pos[1]}`;
      if (seen.has(k)) continue;
      seen.add(k); q.push(s.pos);
    }
  }
  ok(seen.size === cells, 'unreachable cells — the maze is not fully carved', { reachable: seen.size, cells });

  // the goal must be the far corner of the maze, or a level is a walk in the park
  const far = farthest(maze, maze.start);
  ok(far.d === maze.solution.length, 'goal is not the farthest cell', { far: far.d, solution: maze.solution.length });
  ok(bfsPath(maze, maze.start, maze.goal).length === maze.solution.length, 'bfsPath disagrees with the stored solution');
  ok(bfsPath(maze, maze.goal, maze.start).length === maze.solution.length, 'the maze is not symmetric under BFS');

  ok(bonusSec(level) >= 5, 'time bonus for a clear is too small', bonusSec(level));
  ok(clearPoints(maze.solution.length, maze.solution.length) >= 20, 'a perfect clear scores nothing', clearPoints(maze.solution.length, maze.solution.length));
  ok(clearPoints(20, 60) > 0, 'a slow clear scores zero');

  lens.push(maze.solution.length);
}

// difficulty must actually ramp: a late maze must not be shorter than an early one by much
const early = lens.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
const late = lens.slice(-3).reduce((a, b) => a + b, 0) / 3;
console.log(`mean path length: early ${early.toFixed(1)} -> late ${late.toFixed(1)}`);
ok(late > early, 'mazes do not get longer as levels rise', { early, late });
ok(lens.every((n) => n > 3), 'a level can be solved in a couple of steps');

// carving must be deterministic: the same level twice gives the same board (the gate relies on it)
const a1 = carveMaze(levelSpec(4).cols, levelSpec(4).rows, levelSpec(4).seed);
const a2 = carveMaze(levelSpec(4).cols, levelSpec(4).rows, levelSpec(4).seed);
ok(JSON.stringify([a1.n, a1.e]) === JSON.stringify([a2.n, a2.e]), 'carving is not deterministic for a level');

console.log(fails ? `CORE FAILED (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
